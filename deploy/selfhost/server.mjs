// deploy/selfhost/server.mjs
// Folia 自托管服务：一个进程提供 Web 前端、网易云 API、插件音源引擎和音频代理。
//
// 为什么需要它：桌面版的插件引擎跑在 Electron 主进程里，网页版没有主进程；而各音乐平台的接口
// 不允许浏览器跨域读取（实测：bilibili 403、网易云与猫耳无 CORS 头）。所以插件引擎必须搬到服务端，
// 由它代发请求。electron/customSource/ 那七个文件零 Electron 依赖，直接复用。
//
// 路由：
//   /netease/*     → 挂载网易云 API 的 express app（VITE_NETEASE_API_BASE=/netease）
//   /custom-source → 插件引擎的 HTTP 入口（POST {operation, params}，与桌面 IPC 同形状）
//   /media-proxy   → 音频代理：带插件要求的 Referer/UA，并改写 m3u8 的分片地址
//   /api/*         → AI 主题生成（复用编译好的 api/ 处理器；没有密钥时前端自动退回封面取色）
//   /healthz       → 健康检查
//   /runtime-config.js → 运行时配置
//   其余           → dist/ 静态文件（SPA 回退）
//
// 安全：/media-proxy 是个转发器，可能被当跳板。因此只接受本服务签发过的 token，不接受调用方给的
// 任意 URL。token 随机、有 TTL、有数量上限。
//
// 用法（仓库根目录）：先 npm run build:selfhost 产出 dist/，再 node deploy/selfhost/server.mjs

import express from 'express';
import { stat, readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(ROOT, 'noop.js'));

const PORT = Number(process.env.PORT || 8081);
// 网易云 app 只挂载、不单独监听，这个端口仅用于 serveNcmApi 内部（它总会 listen 一次）。
const NCM_PORT = Number(process.env.NCM_PORT || 3900);
const DIST = path.join(ROOT, 'dist');
const DATA_DIR = process.env.FOLIA_SELFHOST_DATA || path.join(HERE, 'data');

const log = (...a) => console.log('[folia-selfhost]', ...a);

// ─── 插件引擎（复用桌面版那七个文件）───────────────────────────────────────
const { createCustomSourceSystem } = require('./electron/customSource/customSource.cjs');

await mkdir(DATA_DIR, { recursive: true });
const customSources = createCustomSourceSystem({
    userDataDir: path.join(DATA_DIR, 'custom-sources'),
    log: { info: () => {}, warn: (...a) => log('[CustomSource]', ...a) },
});
await customSources.start();

// ─── 音频代理的签发表：token → {url, headers, expiresAt} ────────────────────
const PROXY_TTL_MS = 6 * 60 * 60 * 1000;
const PROXY_MAX = 4096;
const proxyEntries = new Map();

const issueProxy = (url, headers) => {
    const token = crypto.randomBytes(12).toString('base64url');
    proxyEntries.set(token, { url, headers: headers || {}, expiresAt: Date.now() + PROXY_TTL_MS });
    while (proxyEntries.size > PROXY_MAX) {
        const oldest = proxyEntries.keys().next().value;
        if (oldest === undefined) break;
        proxyEntries.delete(oldest);
    }
    return token;
};

/** 把源站的相对地址（m3u8 里的分片、密钥）换算成绝对地址，再签成代理地址。 */
const toProxiedUrl = (rawUrl, baseUrl, headers) => {
    let absolute;
    try { absolute = new URL(rawUrl, baseUrl).href; } catch { return rawUrl; }
    return `/media-proxy?t=${issueProxy(absolute, headers)}`;
};

// ─── 平台音频代理（网易云 / 酷狗 / QQ 直连 CDN 的地址）────────────────────────
//
// 为什么平台音频也要代理：这些平台返回的 CDN 地址有两个问题在网页版会致命——
//  1. 常常是 http://，而页面是 https，浏览器按混合内容直接拦掉（桌面版由主进程发请求，不受影响）；
//  2. <audio crossOrigin="anonymous">（可视化器要读频谱）要求 CDN 回 CORS 头，多数 CDN 不给。
// 走同源代理后两者都不存在，顺便也带上了平台要求的 Referer。
//
// 与 /media-proxy 的区别：这里的 URL 由渲染端构造，拿不到服务端签发的 token，所以改用
// 域名白名单兜底——只允许音乐平台的 CDN 主机，避免被当成通用代理滥用。
const PLATFORM_AUDIO_HOST_SUFFIXES = [
    '.music.126.net', 'music.126.net',
    '.qqmusic.qq.com', 'qqmusic.qq.com',
    '.gtimg.cn', 'gtimg.cn',
    '.kugou.com', 'kugou.com',
    '.kgimg.com', 'kgimg.com',
    '.migu.cn', '.migumusic.com',
    '.bilibili.com', '.hdslb.com', '.bilivideo.com',
    '.missevan.com', '.missevan.cn',
    '.kuwo.cn', '.bodian.com',
];

const isPlatformAudioHost = (hostname) => PLATFORM_AUDIO_HOST_SUFFIXES.some(
    suffix => hostname === suffix || hostname.endsWith(suffix.startsWith('.') ? suffix : `.${suffix}`),
);

/** 各平台 CDN 需要的 Referer：缺了会被回 403（酷狗、QQ 尤其明显）。 */
const platformRefererFor = (hostname) => {
    if (hostname.endsWith('qqmusic.qq.com') || hostname.endsWith('qq.com')) return 'https://y.qq.com/';
    if (hostname.endsWith('kugou.com') || hostname.endsWith('kgimg.com')) return 'https://www.kugou.com/';
    if (hostname.endsWith('music.126.net') || hostname.endsWith('126.net')) return 'https://music.163.com/';
    if (hostname.endsWith('migu.cn') || hostname.endsWith('migumusic.com')) return 'https://music.migu.cn/';
    if (hostname.endsWith('bilibili.com') || hostname.endsWith('hdslb.com') || hostname.endsWith('bilivideo.com')) return 'https://www.bilibili.com/';
    if (hostname.endsWith('missevan.com')) return 'https://www.missevan.com/';
    return undefined;
};

/** 改写 m3u8：分片行换成代理地址；EXT-X-KEY/EXT-X-MAP 的 URI 也要换，否则加密流取不到密钥。 */
const rewritePlaylist = (text, baseUrl, headers) => text.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (/^#EXT-X-KEY:/.test(trimmed) || /^#EXT-X-MAP:/.test(trimmed)) {
        return line.replace(/URI="([^"]+)"/, (_m, uri) => `URI="${toProxiedUrl(uri, baseUrl, headers)}"`);
    }
    if (trimmed.startsWith('#')) return line;
    return toProxiedUrl(trimmed, baseUrl, headers);
}).join('\n');

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding', 'host']);

// ─── 网易云 API：起一个 express app，挂到 /netease 下 ────────────────────────
const { serveNcmApi } = require('@neteasecloudmusicapienhanced/api/server');
const ncmApp = await serveNcmApi({ port: NCM_PORT, host: '127.0.0.1' });
// serveNcmApi 内部已经 listen 了一次（占住 NCM_PORT）。我们只用它的 app 做挂载，
// 那个多余的监听关掉，避免端口占用与混淆。
ncmApp.server?.close?.();

// ─── 酷狗 / QQ：网页版登录与播放要各自的 API 服务，桌面版是内嵌的 ───────────────
// 两者都在 require/startService 时自己 listen，端口读环境变量，所以先占好端口再启动，
// 之后由 /kugou、/qq 反代过去（与官方 Docker 网关的 proxy_pass 同一思路）。
const KUGOU_PORT = Number(process.env.KUGOU_PORT || 3901);
const QQ_PORT = Number(process.env.QQ_PORT || 3902);

const startKugouApi = async () => {
    try {
        process.env.HOST = '127.0.0.1';
        process.env.PORT = String(KUGOU_PORT);
        const { startService } = require('kugoumusicapi/server');
        const app = await startService();
        if (!app?.service?.listening) await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('酷狗 API 监听超时')), 20000);
            app.service.once('listening', () => { clearTimeout(timer); resolve(); });
            app.service.once('error', (e) => { clearTimeout(timer); reject(e); });
        });
        log(`酷狗 API 就绪 (127.0.0.1:${KUGOU_PORT})`);
    } catch (error) {
        log('酷狗 API 未启动:', error && error.message);
    }
};

const startQqApi = async () => {
    try {
        process.env.PORT = String(QQ_PORT);
        process.env.AUTO_OPEN_EXPLORER = 'false';
        process.env.QQ_DISABLE_UPDATE_CHECK = 'true';
        // require 即监听；包内缓存，只可调用一次。
        const qqApp = require('@yakult-green-tea/qq-music-api');
        const server = qqApp?.server || qqApp;
        if (server && typeof server.listening === 'boolean' && !server.listening) {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('QQ API 监听超时')), 20000);
                server.once('listening', () => { clearTimeout(timer); resolve(); });
                server.once('error', (e) => { clearTimeout(timer); reject(e); });
            });
        }
        log(`QQ API 就绪 (127.0.0.1:${QQ_PORT})`);
    } catch (error) {
        log('QQ API 未启动:', error && error.message);
    }
};

await startKugouApi();
await startQqApi();

/**
 * 把 /<prefix>/* 反代到本机另一个端口的服务。
 *
 * 不直接 mount 那两个 express app：它们各自已经 listen、内部路由是根路径，
 * 反代能保持与官方 Docker 网关（nginx proxy_pass）一致的行为，也不受它们内部
 * 中间件顺序影响。Set-Cookie 逐条转发：登录态就靠它。
 *
 * 注意：用 app.use('/kugou', handler) 挂载时，Express 已经把前缀从 req.url 里剥掉了
 * （req.url 是 '/search?...' 而不是 '/kugou/search?...'），这里直接用即可，不能再剥一次。
 */
const proxyToLocal = (port) => async (req, res) => {
    const targetPath = req.url || '/';
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
            if (HOP_BY_HOP.has(k.toLowerCase()) || k.toLowerCase() === 'accept-encoding') continue;
            headers[k] = Array.isArray(v) ? v.join(', ') : v;
        }
        const upstream = await fetch(`http://127.0.0.1:${port}${targetPath}`, {
            method: req.method,
            headers,
            body: chunks.length ? Buffer.concat(chunks) : undefined,
            redirect: 'manual',
            signal: controller.signal,
        });
        res.status(upstream.status);
        const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
        for (const [k, v] of upstream.headers) {
            if (HOP_BY_HOP.has(k.toLowerCase()) || k.toLowerCase() === 'set-cookie') continue;
            res.set(k, v);
        }
        if (cookies.length) res.setHeader('Set-Cookie', cookies);
        if (!upstream.body) return res.end();
        for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
        return res.end();
    } catch (error) {
        if (!res.headersSent) res.status(502).type('text/plain').send(`upstream failed: ${error && error.message ? error.message : String(error)}`);
        else res.end();
        return undefined;
    }
};

// ─── AI 主题处理器（ESM，Node 风格 (req,res)，Express 可直接挂）──────────────
let generateTheme = null;
let lyricProxy = null;
try { generateTheme = (await import('../../api/generate-theme.js')).default; } catch (e) { log('generate-theme 未加载:', e.message); }
try { lyricProxy = (await import('../../api/lyric-proxy.js')).default; } catch (e) { log('lyric-proxy 未加载:', e.message); }

// ─── 组装 ───────────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// 跨域：浏览器里页面与服务端同源，不需要这个；但打包成 App（Capacitor）后页面 origin 是
// capacitor://localhost，所有 /custom-source、/platform-audio 都成了跨域请求，没有下面这段
// 会被 WKWebView 直接拦掉，表现就是「App 里插件源和平台登录全废」。
// 只对音频与插件接口放行任意来源即可：它们不依赖凭据（凭据走各平台 API 自己的 CORS 回显）。
const ALLOW_CORS_PREFIXES = ['/custom-source', '/platform-audio', '/media-proxy'];
app.use((req, res, next) => {
    if (!ALLOW_CORS_PREFIXES.some(p => req.path === p || req.path.startsWith(`${p}/`))) return next();
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'folia-selfhost' }));

app.get('/runtime-config.js', (_req, res) => {
    res.set('Cache-Control', 'no-store').type('application/javascript')
        .send("window.__FOLIA_RUNTIME_CONFIG__ = { deployment: 'docker' };\n");
});

// 网易云：挂在 /netease 前缀下（实测可通，返回 200）。
// Set-Cookie 不屏蔽：桌面版就是让渲染进程带 credentials 直连本地 API、由浏览器存 cookie 的
// （netease.ts 的 fetchWithCreds），这是已验证可用的路径。官方 Docker 网关屏蔽它是因为那里
// 网关与 API 分离、另有会话处理；我们同进程，照桌面版走。
app.use('/netease', ncmApp);

// 酷狗 / QQ：与官方 Docker 网关的 proxy_pass 同一形态，各自反代到本机端口。
app.use('/kugou', proxyToLocal(KUGOU_PORT));
app.use('/qq', proxyToLocal(QQ_PORT));

// AI 主题与歌词代理（可选）。
if (generateTheme) app.all('/api/generate-theme', express.json({ limit: '4mb' }), generateTheme);
if (lyricProxy) app.all('/api/lyric-proxy', [express.json({ limit: '4mb' }), express.text({ type: ['text/*', 'application/xml'], limit: '4mb' })], lyricProxy);

/**
 * 代理地址要拼成绝对 URL：渲染端多处按 `startsWith('http')` 判断音源形态（媒体缓存、
 * 预取、播放桥），相对路径会被当成 'other' 而整条链失效。协议与主机取自信任的反代头
 * （cloudflared 会带 X-Forwarded-Proto），所以隧道换域名后签出的地址也自然正确。
 */
const publicOrigin = (req) => {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
        || (req.socket.encrypted ? 'https' : 'http');
    const host = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
        || req.headers.host || `127.0.0.1:${PORT}`;
    return `${proto}://${host}`;
};

/**
 * 插件引擎的 HTTP 入口。桌面版走 IPC，网页版走这里，参数与返回形状一致，
 * 所以渲染端只需换传输方式，provider 层不动。
 *
 * 音源地址一律改写成代理地址：浏览器给 <audio> 加不了 Referer，跨源直连又会被 CORS 拦。
 */
app.post('/custom-source', express.json({ limit: '4mb' }), async (req, res) => {
    const { operation, params } = req.body || {};
    const answer = await customSources.request(operation, params);

    if (answer.ok && operation === 'getMediaSource' && answer.data?.url) {
        const original = answer.data.url;
        const headers = customSources.mediaHeaders.headersFor(original) || {};
        answer.data = {
            ...answer.data,
            url: `${publicOrigin(req)}/media-proxy?t=${issueProxy(original, headers)}`,
        };
    }
    res.json(answer);
});

// 音频代理：只认签发过的 token。
//
// Range 必须原样转发：iOS Safari 播音频先要 206 分段，只给 200 全量会让 <audio> 停在
// readyState 0 不出声；Chromium 容忍整段下载，所以桌面测不出这个问题。分片请求也要带上和
// 主清单一样的 Referer/UA，源站按同一套头校验。
app.get('/media-proxy', async (req, res) => {
    const token = String(req.query.t || '');
    const entry = proxyEntries.get(token);
    if (!entry || entry.expiresAt < Date.now()) {
        proxyEntries.delete(token);
        return res.status(403).type('text/plain').send('unknown or expired proxy token');
    }
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
        const upstreamHeaders = { ...entry.headers };
        if (req.headers.range) upstreamHeaders.Range = req.headers.range;
        const upstream = await fetch(entry.url, {
            headers: upstreamHeaders,
            redirect: 'follow',
            signal: controller.signal,
        });
        const contentType = upstream.headers.get('content-type') || '';
        const isPlaylist = /mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(entry.url);

        if (isPlaylist && upstream.ok) {
            const body = rewritePlaylist(await upstream.text(), entry.url, entry.headers);
            return res.status(200).set('Cache-Control', 'no-store').type('application/vnd.apple.mpegurl').send(body);
        }
        res.status(upstream.status);
        for (const [k, v] of upstream.headers) {
            const key = k.toLowerCase();
            // content-length 必须保留：206 分段响应靠它，iOS 也看它。
            if (HOP_BY_HOP.has(key) && key !== 'content-length') continue;
            res.set(k, v);
        }
        res.set('Cache-Control', 'no-store');
        res.set('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
        if (!upstream.body) return res.end();
        for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
        return res.end();
    } catch (error) {
        if (!res.headersSent) res.status(502).type('text/plain').send(`proxy failed: ${error && error.message ? error.message : String(error)}`);
        else res.end();
        return undefined;
    }
});

// 平台音频代理：渲染端把 http:// 或跨源的平台 CDN 地址转到这里取流。
//
// 与 /media-proxy 同样的 Range 处理，区别是 URL 由渲染端给（拿不到服务端签发的 token），
// 因此靠域名白名单兜底，避免变成通用代理。Referer 按平台补，缺了会被 CDN 回 403。
app.get('/platform-audio', async (req, res) => {
    let target;
    try {
        target = new URL(String(req.query.u || ''));
    } catch {
        return res.status(400).type('text/plain').send('bad url');
    }
    if (!/^https?:$/.test(target.protocol) || !isPlatformAudioHost(target.hostname)) {
        return res.status(403).type('text/plain').send('host not allowed');
    }
    const headers = {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    };
    const referer = platformRefererFor(target.hostname);
    if (referer) headers.Referer = referer;
    if (req.headers.range) headers.Range = req.headers.range;

    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
        const upstream = await fetch(target.href, { headers, redirect: 'follow', signal: controller.signal });
        res.status(upstream.status);
        for (const [k, v] of upstream.headers) {
            const key = k.toLowerCase();
            if (HOP_BY_HOP.has(key) && key !== 'content-length') continue;
            res.set(k, v);
        }
        // 同源了，CORS 不再是问题；可视化器读频谱还能用。
        res.set('Cache-Control', 'public, max-age=3600');
        res.set('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
        if (!upstream.body) return res.end();
        for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
        return res.end();
    } catch (error) {
        if (!res.headersSent) res.status(502).type('text/plain').send(`platform audio failed: ${error && error.message ? error.message : String(error)}`);
        else res.end();
        return undefined;
    }
});

// 静态与 SPA 回退（放在所有 API 路由之后）。
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.map': 'application/json', '.webmanifest': 'application/manifest+json',
};

app.use(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/') rel = '/index.html';
    const target = path.join(DIST, rel);
    if (target !== DIST && !target.startsWith(DIST + path.sep)) return res.status(403).type('text/plain').send('forbidden');
    try {
        const info = await stat(target);
        if (info.isDirectory()) throw new Error('dir');
        const buf = await readFile(target);
        const ext = path.extname(target).toLowerCase();
        res.set('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable');
        res.type(MIME[ext] || 'application/octet-stream');
        return res.end(buf);
    } catch {
        try {
            const buf = await readFile(path.join(DIST, 'index.html'));
            res.set('Cache-Control', 'no-cache').type('text/html; charset=utf-8');
            return res.end(buf);
        } catch {
            return res.status(404).type('text/plain').send('dist/index.html 不存在：先跑 npm run build:selfhost');
        }
    }
});

app.listen(PORT, '0.0.0.0', () => {
    log(`监听 0.0.0.0:${PORT}`);
    log(`数据目录 ${DATA_DIR}`);
    log(`已装插件源 ${customSources.registry.list().length} 个`);
});

const shutdown = () => process.exit(0);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
