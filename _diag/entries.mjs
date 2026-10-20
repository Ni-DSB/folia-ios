// 直接调引擎的 list，看返回的 entry 是否 enabled / 有无 error
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const EXE = 'C:\\Users\\34803\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const DIST = path.resolve('dist');
const PORT = 5360;
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
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`));

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

// 找注册表版本 / provider 列表：通过全局 omni
const info = await page.evaluate(async () => {
    // 尝试从模块系统拿 omni（Vite 打包后没有全局，改用界面推断 + IndexedDB 校验）
    const nav = [...document.querySelectorAll('nav')].pop();
    const tabs = nav ? [...nav.querySelectorAll('button')].map(b => b.innerText.trim()) : [];

    // 读 IndexedDB 的完整记录
    let rows = [];
    try {
        const db = await new Promise((res, rej) => {
            const r = indexedDB.open('folia-custom-sources');
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
        rows = await new Promise((resolve) => {
            const tx = db.transaction('sources', 'readonly');
            const req = tx.objectStore('sources').getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
        db.close();
    } catch { }

    return {
        tabs,
        rows: rows.map(r => ({
            platform: r.platform,
            enabled: r.enabled,
            hasScript: Boolean(r.script),
            scriptLen: (r.script || '').length,
            updatedAt: r.updatedAt,
        })),
    };
});

console.log('=== IndexedDB 记录详情 ===');
info.rows.forEach(r => console.log(`  ${String(r.platform).padEnd(10)} enabled=${r.enabled}  script=${r.scriptLen}B`));

console.log('\n=== 搜索标签 ===');
console.log('  ' + (info.tabs.join(' | ') || '(空)'));

console.log('\n=== 全部日志（含 warn/error）===');
logs.slice(0, 40).forEach(l => console.log('  ' + l));

console.log('\n=== 引擎日志 ===');
const cs = logs.filter(l => /CustomSource/.test(l));
cs.slice(0, 12).forEach(l => console.log('  ' + l));
const others = logs.filter(l => /OnlineMusic|registering custom|failed/i.test(l));
if (others.length) { console.log('\n=== 其他相关 ==='); others.slice(0, 8).forEach(l => console.log('  ' + l)); }

await browser.close();
server.close();
