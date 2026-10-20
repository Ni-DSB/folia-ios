// 完整链路：独立构建 + 内联源 → 搜索 → 播放（真浏览器 + 原生请求模拟）
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const EXE = 'C:\\Users\\34803\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const DIST = path.resolve('dist');
const PORT = 5340, PROXY = 5341;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    try {
        const f = path.join(DIST, p);
        const b = await readFile(f);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
        res.end(b);
    } catch {
        const b = await readFile(path.join(DIST, 'index.html')).catch(() => null);
        if (b) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(b); } else { res.writeHead(404); res.end(''); }
    }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const proxyHits = [];
const proxy = createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let p; try { p = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { res.writeHead(400, cors); return res.end('bad'); }
    const { url, method = 'GET', headers = {}, bodyBase64 } = p;
    const lower = Object.keys(headers).map(k => k.toLowerCase());
    if (!lower.includes('user-agent')) headers['User-Agent'] = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    try {
        const init = { method, headers, redirect: 'follow', signal: AbortSignal.timeout(30000) };
        if (bodyBase64) init.body = Buffer.from(bodyBase64, 'base64');
        const up = await fetch(url, init);
        const buf = Buffer.from(await up.arrayBuffer());
        proxyHits.push(`${up.status} ${buf.length}B ${url.slice(0, 60)}`);
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
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text().slice(0, 180)}`));
page.on('pageerror', e => logs.push('PAGEERROR ' + String(e.message).slice(0, 200)));

await page.addInitScript(() => {
    try {
        localStorage.setItem('library_suite_prompt_seen', 'true');
        localStorage.setItem('playback_entry_view_chosen', 'true');
        localStorage.setItem('folia_last_seen_guide_version', '0.7.21');
        localStorage.setItem('folia_last_seen_ponder_onboarding_version', '0.7.21');
    } catch { }
});
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

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#root > *', { timeout: 90000 });
await sleep(16000);

// 直接调引擎，绕开界面操作的不确定性
console.log('=== 内置源是否装上 ===');
const installed = await page.evaluate(() => {
    const t = document.body.innerText;
    return { hasBilibili: /bilibili/i.test(t) };
});
console.log('  页面文字含 bilibili:', installed.hasBilibili);

// 打开搜索并搜索
await page.evaluate(() => { [...document.querySelectorAll('button')].find(x => /搜索/.test(x.getAttribute('aria-label') || ''))?.click(); });
await sleep(2500);
await page.evaluate(() => {
    const i = [...document.querySelectorAll('input')].find(x => (x.placeholder || '').includes('搜索'));
    if (!i) return;
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(i, '晴天 周杰伦');
    i.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(600);
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim() === '搜索')?.click(); });

let tabs = [];
for (let i = 0; i < 30; i++) {
    await sleep(1000);
    tabs = await page.evaluate(() => {
        const nav = [...document.querySelectorAll('nav')].pop();
        return nav ? [...nav.querySelectorAll('button')].map(b => b.innerText.trim()) : [];
    });
    if (tabs.length > 1) break;
}
console.log('\n=== 搜索标签 ===');
console.log('  ' + (tabs.join(' | ') || '(空)'));

if (!tabs.some(t => /bilibili/i.test(t))) {
    console.log('\n✗ 没有 bilibili 标签，无法继续');
    console.log('引擎日志:');
    [...new Set(logs)].filter(l => /CustomSource/.test(l)).slice(0, 8).forEach(l => console.log('  ' + l));
    await browser.close(); server.close(); proxy.close();
    process.exit(0);
}

await page.evaluate(() => { const n = [...document.querySelectorAll('nav')].pop(); [...n.querySelectorAll('button')].find(b => /bilibili/i.test(b.innerText))?.click(); });
await sleep(11000);

const count = await page.locator('button[aria-label="播放歌曲"]').count();
console.log('\n搜索结果:', count);
console.log('\n=== 引擎/网络日志 ===');
[...new Set(logs)].filter(l => /CustomSource|bilibili|search|发/i.test(l)).slice(0, 12).forEach(l => console.log('  ' + l));
console.log('代理请求数:', proxyHits.length);
proxyHits.slice(-6).forEach(h => console.log('  ' + h));

if (count) {
    await page.locator('button[aria-label="播放歌曲"]').first().click({ timeout: 15000 }).catch(() => { });
    let st = null;
    for (let i = 0; i < 40; i++) {
        await sleep(1000);
        st = await page.evaluate(() => {
            const a = [...document.querySelectorAll('audio')].find(x => x.currentSrc);
            return a ? { cur: Math.round(a.currentTime * 10) / 10, paused: a.paused, rs: a.readyState, dur: Math.round(a.duration || 0) } : null;
        });
        if (st && !st.paused && st.cur > 0.5) break;
    }
    console.log('\n=== 播放 ===');
    console.log('  ' + JSON.stringify(st));
    if (st && !st.paused) {
        const t0 = st.cur;
        await sleep(5000);
        const t1 = await page.evaluate(() => { const a = [...document.querySelectorAll('audio')].find(x => x.currentSrc); return a ? Math.round(a.currentTime * 10) / 10 : -1; });
        console.log(`  进度 ${t0} → ${t1}s: ${t1 > t0 ? '✓ 在播' : '✗ 卡住'}`);
        console.log('\n  代理请求:');
        proxyHits.slice(-4).forEach(h => console.log('    ' + h));
    }
}

await browser.close(); server.close(); proxy.close();
