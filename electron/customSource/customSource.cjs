// electron/customSource/customSource.cjs
// The custom source subsystem's entry: the store, the live registry, the call boundary and the
// media request-header table, wired together, plus the IPC operations the renderer calls.
//
// This is the main-process half of "custom sources": scripts the listener installs that give Folia
// an online music source it did not ship with (MusicFree plugin format). The renderer half is
// src/services/onlineMusic/customSource/, which adapts these calls to the host's provider contract.
//
// Nothing here runs a script until the listener has installed and enabled one. The settings page
// says what a source is before the first install: third-party code with this process's authority.

'use strict';

const { createCustomSourceStore } = require('./store.cjs');
const { createCustomSourceRegistry } = require('./registry.cjs');
const { createCustomSourceInvoke } = require('./invoke.cjs');
const { createCustomSourceMediaHeaders } = require('./mediaHeaders.cjs');
const { availableModuleNames } = require('./library.cjs');

/**
 * Builds the subsystem. `userDataDir` is where the installed scripts are kept.
 *
 * `onMediaHeaders` is how the main process hooks the header table into its session; the subsystem
 * does not reach for a session itself, so it can be built before `app.whenReady()`.
 */
const createCustomSourceSystem = ({ userDataDir, log = console }) => {
    const store = createCustomSourceStore({ userDataDir });
    const mediaHeaders = createCustomSourceMediaHeaders();
    const registry = createCustomSourceRegistry({ store, log });
    const invoke = createCustomSourceInvoke({ registry, mediaHeaders, log });

    /*
     * The operations the renderer may call, as one table. Each returns `{ ok, data }` or
     * `{ ok: false, error }`; a failure is a value, never a thrown IPC rejection, so the provider
     * layer can tell a source's own failure from a bridge that broke.
     */
    const operations = {
        // The installed list, with each source's load state. No script text.
        list: async () => ({ ok: true, data: await registry.list() }),
        // Re-reads the store and reloads every script. The settings page's "reload".
        reload: async () => ({ ok: true, data: await registry.reload() }),

        // Installs a script by text. `id` replaces an existing source in place.
        install: async ({ script, id } = {}) => {
            try {
                const entry = await registry.install({ script, existingId: id || null });
                return { ok: true, data: entry };
            } catch (error) {
                return { ok: false, error: { kind: error.kind || 'invalid-script', message: error.message } };
            }
        },
        // Installs a script by URL: fetched here, so a source behind CORS is still reachable.
        installFromUrl: async ({ url } = {}) => {
            let text;
            try {
                const response = await fetch(String(url), {
                    redirect: 'follow',
                    headers: { 'user-agent': 'Folia custom source installer' },
                    signal: AbortSignal.timeout(20000),
                });
                if (!response.ok) {
                    return { ok: false, error: { kind: 'download-failed', message: `HTTP ${response.status}` } };
                }
                text = await response.text();
            } catch (error) {
                return { ok: false, error: { kind: 'download-failed', message: error.message || String(error) } };
            }
            try {
                const entry = await registry.install({ script: text });
                return { ok: true, data: entry };
            } catch (error) {
                return { ok: false, error: { kind: error.kind || 'invalid-script', message: error.message } };
            }
        },
        update: async ({ id, script } = {}) => {
            try {
                const entry = await registry.update(String(id), String(script));
                if (!entry) return { ok: false, error: { kind: 'unknown-source', message: 'no such custom source' } };
                return { ok: true, data: entry };
            } catch (error) {
                return { ok: false, error: { kind: error.kind || 'invalid-script', message: error.message } };
            }
        },
        remove: async ({ id } = {}) => ({ ok: true, data: await registry.remove(String(id)) }),
        setEnabled: async ({ id, enabled } = {}) => {
            const value = await registry.setEnabled(String(id), enabled !== false);
            if (value === null) return { ok: false, error: { kind: 'unknown-source', message: 'no such custom source' } };
            return { ok: true, data: value };
        },
        setUserVariables: async ({ id, values } = {}) => {
            const saved = await registry.setUserVariables(String(id), values);
            if (saved === null) return { ok: false, error: { kind: 'unknown-source', message: 'no such custom source' } };
            return { ok: true, data: saved };
        },

        // What the provider layer calls. Each one names the source it is for.
        search: async ({ sourceId, query, page, type } = {}) => invoke.search(String(sourceId), query, page, type),
        getMediaSource: async ({ sourceId, song, quality } = {}) => invoke.getMediaSource(String(sourceId), song, quality),
        getLyric: async ({ sourceId, song } = {}) => invoke.getLyric(String(sourceId), song),
        getMusicInfo: async ({ sourceId, song } = {}) => invoke.getMusicInfo(String(sourceId), song),
        getTopLists: async ({ sourceId } = {}) => invoke.getTopLists(String(sourceId)),
        getTopListDetail: async ({ sourceId, item } = {}) => invoke.getTopListDetail(String(sourceId), item),
        getAlbumInfo: async ({ sourceId, album, page } = {}) => invoke.getAlbumInfo(String(sourceId), album, page),
        getArtistWorks: async ({ sourceId, artist, page, type } = {}) => invoke.getArtistWorks(String(sourceId), artist, page, type),
        importMusicSheet: async ({ sourceId, url } = {}) => invoke.importMusicSheet(String(sourceId), url),
        importMusicItem: async ({ sourceId, url } = {}) => invoke.importMusicItem(String(sourceId), url),

        // Diagnostics for the settings page: what a plugin may require, and how many media URLs
        // currently carry request headers.
        diagnostics: async () => ({
            ok: true,
            data: {
                modules: availableModuleNames(),
                mediaHeaderEntries: mediaHeaders.size(),
            },
        }),
    };

    const request = async (operation, params) => {
        const handler = operations[operation];
        if (!handler) return { ok: false, error: { kind: 'unknown-operation', message: `unknown operation ${operation}` } };
        try {
            return await handler(params || {});
        } catch (error) {
            // A failure this subsystem did not classify is still a value: the renderer must be able
            // to tell "the bridge broke" from "the source failed".
            log.warn(`[CustomSource] ${operation} failed`, error);
            return { ok: false, error: { kind: 'bridge-failed', message: error && error.message ? error.message : String(error) } };
        }
    };

    return {
        request,
        // Loaded once at startup, before the renderer asks for the list.
        start: async () => {
            await registry.reload();
        },
        // The header table, for the session hook in main.cjs.
        mediaHeaders,
        registry,
        subscribe: registry.subscribe,
    };
};

module.exports = { createCustomSourceSystem };
