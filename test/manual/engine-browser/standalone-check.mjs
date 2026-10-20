// 模拟独立 App：用真实 dist 产物 + Capacitor 式原生请求，验证插件能否搜索/播放。
// 这是装到手机前最接近真机的验证。
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const EXE = 'C:\\Users\\34803\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const DIST = path.resolve('dist');
const PORT = 5300;
const PROXY = 5301;

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

// 静态服务 dist
const server = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    try {
        const file = path.join(DIST, p);
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(body);
    } catch {
        try {
            const body = await readFile(path.join(DIST, 'index.html'));
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(body);
        } catch { res.writeHead(404); res.end('404'); }
    }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

// 原生请求代理（模拟 CapacitorHttp）
const proxy = createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { res.writeHead(400, cors); return res.end('bad'); }
    const { url, method = 'GET', headers = {}, bodyBase64 } = payload;
    if (!headers['User-Agent'] && !headers['user-agent']) {
        headers['User-Agent'] = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    }
    try {
        const init = { method, headers, redirect: 'follow', signal: AbortSignal.timeout(30000) };
        if (bodyBase64) init.body = Buffer.from(bodyBase64, 'base64');
        const up = await fetch(url, init);
        const buf = Buffer.from(await up.arrayBuffer());
        const meta = {};
        for (const [k, v] of up.headers) if (!/^(content-encoding|content-length|transfer-encoding|connection|content-type|access-control-)/i.test(k)) meta[k] = v;
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: up.status, headers: meta, contentType: up.headers.get('content-type') || '', bodyBase64: buf.toString('base64') }));
    } catch (e) {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 0, headers: {}, contentType: '', bodyBase64: '', error: String(e.message || e).slice(0, 120) }));
    }
});
await new Promise(r => proxy.listen(PROXY, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage();
const logs = [];
page.on('console', m => { const t = m.text(); if (/CustomSource|引擎|内置|error/i.test(t)) logs.push(`[${m.type()}] ${t.slice(0, 180)}`); });
page.on('pageerror', e => logs.push('PAGEERROR ' + String(e.message).slice(0, 160)));

// 注入原生请求垫片（只在页面脚本跑之前）
await page.addInitScript((port) => {
    const of = window.fetch.bind(window);
    const here = window.location.host;
    const b64 = (d) => {
        if (d == null) return undefined;
        if (typeof d === 'string') return btoa(unescape(encodeURIComponent(d)));
        if (d instanceof ArrayBuffer) { const b = new Uint8Array(d); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
        if (ArrayBuffer.isView(d)) return b64(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
        return btoa(unescape(encodeURIComponent(String(d))));
    };
    window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input.url;
        if (!/^https?:/i.test(url)) return of(input, init);
        try {
            const t = new URL(url, location.href);
            if (t.host === here) return of(input, init);
        } catch { return of(input, init); }
        const headers = {};
        try { new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined) || {}).forEach((v, k) => { headers[k] = v; }); } catch { }
        let bodyBase64;
        if (init.body != null) {
            if (typeof Blob !== 'undefined' && init.body instanceof Blob) bodyBase64 = b64(await init.body.arrayBuffer());
            else bodyBase64 = b64(init.body);
        }
        const r = await of(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, method: init.method || 'GET', headers, bodyBase64 }) });
        const p = await r.json();
        const raw = atob(p.bodyBase64 || '');
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const oh = new Headers(p.headers || {});
        if (p.contentType) oh.set('content-type', p.contentType);
        return new Response(bytes, { status: p.status || 200, headers: oh });
    };
}, PROXY);

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#root > *', { timeout: 90000 });
await page.waitForTimeout(12000);   // 等内置源安装

// 直接查引擎状态
const engineState = await page.evaluate(async () => {
    try {
        const mod = await import('/assets/customSourceRegistry-CrQw-745.js').catch(() => null);
        return { note: '无法直接 import，改用界面检查' };
    } catch (e) { return { error: String(e.message).slice(0, 100) }; }
});

// 读界面：设置页里的自定义音源
await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /设置|Settings/i.test(x.getAttribute('aria-label') || ''));
    b?.click();
});
await page.waitForTimeout(2500);
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b => /连接与集成|Connections/i.test(b.innerText))?.click(); });
await page.waitForTimeout(6000);

const block = await page.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, ' ');
    const i = t.search(/自定义音源|Custom sources/);
    return i >= 0 ? t.slice(i, i + 500) : '(未找到自定义音源区块)';
});
console.log('=== 设置页自定义音源 ===');
console.log(block.slice(0, 450));

console.log('\n=== 控制台 ===');
[...new Set(logs)].slice(0, 12).forEach(l => console.log('  ' + l));

await page.screenshot({ path: 'deploy/ios/_standalone-check.png', fullPage: false });
await browser.close();
server.close();
proxy.close();
