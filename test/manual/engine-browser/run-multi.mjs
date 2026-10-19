// 多插件验证：逐个装进浏览器引擎，跑搜索+取音源，看哪些可用。
// 网络经本地代理（模拟 CapacitorHttp 的原生请求，可带 Referer/UA）。
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import https from 'node:https';

const exe = 'C:\\Users\\34803\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const PAGE = 'http://localhost:5199/test/manual/engine-browser/index.html';
const PROXY_PORT = 5202;
const REPO = 'https://raw.githubusercontent.com/hebijunge/musicfree-plugins/master/plugins/';
const PLUGINS = [
    ['bilibili', 'bilibili-source.plugin.v1.1.4.js'],
    ['qishui(汽水)', 'qishui-source.plugin.v1.9.19.js'],
    ['migu(咪咕)', 'migu-source.plugin.v1.9.18.js'],
    ['netease(网易云)', 'netease-source.plugin.v1.9.22.js'],
    ['猫耳FM', 'missevan-source.plugin.v1.0.3.js'],
    ['5sing', '5sing-source.plugin.v1.0.2.js'],
];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const download = (url) => new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'dsh' }, redirect: 'follow' }, (res) => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => resolve(d));
    }).on('error', reject);
});

const proxy = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' });
        return res.end();
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { res.writeHead(400, { 'Access-Control-Allow-Origin': '*' }); return res.end('bad json'); }
    const { url, method = 'GET', headers = {}, body } = payload;
    try {
        const upstream = await fetch(url, { method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(25000) });
        const buf = Buffer.from(await upstream.arrayBuffer());
        const out = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': '*' };
        for (const [k, v] of upstream.headers) {
            if (/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(k)) continue;
            out[k] = v;
        }
        out['x-proxy-status'] = String(upstream.status);
        res.writeHead(200, out);
        res.end(buf);
    } catch (error) {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
        res.end(`PROXY_ERROR:${String(error.message || error).slice(0, 100)}`);
    }
});
await new Promise(r => proxy.listen(PROXY_PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();
await page.addInitScript((port) => {
    const origFetch = window.fetch.bind(window);
    const here = window.location.host;
    window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input.url;
        if (!/^https?:/i.test(url)) return origFetch(input, init);
        try {
            const t = new URL(url, window.location.href);
            if (t.host === here || t.hostname === '127.0.0.1' || t.hostname === 'localhost') return origFetch(input, init);
        } catch { return origFetch(input, init); }
        const headers = {};
        try { new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined) || {}).forEach((v, k) => { headers[k] = v; }); } catch { }
        const resp = await origFetch(`http://127.0.0.1:${port}/`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, method: init.method || 'GET', headers, body: init.body ?? undefined }),
        });
        const buf = await resp.arrayBuffer();
        const outHeaders = new Headers();
        resp.headers.forEach((v, k) => { if (!/^x-proxy-/.test(k)) outHeaders.set(k, v); });
        return new Response(buf, { status: Number(resp.headers.get('x-proxy-status') || 200), headers: outHeaders });
    };
}, PROXY_PORT);

await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 40; i++) { if (await page.evaluate(() => Boolean(window.__ready)).catch(() => false)) break; await sleep(500); }

console.log('=== 多插件验证（真浏览器 + 代理模拟原生请求）===\n');
const results = [];
for (const [label, file] of PLUGINS) {
    let text;
    try { text = await download(REPO + file); }
    catch (e) { console.log(`${label.padEnd(16)} 下载失败: ${e.message.slice(0, 40)}`); continue; }

    const r = await page.evaluate(async (t) => window.__runEngineTest(t), text);
    const get = (name) => r.steps.find(s => s.name === name) || {};
    const inst = get('安装插件');
    const search = get('搜索');
    const audio = get('取音源');
    const lyric = get('歌词');

    console.log(`${label}`);
    console.log(`  安装: ${inst.ok ? '✓ ' + inst.platform : '✗ ' + JSON.stringify(inst.error)}`);
    console.log(`  搜索: ${search.ok ? `✓ ${search.count} 条` : '✗ ' + JSON.stringify(search.error)}`);
    console.log(`  取链: ${audio.ok ? '✓ ' + String(audio.url).slice(0, 55) : '✗ ' + JSON.stringify(audio.error)}`);
    console.log(`  歌词: ${lyric.ok ? (lyric.hasLrc ? `✓ ${lyric.length} 字符` : '△ 无词') : '✗ ' + JSON.stringify(lyric.error)}`);
    console.log('');
    results.push({ label, ok: Boolean(search.ok && audio.ok) });
}

console.log('=== 汇总 ===');
const pass = results.filter(r => r.ok).length;
console.log(`  搜索+取链都通过: ${pass}/${results.length}`);
results.forEach(r => console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}`));

await browser.close();
proxy.close();
