// 多插件验证 v2：代理正确处理二进制请求/响应体（base64），否则插件的魔数校验会失败。
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import https from 'node:https';

const exe = 'C:\\Users\\34803\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const PAGE = 'http://localhost:5199/test/manual/engine-browser/index.html';
const PROXY_PORT = 5203;
const REPO = 'https://raw.githubusercontent.com/hebijunge/musicfree-plugins/master/plugins/';
const PLUGINS = [
    ['bilibili', 'bilibili-source.plugin.v1.1.4.js'],
    ['qishui(汽水)', 'qishui-source.plugin.v1.9.19.js'],
    ['migu(咪咕)', 'migu-source.plugin.v1.9.18.js'],
    ['5sing', '5sing-source.plugin.v1.0.2.js'],
    ['猫耳FM', 'missevan-source.plugin.v1.0.3.js'],
    ['网易云', 'netease-source.plugin.v1.9.22.js'],
    ['千千', 'qianqian-source.plugin.v1.0.4.js'],
    ['一听', '1ting-source.plugin.v1.0.2.js'],
];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const download = (url) => new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'dsh' }, redirect: 'follow' }, (res) => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => resolve(d));
    }).on('error', reject);
});

// 请求体用 base64 传（可能有二进制），响应体也用 base64 回（音频/图片/二进制接口）
const proxy = createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { res.writeHead(400, cors); return res.end('bad json'); }

    const { url, method = 'GET', headers = {}, bodyBase64 } = payload;
    // 浏览器禁止 JS 设置 User-Agent；原生实现（CapacitorHttp / WKWebView）会自带。
    // 这里补一个，模拟真机行为——否则站点会因为缺 UA 拒绝。
    const lower = Object.keys(headers).map(k => k.toLowerCase());
    if (!lower.includes('user-agent')) headers['User-Agent'] = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    try {
        const init = { method, headers, redirect: 'follow', signal: AbortSignal.timeout(30000) };
        if (bodyBase64) init.body = Buffer.from(bodyBase64, 'base64');
        const upstream = await fetch(url, init);
        const buf = Buffer.from(await upstream.arrayBuffer());
        const out = { ...cors, 'x-proxy-status': String(upstream.status), 'content-type': 'application/json' };
        const meta = {};
        for (const [k, v] of upstream.headers) {
            if (/^(content-encoding|content-length|transfer-encoding|connection|content-type)$/i.test(k)) continue;
            meta[k] = v;
        }
        res.writeHead(200, out);
        res.end(JSON.stringify({
            status: upstream.status,
            headers: meta,
            contentType: upstream.headers.get('content-type') || '',
            bodyBase64: buf.toString('base64'),
        }));
    } catch (error) {
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 0, headers: {}, contentType: '', bodyBase64: '', error: String(error.message || error).slice(0, 120) }));
    }
});
await new Promise(r => proxy.listen(PROXY_PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();

await page.addInitScript((port) => {
    const origFetch = window.fetch.bind(window);
    const here = window.location.host;
    const toB64 = (data) => {
        if (data === undefined || data === null) return undefined;
        if (typeof data === 'string') return btoa(unescape(encodeURIComponent(data)));
        if (data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(data);
            let s = '';
            for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
            return btoa(s);
        }
        if (ArrayBuffer.isView(data)) return toB64(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        if (typeof Blob !== 'undefined' && data instanceof Blob) return null; // 由调用方 await 处理
        return btoa(unescape(encodeURIComponent(String(data))));
    };

    window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input.url;
        if (!/^https?:/i.test(url)) return origFetch(input, init);
        try {
            const t = new URL(url, window.location.href);
            if (t.host === here || t.hostname === '127.0.0.1' || t.hostname === 'localhost') return origFetch(input, init);
        } catch { return origFetch(input, init); }

        const headers = {};
        try { new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined) || {}).forEach((v, k) => { headers[k] = v; }); } catch { }

        let bodyBase64;
        if (init.body !== undefined && init.body !== null) {
            if (typeof Blob !== 'undefined' && init.body instanceof Blob) {
                bodyBase64 = toB64(await init.body.arrayBuffer());
            } else {
                bodyBase64 = toB64(init.body);
            }
        }

        const resp = await origFetch(`http://127.0.0.1:${port}/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, method: init.method || 'GET', headers, bodyBase64 }),
        });
        const payload = await resp.json();
        const raw = atob(payload.bodyBase64 || '');
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const outHeaders = new Headers(payload.headers || {});
        if (payload.contentType) outHeaders.set('content-type', payload.contentType);
        return new Response(bytes, { status: payload.status || 200, headers: outHeaders });
    };
}, PROXY_PORT);

await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 40; i++) { if (await page.evaluate(() => Boolean(window.__ready)).catch(() => false)) break; await sleep(500); }

console.log('=== 多插件验证 v2（二进制安全的代理）===\n');
const results = [];
for (const [label, file] of PLUGINS) {
    let text;
    try { text = await download(REPO + file); }
    catch (e) { console.log(`${label.padEnd(14)} 下载失败`); continue; }

    const r = await page.evaluate(async (t) => window.__runEngineTest(t), text);
    const get = (n) => r.steps.find(s => s.name === n) || {};
    const inst = get('安装插件'), search = get('搜索'), audio = get('取音源'), lyric = get('歌词');
    console.log(label);
    console.log(`  搜索: ${search.ok ? `✓ ${search.count} 条` : '✗ ' + JSON.stringify(search.error)}`);
    console.log(`  取链: ${audio.ok ? '✓' : '✗ ' + JSON.stringify(audio.error)}`);
    console.log(`  歌词: ${lyric.ok ? (lyric.hasLrc ? '✓' : '△ 无词') : '✗'}`);
    console.log('');
    results.push({ label, ok: Boolean(search.ok && audio.ok) });
}

console.log('=== 汇总 ===');
results.forEach(r => console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}`));
console.log(`  通过: ${results.filter(r => r.ok).length}/${results.length}`);

await browser.close();
proxy.close();
