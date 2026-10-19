// src/services/onlineMusic/customSource/customSourceTransport.ts
// The renderer's only door to the custom source engine.
//
// The engine runs where the plugin scripts can: in the desktop app that is the main process
// (electron/customSource/), reached through the preload bridge; in a self-hosted web build it is
// the Node server (deploy/selfhost/server.mjs), reached over HTTP. Both sides answer with the same
// `{ ok, data }` shape, so nothing above this file knows or cares which one it is talking to.
//
// Why a server at all: a plugin's requests must not be subject to the browser's cross-origin rules
// (measured: the music sites a plugin scrapes answer 403 or omit the CORS headers entirely), and an
// `<audio>` element cannot attach the Referer a source demands. Both are solved by running the
// script off-browser.
//
// Where neither exists — a plain web deploy with no self-host server — the transport reports
// "not available", which is what `getAvailability` surfaces, so the source switcher says so instead
// of looking like it works.

import type { CustomSourceEntry, CustomSourceOperation, CustomSourceResult } from './customSourceTypes';

// src/services/onlineMusic/customSource/customSourceTransport.ts

/** Why a request fails where this page has neither bridge (a web build without a self-host server). */
export const CUSTOM_SOURCE_NEEDS_DESKTOP = 'Custom sources require the desktop app or a self-host server';

/** Why a request fails where the bridge itself threw. */
export const CUSTOM_SOURCE_BRIDGE_FAILED = 'Custom source request failed';

/**
 * The HTTP endpoint of a self-hosted engine, when this build was given one.
 *
 * The base is baked at build time, the same way the web deploy is told where each platform's API
 * lives (the self-host build sets it to `/custom-source`, same origin as the page).
 */
const getHttpBase = (): string | null => {
    const viteEnv = typeof import.meta !== 'undefined' ? (import.meta as any).env : undefined;
    const base = viteEnv?.VITE_CUSTOM_SOURCE_API_BASE;
    return typeof base === 'string' && base.trim() ? base.trim() : null;
};

const hasDesktopBridge = () => (
    typeof window !== 'undefined' && typeof window.electron?.customSourceRequest === 'function'
);

// ─── 应用内引擎（iOS / 独立 App 构建）─────────────────────────────────────────
//
// 打包成 App 时既没有 Electron 主进程，也不一定有自托管服务端；引擎就跑在 WebView 自己里面
// （src/services/onlineMusic/customSourceEngine/）。三种宿主按这个顺序选：
//   1. 桌面版：走 Electron 主进程的桥
//   2. 自托管网页版：走服务端 HTTP 接口
//   3. 独立 App：跑应用内引擎
// 构建时用 VITE_CUSTOM_SOURCE_ENGINE=local 选第 3 种；动态 import 保证桌面/网页构建不会把
// 引擎打进包里。
const isLocalEngineBuild = (): boolean => {
    const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env;
    return env?.VITE_CUSTOM_SOURCE_ENGINE === 'local';
};

let localEnginePromise: Promise<any> | null = null;

/** 应用内引擎，首次调用时才加载并 start（插件是异步读出来的）。 */
const getLocalEngine = (): Promise<any> => {
    if (!localEnginePromise) {
        localEnginePromise = import('../customSourceEngine/engine.js').then(async (module: any) => {
            const system = module.createCustomSourceSystem({ log: console });
            await system.start();
            return system;
        }).catch((error: unknown) => {
            // 失败后允许下次重试，否则一次加载失败会让插件源永久不可用。
            localEnginePromise = null;
            throw error;
        });
    }
    return localEnginePromise;
};

/** Whether this page can reach the engine at all. */
export const getCustomSourceTransportAvailability = () => (
    hasDesktopBridge() || isLocalEngineBuild() || getHttpBase()
        ? { configured: true } as const
        : { configured: false, reason: 'runtime-unavailable' } as const
);

/**
 * One call. Resolves to the engine's own answer (`ok: true` with data, or `ok: false` with a
 * classified error) and rejects only when the bridge itself is missing or threw — the difference
 * matters, because a plugin's failure is reported differently from a broken app.
 */
export async function requestCustomSource<T = unknown>(
    operation: CustomSourceOperation,
    params: Record<string, unknown> = {},
): Promise<CustomSourceResult<T>> {
    let result: CustomSourceResult<T>;
    try {
        if (hasDesktopBridge()) {
            result = await window.electron!.customSourceRequest(operation, params) as CustomSourceResult<T>;
        } else if (isLocalEngineBuild()) {
            const engine = await getLocalEngine();
            result = await engine.request(operation, params) as CustomSourceResult<T>;
        } else {
            const base = getHttpBase();
            if (!base) throw new Error(CUSTOM_SOURCE_NEEDS_DESKTOP);
            const response = await fetch(base, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ operation, params }),
                credentials: 'same-origin',
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            result = await response.json() as CustomSourceResult<T>;
        }
    } catch (error) {
        throw new Error(`${CUSTOM_SOURCE_BRIDGE_FAILED}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        throw new Error(`${CUSTOM_SOURCE_BRIDGE_FAILED}: malformed answer`);
    }
    return result;
}

/** The installed sources, or an empty list where there is no engine to ask. */
export async function listCustomSources(): Promise<CustomSourceEntry[]> {
    if (!getCustomSourceTransportAvailability().configured) return [];
    const result = await requestCustomSource<CustomSourceEntry[]>('list');
    return result.ok ? (result.data ?? []) : [];
}
