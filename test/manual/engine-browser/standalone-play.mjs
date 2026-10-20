// 独立构建的搜索+播放验证：走真实界面，确认插件能搜能播。
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const EXE = 'C:\\Users\\34803\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const DIST = path.resolve('dist');
const PORT = 5310;
const PROXY = 5311;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    try {
        const f = path.join(DIST, p);
        const body = await readFile(f);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
        res.end(body);
    } catch {
        const body = await readFile(path.join(DIST, 'index.html')).catch(() => null);
        if (body) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); }
        else { res.writeHead(404); res.end('404'); }
    }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const proxy = createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let p;
    try { p = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { res.writeHead(400, cors); return res.end('bad'); }
    const { url, method = 'GET', headers = {}, bodyBase64 } = p;
    const lower = Object.keys(headers).map(k => k.toLowerCase());
    if (!lower.includes('user-agent')) headers['User-Agent'] = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
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
        res.end(JSON.stringify({ status: 0, headers: {}, contentType: '', bodyBase64: '', error: String(e.message || e).slice(0, 100) }));
    }
});
await new Promise(r => proxy.listen(PROXY, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage();
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
        try { if (new URL(url, location.href).host === here) return of(input, init); } catch { return of(input, init); }
        const headers = {};
        try { new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined) || {}).forEach((v, k) => { headers[k] = v; }); } catch { }
        let bodyBase64;
        if (init.body != null) {
            if (typeof Blob !== 'undefined' && init.body instanceof Blob) bodyBase64 = b64(await init.body.arrayBuffer());
            else bodyBase64 = b64(init.body);
        }
        const r = await of(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, method: init.method || 'GET', headers, bodyBase64 }) });
        const j = await r.json();
        const raw = atob(j.bodyBase64 || '');
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const oh = new Headers(j.headers || {});
        if (j.contentType) oh.set('content-type', j.contentType);
        return new Response(bytes, { status: j.status || 200, headers: oh });
    };
}, PROXY);

const errs = [];
page.on('pageerror', e => errs.push(String(e.message).slice(0, 130)));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#root > *', { timeout: 90000 });
await sleep(14000);   // 等内置源装完

// 打开搜索
await page.evaluate(() => { [...document.querySelectorAll('button')].find(x => /搜索/.test(x.getAttribute('aria-label') || ''))?.click(); });
await sleep(2500);
await page.evaluate(() => {
    const i = [...document.querySelectorAll('input')].find(x => (x.placeholder || '').includes('搜索'));
    if (!i) return;
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(i, '晴天 周杰伦');
    i.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(500);
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim() === '搜索')?.click(); });

let tabs = [];
for (let i = 0; i < 30; i++) {
    await sleep(1000);
    tabs = await page.evaluate(() => {
        const nav = [...document.querySelectorAll('nav')].pop();
        return nav ? [...nav.querySelectorAll('button')].map(b => b.innerText.trim()) : [];
    });
    if (tabs.length) break;
}
console.log('=== 搜索标签列 ===');
console.log('  ' + (tabs.join(' | ') || '(空)'));

// 切到 bilibili 并播放
const clicked = await page.evaluate(() => {
    const nav = [...document.querySelectorAll('nav')].pop();
    const b = [...nav.querySelectorAll('button')].find(x => /bilibili/i.test(x.innerText));
    if (!b) return false;
    b.click();
    return true;
});
console.log('\n切到 bilibili:', clicked);
await sleep(11000);

const count = await page.locator('button[aria-label="播放歌曲"]').count();
console.log('搜索结果数:', count);

if (count) {
    await page.locator('button[aria-label="播放歌曲"]').first().click({ timeout: 15000 }).catch(() => {});
    let playing = null;
    for (let i = 0; i < 40; i++) {
        await sleep(1000);
        playing = await page.evaluate(() => {
            const a = [...document.querySelectorAll('audio')].find(x => x.currentSrc);
            return a ? { cur: Math.round(a.currentTime * 10) / 10, paused: a.paused, rs: a.readyState, dur: Math.round(a.duration || 0) } : null;
        });
        if (playing && !playing.paused && playing.cur > 0.5) break;
    }
    console.log('\n=== 播放状态 ===');
    console.log('  ' + JSON.stringify(playing));
    if (playing && !playing.paused && playing.cur > 0.5) {
        const t0 = playing.cur;
        await sleep(5000);
        const t1 = await page.evaluate(() => { const a = [...document.querySelectorAll('audio')].find(x => x.currentSrc); return a ? Math.round(a.currentTime * 10) / 10 : -1; });
        console.log(`  进度 ${t0} → ${t1}s: ${t1 > t0 ? '✓ 真的在播' : '✗ 卡住'}`);
    }
}

if (errs.length) { console.log('\n错误:'); [...new Set(errs)].slice(0, 5).forEach(e => console.log('  ' + e)); }
await browser.close();
server.close();
proxy.close();
