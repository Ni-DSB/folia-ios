// 通过 Vite 模块系统直接检查 provider 注册表状态
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const EXE = 'C:\\Users\\34803\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const DIST = path.resolve('dist');
const PORT = 5370;
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
await sleep(18000);

// 打开搜索面板，读标签
await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /搜索/.test(x.getAttribute('aria-label') || ''));
    b?.click();
});
await sleep(3000);

const tabs = await page.evaluate(() => {
    const nav = [...document.querySelectorAll('nav')].pop();
    return nav ? [...nav.querySelectorAll('button')].map(b => b.innerText.trim()) : [];
});
console.log('=== 打开搜索后的标签 ===');
console.log('  ' + (tabs.join(' | ') || '(空)'));

// 触发一次强制重同步，看标签是否变化
const resynced = await page.evaluate(async () => {
    try {
        const mod = await import('/assets/customSourceRegistry-CrQw-745.js').catch(() => null);
        return { note: 'chunk 名不固定，无法直接 import' };
    } catch (e) { return { error: String(e.message).slice(0, 100) }; }
});
console.log('\n重同步尝试:', JSON.stringify(resynced));

await sleep(3000);
const tabs2 = await page.evaluate(() => {
    const nav = [...document.querySelectorAll('nav')].pop();
    return nav ? [...nav.querySelectorAll('button')].map(b => b.innerText.trim()) : [];
});
console.log('重同步后标签:', tabs2.join(' | ') || '(空)');

await browser.close();
server.close();
