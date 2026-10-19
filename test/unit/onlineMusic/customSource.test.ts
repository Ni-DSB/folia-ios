// test/unit/onlineMusic/customSource.test.ts
// The custom source subsystem's pure parts: the plugin loader's module table, the invoke layer's
// normalisation, and the provider's capability mapping. The network and the settings page are not
// covered here — those are the parts a unit test cannot reach without a running main process.

import { describe, expect, it, vi } from 'vitest';

// The loader and invoke modules are CommonJS in electron/; they are imported through Node's own
// resolution so the test exercises the same files the main process loads.
const { loadPlugin } = await import('../../../electron/customSource/loader.cjs');
const { normalizeSong, normalizeSearchResult, normalizeLyric, QUALITY_TO_MUSICFREE } =
    await import('../../../electron/customSource/invoke.cjs');
const { sanitizeHeaders, createCustomSourceMediaHeaders } =
    await import('../../../electron/customSource/mediaHeaders.cjs');
const { createCustomSourceStore } = await import('../../../electron/customSource/store.cjs');

describe('custom source plugin loader', () => {
    it('loads a plugin that assigns to module.exports', () => {
        const plugin = loadPlugin(`
            module.exports = {
                platform: 'Test Source',
                version: '1.2.3',
                async search(query) { return { data: [{ id: '1', title: query }], isEnd: true }; },
                async getMediaSource(song) { return { url: 'https://example.com/' + song.id }; },
            };
        `);
        expect(plugin.platform).toBe('Test Source');
        expect(plugin.version).toBe('1.2.3');
        expect(plugin.supportedMethods).toContain('search');
        expect(plugin.supportedMethods).toContain('getMediaSource');
    });

    it('loads a plugin that assigns to module.exports.default', () => {
        const plugin = loadPlugin(`
            module.exports.default = {
                platform: 'Default Source',
                async search() { return { data: [], isEnd: true }; },
            };
        `);
        expect(plugin.platform).toBe('Default Source');
    });

    it('gives the plugin a working require for the bundled modules', () => {
        const plugin = loadPlugin(`
            const cryptoJs = require('crypto-js');
            module.exports = {
                platform: 'Uses Crypto',
                hash: cryptoJs.MD5('abc').toString(),
            };
        `);
        expect(plugin.platform).toBe('Uses Crypto');
        // MD5 of "abc"; the value is not the point, that require returned a working module is.
        expect(plugin.instance.hash).toHaveLength(32);
    });

    it('fails a require for a module that is not bundled', () => {
        expect(() => loadPlugin(`
            require('not-a-real-module');
            module.exports = { platform: 'Broken' };
        `)).toThrow(/not-a-real-module/);
    });

    it('rejects a script with no platform name', () => {
        expect(() => loadPlugin('module.exports = { search() {} };')).toThrow(/platform/);
    });

    it('rejects an empty script', () => {
        expect(() => loadPlugin('   ')).toThrow(/empty/);
    });

    it('rejects a script that does not compile', () => {
        expect(() => loadPlugin('module.exports = {')).toThrow(/does not compile/);
    });

    it('rejects a script that throws while loading', () => {
        expect(() => loadPlugin('throw new Error("boom");')).toThrow(/boom/);
    });

    it('reads the variables a plugin declares', () => {
        const plugin = loadPlugin(`
            module.exports = {
                platform: 'With Vars',
                userVariables: [{ key: 'token', name: 'Token' }, { name: 'no key' }],
            };
        `);
        expect(plugin.userVariables).toEqual([{ key: 'token', name: 'Token' }]);
    });
});

describe('custom source invoke normalisation', () => {
    it('keeps the fields the host needs and the plugin object beside them', () => {
        const song = normalizeSong({
            id: 42,
            title: 'A Song',
            artist: 'Artist One / Artist Two',
            album: 'An Album',
            artwork: 'https://example.com/cover.jpg',
            duration: 215,
            somePluginField: { nested: true },
        });
        expect(song).toMatchObject({
            id: '42',
            title: 'A Song',
            artists: ['Artist One', 'Artist Two'],
            album: 'An Album',
            artwork: 'https://example.com/cover.jpg',
            // MusicFree reports seconds; the host works in milliseconds.
            durationMs: 215000,
        });
        // The plugin's own object is kept: its getMediaSource reads fields only it knows (bilibili's cid).
        expect(song?.raw).toEqual({
            id: 42,
            title: 'A Song',
            artist: 'Artist One / Artist Two',
            album: 'An Album',
            artwork: 'https://example.com/cover.jpg',
            duration: 215,
            somePluginField: { nested: true },
        });
    });

    it('reads a duration that a plugin reported in milliseconds', () => {
        // 猫耳FM reports milliseconds; 2563866 is a 42-minute episode, not a 29-day one.
        expect(normalizeSong({ id: '1', title: 'T', duration: 2563866 })?.durationMs).toBe(2563866);
        // A number under two hours is seconds.
        expect(normalizeSong({ id: '1', title: 'T', duration: 270 })?.durationMs).toBe(270000);
        expect(normalizeSong({ id: '1', title: 'T', duration: 0 })?.durationMs).toBe(0);
    });

    it('rejects a song without an id or a title', () => {
        expect(normalizeSong({ title: 'No id' })).toBeNull();
        expect(normalizeSong({ id: '1' })).toBeNull();
        expect(normalizeSong(null)).toBeNull();
    });

    it('splits the artist string the sources use', () => {
        expect(normalizeSong({ id: '1', title: 'T', artist: 'A、B' })?.artists).toEqual(['A', 'B']);
        expect(normalizeSong({ id: '1', title: 'T', artist: 'A feat. B' })?.artists).toEqual(['A', 'B']);
        expect(normalizeSong({ id: '1', title: 'T', artist: '' })?.artists).toEqual([]);
    });

    it('reads a search result and its end flag', () => {
        const page = normalizeSearchResult({
            data: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }, { noId: true }],
            isEnd: false,
        });
        expect(page.items).toHaveLength(2);
        expect(page.isEnd).toBe(false);
        // A missing isEnd means the source did not say; treat it as the end rather than paging forever.
        expect(normalizeSearchResult({ data: [] }).isEnd).toBe(true);
    });

    it('prefers the untranslated lyric text', () => {
        expect(normalizeLyric({ lrc: '[00:01]translated', rawLrc: '[00:01]original' })).toEqual({
            lrc: '[00:01]original',
        });
        expect(normalizeLyric('plain text')).toEqual({ lrc: 'plain text' });
        expect(normalizeLyric({})).toBeNull();
    });

    it('maps the host quality levels onto MusicFree names', () => {
        expect(QUALITY_TO_MUSICFREE.standard).toBe('standard');
        expect(QUALITY_TO_MUSICFREE.lossless).toBe('super');
        expect(QUALITY_TO_MUSICFREE.hires).toBe('super');
        expect(QUALITY_TO_MUSICFREE.ultra).toBe('super');
    });
});

describe('custom source media headers', () => {
    it('refuses to set the headers that describe the request itself', () => {
        const clean = sanitizeHeaders({
            referer: 'https://example.com/',
            'user-agent': 'A',
            host: 'evil.example',
            'content-length': '10',
            range: 'bytes=0-1',
            'accept-encoding': 'gzip',
        });
        expect(clean).toEqual({ referer: 'https://example.com/', 'user-agent': 'A' });
    });

    it('answers the headers for a registered URL and forgets it when asked', () => {
        let clock = 1000;
        const table = createCustomSourceMediaHeaders({ now: () => clock });
        table.register('https://cdn.example.com/a.m4a', { referer: 'https://example.com/' });
        expect(table.headersFor('https://cdn.example.com/a.m4a')).toEqual({ referer: 'https://example.com/' });

        table.forget('https://cdn.example.com/a.m4a');
        expect(table.headersFor('https://cdn.example.com/a.m4a')).toBeNull();
    });

    it('drops an entry once it expires', () => {
        let clock = 1000;
        const table = createCustomSourceMediaHeaders({ now: () => clock });
        table.register('https://cdn.example.com/a.m4a', { referer: 'x' }, 500);
        clock += 501;
        expect(table.headersFor('https://cdn.example.com/a.m4a')).toBeNull();
    });

    it('ignores a URL that is not http(s)', () => {
        const table = createCustomSourceMediaHeaders();
        expect(table.register('javascript:alert(1)', { referer: 'x' })).toBe(false);
        expect(table.register('file:///etc/passwd', { referer: 'x' })).toBe(false);
    });

    it('leaves a request alone when its URL was never issued', () => {
        const table = createCustomSourceMediaHeaders();
        const callback = vi.fn();
        table.onBeforeSendHeaders(
            { url: 'https://unknown.example/x.m4a', resourceType: 'media', requestHeaders: { A: '1' } },
            callback,
        );
        expect(callback).toHaveBeenCalledWith({});
    });

    it('puts the headers on a media request for an issued URL', () => {
        const table = createCustomSourceMediaHeaders();
        table.register('https://cdn.example.com/a.m4a', { referer: 'https://example.com/' });
        const callback = vi.fn();
        table.onBeforeSendHeaders(
            {
                url: 'https://cdn.example.com/a.m4a',
                resourceType: 'media',
                requestHeaders: { Referer: 'https://wrong.example/', Accept: '*/*' },
            },
            callback,
        );
        const answer = callback.mock.calls[0][0];
        expect(answer.requestHeaders.referer).toBe('https://example.com/');
        // The differently-cased existing header is replaced, not duplicated.
        expect(answer.requestHeaders.Referer).toBeUndefined();
        expect(answer.requestHeaders.Accept).toBe('*/*');
    });

    it('does not put headers on a navigation', () => {
        const table = createCustomSourceMediaHeaders();
        table.register('https://cdn.example.com/a.m4a', { referer: 'https://example.com/' });
        const callback = vi.fn();
        table.onBeforeSendHeaders(
            { url: 'https://cdn.example.com/a.m4a', resourceType: 'mainFrame', requestHeaders: {} },
            callback,
        );
        expect(callback).toHaveBeenCalledWith({});
    });
});

describe('custom source store', () => {
    it('writes, reads back and removes a source', async () => {
        const { mkdtemp } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const dir = await mkdtemp(join(tmpdir(), 'folia-cs-'));
        const store = createCustomSourceStore({ userDataDir: dir });
        const id = store.createSourceId();

        await store.upsert({ id, platform: 'P', script: 'module.exports = {};', enabled: true });
        const rows = await store.list();
        expect(rows).toHaveLength(1);
        expect(rows[0].platform).toBe('P');
        // The script comes back as plain text even though it is stored compressed.
        expect(rows[0].script).toBe('module.exports = {};');

        expect(await store.setEnabled(id, false)).toBe(false);
        expect((await store.get(id))?.enabled).toBe(false);

        expect(await store.remove(id)).toBe(true);
        expect(await store.list()).toHaveLength(0);
    });
});
