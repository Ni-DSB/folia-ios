// src/services/onlineMusic/customSourceEngine/moduleTable.ts
// 浏览器里的插件模块表：替代 electron/customSource/library.cjs。
//
// 桌面版把插件跑在主进程，直接 require Node 的包；这里跑在 WebView 里，所以要换成浏览器可用的
// 实现。插件只认 `require(name)` 这个入口，表里有什么它就能拿到什么，因此两边的表要尽量同形。
//
// 关键一条：插件用 axios 发请求。浏览器里 axios 走 XMLHttpRequest，受同源策略约束；打包成
// Capacitor App 后，CapacitorHttp 会把 XHR/fetch 换成原生实现，跨域限制随之消失。所以这里
// 不需要任何代理层，换宿主即可。

import axios from 'axios';
import * as cheerio from 'cheerio';
import CryptoJS from 'crypto-js';
import qs from 'qs';
import bigInt from 'big-integer';
// he 是纯 ESM（只有具名导出 encode/decode/escape/unescape，没有 default），
// 所以整体命名空间导入，插件那边 require('he') 拿到的就是这个对象。
import * as he from 'he';
import dayjs from 'dayjs';
import { Buffer } from 'buffer';

// ─── Node 内置模块的浏览器垫片 ────────────────────────────────────────────────
// 插件偶尔 require('crypto') 之类。浏览器没有这些模块，这里按插件实际会用到的接口给最小实现。

// ─── axios 适配器 ──────────────────────────────────────────────────────────
// 插件全部用 axios 发请求。浏览器里 axios 默认选 XHR 适配器，而 CapacitorHttp 虽然同时补丁了
// fetch 和 XHR，但 XHR 那条路在 WKWebView 里对自定义头（Referer/User-Agent）支持更弱。
// 显式走 fetch 适配器后，请求统一经 CapacitorHttp 的 fetch 补丁发出，头能原样带上。
// 桌面浏览器里没有 CapacitorHttp，就是普通 fetch（受 CORS 约束，这是预期行为）。
try {
    (axios as any).defaults.adapter = 'fetch';
} catch {
    // 改不动就沿用默认适配器：XHR 在 Capacitor 下同样被补丁过，功能不受影响。
}

const cryptoShim = {
    createHash(algorithm: string) {
        const algo = /md5/i.test(algorithm) ? CryptoJS.MD5
            : /sha256/i.test(algorithm) ? CryptoJS.SHA256
                : /sha512/i.test(algorithm) ? CryptoJS.SHA512
                    : CryptoJS.SHA1;
        let acc: any = null;
        return {
            update(data: any) {
                acc = acc ? acc.concat(data) : data;
                return this;
            },
            digest(encoding?: string) {
                const hash = algo(acc === null ? '' : acc);
                return encoding === 'hex' ? hash.toString(CryptoJS.enc.Hex) : hash;
            },
        };
    },
    createHmac(algorithm: string, key: any) {
        const algo = /sha256/i.test(algorithm) ? CryptoJS.HmacSHA256 : CryptoJS.HmacSHA1;
        // 累加 update 传进来的数据：HMAC 要等 update 走完才能算 digest。
        let accumulated = '';
        return {
            update(data: any) {
                accumulated += data === undefined || data === null ? '' : String(data);
                return this;
            },
            digest(encoding?: string) {
                const hash = algo(accumulated, String(key ?? ''));
                return encoding === 'hex' ? hash.toString(CryptoJS.enc.Hex) : hash;
            },
        };
    },
    randomBytes(size: number) {
        const out = new Uint8Array(size);
        globalThis.crypto.getRandomValues(out);
        return Buffer.from(out);
    },
};

const urlShim = {
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    parse: (input: string) => {
        try {
            const u = new globalThis.URL(input);
            return {
                protocol: u.protocol,
                host: u.host,
                hostname: u.hostname,
                port: u.port,
                pathname: u.pathname,
                search: u.search,
                query: Object.fromEntries(u.searchParams),
                hash: u.hash,
            };
        } catch { return {}; }
    },
    format: (u: any) => (typeof u === 'string' ? u : `${u.protocol}//${u.host ?? u.hostname}${u.pathname ?? ''}${u.search ?? ''}`),
    resolve: (from: string, to: string) => new globalThis.URL(to, from).href,
};

const querystringShim = {
    stringify: (obj: Record<string, unknown>) => qs.stringify(obj),
    parse: (text: string) => qs.parse(String(text ?? '').replace(/^\?/, '')),
    escape: encodeURIComponent,
    unescape: decodeURIComponent,
};

const utilShim = {
    promisify: (fn: any) => (...args: any[]) => new Promise((resolve, reject) => {
        fn(...args, (error: any, value: any) => (error ? reject(error) : resolve(value)));
    }),
    inspect: (value: unknown) => { try { return JSON.stringify(value); } catch { return String(value); } },
    format: (...args: any[]) => args.map(a => typeof a === 'string' ? a : utilShim.inspect(a)).join(' '),
};

// 只用到一个图片信息解析库，它是纯 JS；其余包按需引入。
const heModule = he as any;

const MODULE_FACTORIES: Record<string, () => unknown> = {
    axios: () => axios,
    cheerio: () => cheerio,
    'crypto-js': () => CryptoJS,
    qs: () => qs,
    'big-integer': () => bigInt,
    he: () => heModule,
    dayjs: () => dayjs,
    crypto: () => cryptoShim,
    url: () => urlShim,
    querystring: () => querystringShim,
    buffer: () => ({ Buffer }),
    util: () => utilShim,
};

const cache = new Map<string, unknown>();
const unavailable = new Map<string, Error>();

/**
 * 解析一个模块名。与桌面版行为一致：MusicFree 会把每个模块的 `default` 指向自己，
 * 因为插件既有 CommonJS 写法也有 ES 写法。
 */
export const loadModule = (name: string): any => {
    const key = String(name);
    if (cache.has(key)) return cache.get(key);
    const failure = unavailable.get(key);
    if (failure) throw new Error(`Cannot find module '${key}'`);

    const factory = MODULE_FACTORIES[key];
    if (!factory) {
        unavailable.set(key, new Error('not bundled'));
        throw new Error(`Cannot find module '${key}'`);
    }

    let mod: any;
    try {
        mod = factory();
    } catch (error) {
        unavailable.set(key, error as Error);
        throw new Error(`Cannot load module '${key}': ${error instanceof Error ? error.message : String(error)}`);
    }

    // 同桌面版：没有 default 的对象补一个指向自己的 default（冻结对象忽略失败）。
    try {
        if (mod && typeof mod === 'object' && !('default' in mod)) {
            Object.defineProperty(mod, 'default', { value: mod, enumerable: false, configurable: true });
        }
    } catch {
        // 拒绝附加属性的模块仍可按 CommonJS 形状使用。
    }

    cache.set(key, mod);
    return mod;
};

/** 插件可 require 的名字，排序后返回（用于设置页诊断）。 */
export const availableModuleNames = (): string[] => Object.keys(MODULE_FACTORIES).sort();

/** 某个名字为何不可用；可用时返回 null。 */
export const moduleUnavailableReason = (name: string): string | null => {
    const key = String(name);
    if (cache.has(key)) return null;
    if (!MODULE_FACTORIES[key]) return `not bundled: ${key}`;
    const failure = unavailable.get(key);
    return failure ? `failed to load: ${failure.message}` : null;
};
