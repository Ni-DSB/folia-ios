// electron/customSource/store.cjs
// Where installed custom sources live between runs: one JSON file under userData holding, per
// source, its metadata, its script text and the listener's variables.
//
// The script is stored deflated and base64-encoded, as lx-music does (`gz_` + base64). A plugin is
// tens of kilobytes of source and the settings file is read on every start; compressing it keeps
// the file small and makes an accidental look at it unreadable rather than merely unhelpful.
//
// Writes are serialized through one queue. Two writes overlapping (an import landing while the
// listener flips another source's switch) would otherwise interleave their read-modify-write and
// lose one of them.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const deflate = promisify(zlib.deflate);
const inflate = promisify(zlib.inflate);

const STORE_FILE = 'custom-sources.json';
const FORMAT_VERSION = 1;
const GZ_PREFIX = 'gz_';

/*
 * The shape written to disk, per source:
 *   { id, platform, version, author, description, homepage, script, enabled,
 *     userVariableValues, addedAt, updatedAt }
 * `script` is `gz_<base64>` or, for a source added before this format, the plain text.
 */

const encodeScript = async (text) => GZ_PREFIX + (await deflate(Buffer.from(text, 'utf8'))).toString('base64');

const decodeScript = async (stored) => {
    if (typeof stored !== 'string') return null;
    if (!stored.startsWith(GZ_PREFIX)) return stored;
    try {
        return (await inflate(Buffer.from(stored.slice(GZ_PREFIX.length), 'base64'))).toString('utf8');
    } catch {
        return null;
    }
};

/** A source id: short, path-safe, and stable for the life of the install. */
const createSourceId = () => `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const emptyFile = () => ({ version: FORMAT_VERSION, sources: [] });

const createCustomSourceStore = ({ userDataDir }) => {
    const filePath = () => path.join(userDataDir, STORE_FILE);

    // One promise chain per store instance. A failed write must not poison it, so the chain is
    // re-seeded after each failure.
    let queue = Promise.resolve();
    const enqueue = (task) => {
        const run = queue.then(task, task);
        queue = run.catch(() => undefined);
        return run;
    };

    const readFile = async () => {
        let raw;
        try {
            raw = await fs.promises.readFile(filePath(), 'utf8');
        } catch (error) {
            if (error && error.code === 'ENOENT') return emptyFile();
            throw error;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            // A file we cannot read is moved aside rather than silently overwritten: it is the
            // listener's list, and losing it without a trace would be worse than a stray file.
            const aside = `${filePath()}.broken-${Date.now()}`;
            await fs.promises.rename(filePath(), aside).catch(() => undefined);
            return emptyFile();
        }
        if (!parsed || !Array.isArray(parsed.sources)) return emptyFile();
        return {
            version: Number(parsed.version) || FORMAT_VERSION,
            sources: parsed.sources.filter((entry) => entry && typeof entry.id === 'string'),
        };
    };

    const writeFile = async (file) => {
        const target = filePath();
        const temporary = `${target}.tmp`;
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(temporary, JSON.stringify(file, null, 2), 'utf8');
        // rename is atomic on both NTFS and POSIX, so a crash mid-write leaves the old file intact.
        await fs.promises.rename(temporary, target);
    };

    /** Every source, newest first, with its script decoded. */
    const list = async () => {
        const file = await readFile();
        const rows = await Promise.all(file.sources.map(async (entry) => ({
            id: entry.id,
            platform: typeof entry.platform === 'string' ? entry.platform : '',
            version: typeof entry.version === 'string' ? entry.version : null,
            author: typeof entry.author === 'string' ? entry.author : null,
            description: typeof entry.description === 'string' ? entry.description : null,
            homepage: typeof entry.homepage === 'string' ? entry.homepage : null,
            enabled: entry.enabled !== false,
            userVariableValues: entry.userVariableValues && typeof entry.userVariableValues === 'object'
                ? entry.userVariableValues
                : {},
            addedAt: Number(entry.addedAt) || 0,
            updatedAt: Number(entry.updatedAt) || 0,
            script: await decodeScript(entry.script),
        })));
        return rows.sort((left, right) => right.addedAt - left.addedAt);
    };

    /** The stored row for one id, script decoded, or null. */
    const get = async (id) => {
        const rows = await list();
        return rows.find((row) => row.id === id) ?? null;
    };

    /** Replaces or appends one source. `script` is plain text. */
    const upsert = (entry) => enqueue(async () => {
        if (!entry || typeof entry.id !== 'string' || typeof entry.script !== 'string') {
            throw new Error('invalid-source-entry');
        }
        const file = await readFile();
        const index = file.sources.findIndex((row) => row.id === entry.id);
        const now = Date.now();
        const stored = {
            id: entry.id,
            platform: String(entry.platform ?? ''),
            version: entry.version ?? null,
            author: entry.author ?? null,
            description: entry.description ?? null,
            homepage: entry.homepage ?? null,
            enabled: entry.enabled !== false,
            userVariableValues: entry.userVariableValues && typeof entry.userVariableValues === 'object'
                ? entry.userVariableValues
                : {},
            addedAt: index >= 0 ? (Number(file.sources[index].addedAt) || now) : (Number(entry.addedAt) || now),
            updatedAt: now,
            script: await encodeScript(entry.script),
        };
        if (index >= 0) file.sources[index] = stored;
        else file.sources.push(stored);
        await writeFile(file);
        return stored.id;
    });

    const remove = (id) => enqueue(async () => {
        const file = await readFile();
        const before = file.sources.length;
        file.sources = file.sources.filter((row) => row.id !== id);
        if (file.sources.length === before) return false;
        await writeFile(file);
        return true;
    });

    /** Sets one source's enabled flag; returns the new value, or null when there is no such source. */
    const setEnabled = (id, enabled) => enqueue(async () => {
        const file = await readFile();
        const target = file.sources.find((row) => row.id === id);
        if (!target) return null;
        target.enabled = enabled !== false;
        target.updatedAt = Date.now();
        await writeFile(file);
        return target.enabled;
    });

    /** Saves the listener's values for one source's declared variables. */
    const setUserVariables = (id, values) => enqueue(async () => {
        const file = await readFile();
        const target = file.sources.find((row) => row.id === id);
        if (!target) return null;
        target.userVariableValues = values && typeof values === 'object' ? values : {};
        target.updatedAt = Date.now();
        await writeFile(file);
        return target.userVariableValues;
    });

    return { list, get, upsert, remove, setEnabled, setUserVariables, createSourceId };
};

module.exports = { createCustomSourceStore, createSourceId };
