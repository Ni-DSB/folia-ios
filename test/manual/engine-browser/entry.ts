// test/manual/engine-browser/entry.ts
// 浏览器里的插件引擎验证入口（手动测试用，配合 run-with-proxy.mjs 驱动）。
//
// 它验证「独立 App」这条路的核心：在没有 Electron 主进程、没有自托管服务端的页面上，直接用
// src/services/onlineMusic/customSourceEngine/ 跑真实插件——加载、搜索、取音源、取歌词。
//
// 网络：浏览器里 JS 不能设置 Referer/User-Agent，插件会被平台回 403。run-with-proxy.mjs 用本地
// 代理模拟 Capacitor 的原生 HTTP（CapacitorHttp），证明带头之后请求能通。真机由 CapacitorHttp
// 直接完成这一步，无需代理。

import { createCustomSourceSystem } from '../../../src/services/onlineMusic/customSourceEngine/engine.js';
import { availableModuleNames } from '../../../src/services/onlineMusic/customSourceEngine/moduleTable.js';

interface StepRecord {
    name: string;
    [key: string]: unknown;
}

interface EngineTestResult {
    steps: StepRecord[];
    ok: boolean;
}

// 引擎只要 info/warn 两个方法；这里给它一个够用的 log，不必满足完整 Console 接口。
const log = {
    info: (...args: unknown[]) => console.log('[engine]', ...args),
    warn: (...args: unknown[]) => console.warn('[engine]', ...args),
} as unknown as Console;

declare global {
    interface Window {
        __runEngineTest?: (scriptText?: string) => Promise<EngineTestResult>;
        __ready?: boolean;
    }
}

const run = async (scriptText?: string): Promise<EngineTestResult> => {
    const out: EngineTestResult = { steps: [], ok: false };
    const push = (name: string, data: Record<string, unknown> = {}) => {
        out.steps.push({ name, ...data });
    };

    try {
        push('模块表', { modules: availableModuleNames() });

        const system = createCustomSourceSystem({ log });
        await system.start();
        const initial = await system.request('list', {});
        push('引擎启动', { installed: initial?.data?.length ?? 0 });

        if (!scriptText) { out.ok = true; return out; }

        const installed = await system.request('install', { script: scriptText });
        push('安装插件', installed.ok
            ? { ok: true, platform: installed.data.platform, version: installed.data.version }
            : { ok: false, error: installed.error });
        if (!installed.ok) return out;

        const sourceId: string = installed.data.id;
        const list = await system.request('list', {});
        push('列表', {
            count: list.data.length,
            first: list.data[0] && {
                platform: list.data[0].platform,
                methods: list.data[0].methods?.length ?? 0,
            },
        });

        const search = await system.request('search', { sourceId, query: '晴天 周杰伦', page: 1, type: 'music' });
        push('搜索', search.ok
            ? { ok: true, count: search.data.items.length, first: String(search.data.items[0]?.title ?? '').slice(0, 40) }
            : { ok: false, error: search.error });
        if (!search.ok || !search.data.items.length) return out;

        const song = search.data.items[0];
        const audio = await system.request('getMediaSource', { sourceId, song, quality: 'high' });
        push('取音源', audio.ok
            ? {
                ok: true,
                url: String(audio.data.url).slice(0, 60),
                isBlob: String(audio.data.url).startsWith('blob:'),
                bytes: audio.data.fetchedBytes ?? null,
                quality: audio.data.quality,
                hasHeaders: audio.data.hasHeaders,
            }
            : { ok: false, error: audio.error });
        if (!audio.ok) return out;

        // 真正用 <audio> 播一下：这一条决定「插件源能不能出声」，而不只是「拿到了地址」。
        const playback = await new Promise<Record<string, unknown>>((resolve) => {
            const el = document.createElement('audio');
            el.src = String(audio.data.url);
            el.preload = 'auto';
            document.body.appendChild(el);
            let settled = false;
            const finish = (extra: Record<string, unknown>) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                const info = {
                    readyState: el.readyState,
                    durationSec: Math.round(el.duration || 0),
                    currentTime: Math.round(el.currentTime * 10) / 10,
                    paused: el.paused,
                    mediaError: el.error ? `${el.error.code}` : null,
                    ...extra,
                };
                el.remove();
                resolve(info);
            };
            const timer = setTimeout(() => finish({ note: '超时' }), 25000);
            el.addEventListener('playing', () => setTimeout(() => finish({}), 1200));
            el.addEventListener('error', () => finish({ note: '元素报错' }));
            el.play().catch((e: Error) => finish({ note: `play() 被拒: ${e.name}` }));
        });
        push('播放', playback);
        const playable = Number(playback.readyState) >= 2 && !playback.mediaError && playback.note !== '元素报错';
        if (!playable) return out;

        const lyric = await system.request('getLyric', { sourceId, song });
        push('歌词', lyric.ok
            ? { ok: true, hasLrc: Boolean(lyric.data?.lrc), length: lyric.data?.lrc?.length ?? 0 }
            : { ok: false, error: lyric.error });

        out.ok = true;
        return out;
    } catch (error) {
        push('异常', { message: String((error as Error)?.message ?? error) });
        return out;
    }
};

window.__runEngineTest = run;
window.__ready = true;
