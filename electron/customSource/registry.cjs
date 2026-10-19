// electron/customSource/registry.cjs
// The live set of installed custom sources: which scripts are loaded, what each one may do, and
// the calls the renderer makes into them.
//
// One source is loaded at a time and kept until it is disabled, removed, or its script changes. A
// load failure is recorded against the source rather than thrown at the caller, so the settings
// page can show why a source does not work while every other source keeps working.
//
// Every call into plugin code is bounded. A plugin is arbitrary third-party JavaScript: it can
// hang on a request, loop, or reject. The bound turns each of those into a failed call that the
// provider layer reports, instead of a hung main process or an unhandled rejection.

'use strict';

const { loadPlugin, CustomSourceLoadError } = require('./loader.cjs');
const { createSourceId } = require('./store.cjs');

// How long one plugin call may take. Search and audio resolution both do network work through the
// plugin's own libraries, which have their own timeouts; this is the backstop above them.
const CALL_TIMEOUT_MS = 30000;
// A search that answers in this long is slow enough to say so in the log, but it still succeeds.
const SLOW_CALL_MS = 5000;

/** What a call failed with. `kind` is what the provider layer turns into a failure case. */
class CustomSourceCallError extends Error {
    constructor(kind, message) {
        super(message);
        this.name = 'CustomSourceCallError';
        this.kind = kind;
    }
}

const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new CustomSourceCallError('timeout', `${label} did not answer within ${ms}ms`));
    }, ms);
    Promise.resolve(promise).then(
        (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        },
        (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        },
    );
});

/*
 * A plugin's own error, reduced to a string that can cross IPC. A plugin may throw anything
 * (MusicFree plugins often throw bare `{ errorReason }` objects), so this never assumes an Error.
 */
const describePluginError = (error) => {
    if (!error) return 'unknown error';
    if (typeof error === 'string') return error;
    if (typeof error.message === 'string' && error.message) return error.message;
    if (typeof error.errorReason === 'string') return error.errorReason;
    try {
        const text = JSON.stringify(error);
        if (text && text !== '{}') return text;
    } catch {
        // Falls through to String().
    }
    return String(error);
};

/**
 * The registry. `store` is the persisted list; `log` is the main process's console.
 */
const createCustomSourceRegistry = ({ store, log = console }) => {
    /** id -> { row, plugin, error, loadedAt } */
    const loaded = new Map();
    const listeners = new Set();
    let version = 0;

    const announce = () => {
        version += 1;
        listeners.forEach((listener) => {
            try {
                listener();
            } catch (error) {
                log.warn('[CustomSource] a registry listener threw', error);
            }
        });
    };

    /** Loads one stored row into `loaded`, replacing whatever was there. */
    const mount = (row) => {
        const previous = loaded.get(row.id);
        if (previous) loaded.delete(row.id);

        if (!row.enabled) {
            loaded.set(row.id, { row, plugin: null, error: null, loadedAt: 0 });
            return;
        }
        if (typeof row.script !== 'string' || row.script.trim().length === 0) {
            loaded.set(row.id, { row, plugin: null, error: 'script is empty', loadedAt: 0 });
            return;
        }

        try {
            const plugin = loadPlugin(row.script, {
                getUserVariables: () => row.userVariableValues || {},
            });
            loaded.set(row.id, { row, plugin, error: null, loadedAt: Date.now() });
            log.info(`[CustomSource] loaded "${plugin.platform}" (${row.id})`);
        } catch (error) {
            const message = error instanceof CustomSourceLoadError ? error.message : describePluginError(error);
            loaded.set(row.id, { row, plugin: null, error: message, loadedAt: 0 });
            log.warn(`[CustomSource] could not load "${row.platform || row.id}": ${message}`);
        }
    };

    /** Reads the store and rebuilds `loaded` from it. */
    const reload = async () => {
        const rows = await store.list();
        const seen = new Set(rows.map((row) => row.id));
        Array.from(loaded.keys()).forEach((id) => {
            if (!seen.has(id)) loaded.delete(id);
        });
        rows.forEach(mount);
        announce();
        return list();
    };

    /** What the settings page and the provider layer read: one row per source, no script text. */
    const list = () => Array.from(loaded.values())
        .map(({ row, plugin, error }) => ({
            id: row.id,
            platform: plugin ? plugin.platform : (row.platform || ''),
            version: plugin ? plugin.version : row.version,
            author: plugin ? plugin.author : row.author,
            description: plugin ? plugin.description : row.description,
            homepage: plugin ? plugin.homepage : row.homepage,
            enabled: row.enabled,
            // Why it is not usable, or null. A disabled source is not an error.
            error: row.enabled ? error : null,
            methods: plugin ? plugin.supportedMethods : [],
            userVariables: plugin ? plugin.userVariables : [],
            userVariableValues: row.userVariableValues || {},
            addedAt: row.addedAt,
            updatedAt: row.updatedAt,
            loadedAt: loaded.get(row.id)?.loadedAt ?? 0,
        }))
        .sort((left, right) => left.addedAt - right.addedAt);

    /** The usable plugins, keyed by source id. Disabled and broken ones are left out. */
    const activePlugins = () => {
        const result = new Map();
        loaded.forEach((entry, id) => {
            if (entry.row.enabled && entry.plugin) result.set(id, entry.plugin);
        });
        return result;
    };

    /** Calls one plugin method with the timeout, turning every failure into a CustomSourceCallError. */
    const call = async (sourceId, method, args, label) => {
        const entry = loaded.get(sourceId);
        if (!entry) throw new CustomSourceCallError('unknown-source', `no custom source ${sourceId}`);
        if (!entry.row.enabled) throw new CustomSourceCallError('disabled', `custom source ${sourceId} is disabled`);
        if (!entry.plugin) {
            throw new CustomSourceCallError('not-loaded', entry.error || `custom source ${sourceId} is not loaded`);
        }
        const fn = entry.plugin.instance[method];
        if (typeof fn !== 'function') {
            throw new CustomSourceCallError('unsupported', `custom source ${sourceId} has no ${method}`);
        }

        const startedAt = Date.now();
        try {
            const value = await withTimeout(
                Promise.resolve().then(() => fn.apply(entry.plugin.instance, args)),
                CALL_TIMEOUT_MS,
                label,
            );
            const elapsed = Date.now() - startedAt;
            if (elapsed >= SLOW_CALL_MS) {
                log.info(`[CustomSource] ${label} took ${elapsed}ms`);
            }
            return value;
        } catch (error) {
            if (error instanceof CustomSourceCallError) throw error;
            throw new CustomSourceCallError('plugin-failed', describePluginError(error));
        }
    };

    /** Installs a script: loads it first, and only stores it once it produced a usable plugin. */
    const install = async ({ script, enabled = true, userVariableValues = {}, existingId = null }) => {
        if (typeof script !== 'string' || script.trim().length === 0) {
            throw new CustomSourceCallError('invalid-script', 'script is empty');
        }
        // Loaded before it is stored, so a script that does not work never reaches the list.
        const probe = loadPlugin(script, {
            getUserVariables: () => userVariableValues,
        });

        const id = existingId || createSourceId();
        const previous = existingId ? await store.get(existingId) : null;
        await store.upsert({
            id,
            platform: probe.platform,
            version: probe.version,
            author: probe.author,
            description: probe.description,
            homepage: probe.homepage,
            script,
            enabled,
            userVariableValues: previous?.userVariableValues ?? userVariableValues,
            addedAt: previous?.addedAt,
        });
        const row = await store.get(id);
        mount(row);
        announce();
        return list().find((entry) => entry.id === id) ?? null;
    };

    const remove = async (id) => {
        const removed = await store.remove(id);
        if (removed) {
            loaded.delete(id);
            announce();
        }
        return removed;
    };

    const setEnabled = async (id, enabled) => {
        const value = await store.setEnabled(id, enabled);
        if (value === null) return null;
        const row = await store.get(id);
        if (row) mount(row);
        announce();
        return value;
    };

    const setUserVariables = async (id, values) => {
        const saved = await store.setUserVariables(id, values);
        if (saved === null) return null;
        const row = await store.get(id);
        if (row) mount(row);
        announce();
        return saved;
    };

    /** Updates one source's script in place, keeping its id, switch and variables. */
    const update = async (id, script) => {
        const previous = await store.get(id);
        if (!previous) return null;
        return install({
            script,
            enabled: previous.enabled,
            userVariableValues: previous.userVariableValues,
            existingId: id,
        });
    };

    const subscribe = (listener) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    };

    return {
        reload,
        list,
        activePlugins,
        call,
        install,
        update,
        remove,
        setEnabled,
        setUserVariables,
        subscribe,
        getVersion: () => version,
    };
};

module.exports = { createCustomSourceRegistry, CustomSourceCallError, CALL_TIMEOUT_MS };
