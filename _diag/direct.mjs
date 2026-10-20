// 直接验证：内联后的 bundledSources 能不能装源（不经界面）
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const EXE = 'C:\\Users\\34803\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const DIST = path.resolve('dist');
const PORT = 5330;
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
        if (b) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(b); }
        else { res.writeHead(404); res.end(''); }
    }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage();
const allLogs = [];
page.on('console', m => allLogs.push(`[${m.type()}] ${m.text().slice(0, 220)}`));
page.on('pageerror', e => allLogs.push('PAGEERROR ' + String(e.message).slice(0, 250)));

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
await sleep(18000);   // 给足时间

console.log('=== 所有 CustomSource 相关日志 ===');
const cs = allLogs.filter(l => /CustomSource|bundled|engine/i.test(l));
if (cs.length) cs.slice(0, 20).forEach(l => console.log('  ' + l));
else console.log('  （无）');

console.log('\n=== 页面错误 ===');
const errs = allLogs.filter(l => /PAGEERROR|error/i.test(l));
if (errs.length) errs.slice(0, 10).forEach(l => console.log('  ' + l));
else console.log('  （无）');

console.log('\n=== 总日志条数:', allLogs.length, '===');

await browser.close();
server.close();
