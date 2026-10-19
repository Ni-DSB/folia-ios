import { createCustomSourceStore } from './store';
import { createCustomSourceRegistry } from './registry';
import { createCustomSourceInvoke } from './invoke';
import { createCustomSourceMediaHeaders } from './mediaHeaders';
import { availableModuleNames } from './moduleTable';
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







/**
 * Builds the subsystem for the browser/WebView host.
 *
 * 与桌面版唯一的区别：没有文件系统。插件存在 IndexedDB 里（见 store.ts），所以这里不需要
 * `userDataDir`，也不需要主进程的 session 钩子——音频请求头由调用方在取流时自己带上。
 */
const createCustomSourceSystem = ({ log = console } = {}) => {
    const store = createCustomSourceStore();
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

        // 音源地址。插件给的 URL 常常要带 Referer/User-Agent 才能取到流，而 <audio> 元素自己发请求、
        // 加不了请求头——桌面版靠主进程改写请求解决，这里换成：插件登记了头时先把字节取回来做成
        // blob URL，播放器拿到的就是一个能正常播的对象地址。不需要头的直接返回原地址（保持流式）。
        // 在 App 里这次取流走 CapacitorHttp：原生请求，头能原样带上，也不受 CORS 约束。
        getMediaSource: async ({ sourceId, song, quality } = {}) => {
            const answer = await invoke.getMediaSource(String(sourceId), song, quality);
            if (!answer.ok) return answer;
            const url = answer.data && answer.data.url;
            if (!url) return answer;
            let headers = null;
            try { headers = mediaHeaders.headersFor(url); } catch { headers = null; }
            if (!headers || Object.keys(headers).length === 0) return answer;
            try {
                const response = await fetch(url, { headers });
                if (!response.ok) return answer;
                const blob = await response.blob();
                if (!blob.size) return answer;
                return { ok: true, data: { ...answer.data, url: URL.createObjectURL(blob), fetchedBytes: blob.size } };
            } catch (error) {
                // 取流失败就退回原地址：让播放器按它自己的方式报错，比在这里吞掉更有用。
                log.warn('[CustomSource] 音源预取失败，退回原始地址', error);
                return answer;
            }
        },

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

export { createCustomSourceSystem };