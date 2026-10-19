// 模拟 CapacitorHttp：fetch 转发到本地代理，由代理带完整请求头发真实请求。
// 插件脚本文本由 Node 预取后注入页面，测试只聚焦插件执行与网络请求两件事。
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import https from 'node:https';

const exe = 'C:\\Users\\34803\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const PAGE = 'http://localhost:5199/test/manual/engine-browser/index.html';
const PROXY_PORT = 5201;
const PLUGIN_URL = 'https://raw.githubusercontent.com/hebijunge/musicfree-plugins/master/plugins/bilibili-source.plugin.v1.1.4.js';
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
        const outHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': '*' };
        for (const [k, v] of upstream.headers) {
            if (/^(content-encoding|content-length|transfer-encoding|connection|access-control-)/i.test(k)) continue;
            outHeaders[k] = v;
        }
        res.writeHead(200, outHeaders);
        res.end(buf);
    } catch (error) {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
        res.end(`PROXY_ERROR:${String(error.message || error).slice(0, 120)}`);
    }
});
await new Promise(r => proxy.listen(PROXY_PORT, '127.0.0.1', r));
console.log(`代理就绪: 127.0.0.1:${PROXY_PORT}`);

const scriptText = await download(PLUGIN_URL);
console.log(`插件脚本已下载: ${(scriptText.length / 1024).toFixed(0)} KB\n`);

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();

await page.addInitScript((port) => {
    const origFetch = window.fetch.bind(window);
    const here = window.location.host;
    window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input.url;
        // 只代理外部域名：页面自身的资源/HMR 请求必须直连，否则开发服务器会崩。
        if (!/^https?:/i.test(url)) return origFetch(input, init);
        try {
            const target = new URL(url, window.location.href);
            if (target.host === here || target.hostname === '127.0.0.1' || target.hostname === 'localhost') {
                return origFetch(input, init);
            }
        } catch { return origFetch(input, init); }

        const headers = {};
        try {
            new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined) || {}).forEach((v, k) => { headers[k] = v; });
        } catch { /* 忽略 */ }
        const resp = await origFetch(`http://127.0.0.1:${port}/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, method: init.method || 'GET', headers, body: init.body ?? undefined }),
        });
        const buf = await resp.arrayBuffer();
        const outHeaders = new Headers();
        resp.headers.forEach((v, k) => { if (!/^x-proxy-/.test(k)) outHeaders.set(k, v); });
        return new Response(buf, { status: Number(resp.headers.get('x-proxy-status') || 200), headers: outHeaders });
    };
}, PROXY_PORT);

const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR ' + String(e.message).slice(0, 180)));
page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 180)); });

await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 40; i++) { if (await page.evaluate(() => Boolean(window.__ready)).catch(() => false)) break; await sleep(500); }
console.log('入口就绪，开始执行（网络走代理，可带 Referer/UA）...\n');

const result = await page.evaluate(async (text) => window.__runEngineTest(text), scriptText);

console.log('=== 结果 ===');
for (const step of result.steps || []) {
    const { name, ...rest } = step;
    console.log(`  ${name}:`, JSON.stringify(rest));
}
console.log('\n总体:', result.ok ? '✓ 通过' : '✗ 失败');

const realErrs = [...new Set(errs)].filter(e => !/Outdated Optimize Dep|404 \(Not Found\)/.test(e));
if (realErrs.length) { console.log('\n错误:'); realErrs.slice(0, 6).forEach(e => console.log('  ' + e)); }

await browser.close();
proxy.close();
