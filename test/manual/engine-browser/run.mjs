// 在真 Chromium 里验证浏览器版插件引擎。
// --disable-web-security 模拟 CapacitorHttp：原生请求不受 CORS 约束。
import { chromium } from 'playwright';

const exe = 'C:\\Users\\34803\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const URL = 'http://localhost:5199/test/manual/engine-browser/index.html';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({
    executablePath: exe,
    args: ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process'],
});
const page = await browser.newPage();

const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR ' + String(e.message).slice(0, 200)));
page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 200)); });

await page.goto(URL, { waitUntil: 'domcontentloaded' });

// 等入口脚本挂上测试函数
let ready = false;
for (let i = 0; i < 40; i++) {
    ready = await page.evaluate(() => Boolean(window.__ready)).catch(() => false);
    if (ready) break;
    await sleep(500);
}
console.log('入口就绪:', ready);
if (!ready) {
    console.log('页面内容:', await page.evaluate(() => document.body.innerText.slice(0, 400)));
    console.log('错误:', errs.slice(0, 5).join('\n'));
    await browser.close();
    process.exit(1);
}

console.log('开始执行引擎测试（含真实网络请求，可能要 1-2 分钟）...\n');
const result = await page.evaluate(async () => {
    const r = await window.__runEngineTest();
    return r;
});

console.log('=== 测试结果 ===');
for (const step of result.steps || []) {
    const { name, ...rest } = step;
    console.log(`  ${name}:`, JSON.stringify(rest));
}
console.log('\n总体:', result.ok ? '✓ 通过' : '✗ 失败');

if (errs.length) {
    console.log('\n浏览器错误（前 8 条）:');
    [...new Set(errs)].slice(0, 8).forEach(e => console.log('  ' + e));
}

await browser.close();
