// 直接查运行时的 provider 注册状态（不经界面）
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const EXE = 'C:\\Users\\34803\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const DIST = path.resolve('dist');
const PORT = 5350;
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

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage();
await page.addInitScript(() => {
    try {
        localStorage.setItem('library_suite_prompt_seen', 'true');
        localStorage.setItem('playback_entry_view_chosen', 'true');
        localStorage.setItem('folia_last_seen_guide_version', '0.7.21');
        localStorage.setItem('folia_last_seen_ponder_onboarding_version', '0.7.21');
    } catch { }
});

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#root > *', { timeout: 90000 });
await sleep(20000);

// 从页面里取 omni 的 provider 列表（通过 window 上暴露的调试接口，若没有就用 IndexedDB 判断）
const info = await page.evaluate(async () => {
    // 1. IndexedDB 里到底存了什么
    const dbs = await indexedDB.databases?.() ?? [];
    const dbNames = dbs.map(d => d.name);
    let stored = [];
    try {
        const db = await new Promise((resolve, reject) => {
            const r = indexedDB.open('folia-custom-sources');
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
        stored = await new Promise((resolve) => {
            const tx = db.transaction('sources', 'readonly');
            const req = tx.objectStore('sources').getAll();
            req.onsuccess = () => resolve((req.result || []).map(x => ({ platform: x.platform, scriptLen: (x.script || '').length })));
            req.onerror = () => resolve([]);
        });
        db.close();
    } catch (e) { stored = [{ error: String(e.message) }]; }

    // 2. 搜索标签（界面能看到的）
    const nav = [...document.querySelectorAll('nav')].pop();
    const tabs = nav ? [...nav.querySelectorAll('button')].map(b => b.innerText.trim()) : [];

    return { dbNames, stored, tabs };
});

console.log('=== IndexedDB ===');
console.log('  数据库:', JSON.stringify(info.dbNames));
console.log('  sources 表:', info.stored.length, '条');
info.stored.slice(0, 12).forEach(s => console.log(`    ${s.platform}  script ${s.scriptLen || 0} 字节`));

console.log('\n=== 当前搜索标签 ===');
console.log('  ' + (info.tabs.join(' | ') || '(空)'));

await browser.close();
server.close();
