// 端到端 v3：先把界面恢复到首页（Escape 关浮层），再走完整用户流程，每步截图。
import fs from 'node:fs';

const PORT = '9226';

const getMain = async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT}/json`);
    return (await resp.json()).find((t) => t.type === 'page' && t.url.includes('app.asar'));
};

const makeClient = (wsUrl) => {
    const ws = new WebSocket(wsUrl);
    const ready = new Promise((r) => { ws.onopen = r; });
    let seq = 0;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => reject(new Error(method + ' 超时')), 30000);
        const handler = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.id === id) {
                clearTimeout(timer);
                ws.removeEventListener('message', handler);
                msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
            }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        return r.result?.value;
    };
    const shot = async (file) => {
        const r = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    };
    const esc = async () => {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    };
    return { ws, ready, send, evaluate, shot, esc };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const page = await getMain();
    const c = makeClient(page.webSocketDebuggerUrl);
    await c.ready;

    // 0. 连按 Escape 关闭搜索等浮层，回到首页
    for (let i = 0; i < 4; i++) { await c.esc(); await sleep(600); }
    await sleep(1500);
    await c.shot('_e2e-00-home.png');
    console.log('0. 已回到首页');

    // 1. 点右侧栏头像（用 aria-label 更可靠）
    const avatarClicked = await c.evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')];
        // 头像按钮：包含 img，位于右侧栏中下区域
        const candidates = btns.filter(b => {
            const r = b.getBoundingClientRect();
            const inRightRail = r.x > window.innerWidth * 0.42 && r.x < window.innerWidth * 0.60 && r.y > window.innerHeight * 0.55;
            return inRightRail && (b.querySelector('img') || (b.innerText || '').trim() === 'E');
        });
        if (!candidates.length) return 'no avatar; rail buttons: ' + btns.filter(b => { const r = b.getBoundingClientRect(); return r.x > window.innerWidth * 0.42 && r.x < window.innerWidth * 0.60 && r.y > window.innerHeight * 0.55; }).map(b => (b.getAttribute('aria-label') || b.innerText || '?').trim().split('\\n')[0]).join('|');
        candidates[0].click();
        return 'clicked avatar candidate: ' + (candidates[0].getAttribute('aria-label') || candidates[0].innerText || 'img').trim().slice(0, 20);
    })()`);
    console.log('1.', avatarClicked);
    await sleep(2500);
    await c.shot('_e2e-01-switcher.png');

    // 2. 在切换器里点 bilibili 行
    const rowClicked = await c.evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const row = btns.find(b => /^bilibili/.test((b.innerText || '').trim()));
        if (!row) return 'bilibili row not found';
        row.click();
        return 'clicked bilibili row';
    })()`);
    console.log('2.', rowClicked);
    await sleep(1500);
    await c.shot('_e2e-02-chosen.png');

    // 3. 点「切换至」
    const switchResult = await c.evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const sw = btns.find(b => (b.innerText || '').includes('切换至'));
        if (!sw) {
            const visible = [...new Set(btns.filter(b => b.offsetParent).map(b => (b.innerText || '').trim().split('\\n')[0]).filter(Boolean))];
            return 'no 切换至 button. 可见: ' + visible.slice(0, 12).join(' | ');
        }
        const label = sw.innerText.trim();
        sw.click();
        return 'clicked: ' + label;
    })()`);
    console.log('3.', switchResult);
    await sleep(3000);
    await c.shot('_e2e-03-after-switch.png');

    // 4. 关切换器
    for (let i = 0; i < 3; i++) { await c.esc(); await sleep(500); }

    // 5. 开搜索，读源标签
    await c.evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const search = btns.find(b => (b.getAttribute('aria-label') || '').includes('搜索'));
        if (search) search.click();
    })()`);
    await sleep(2000);
    const tabs = await c.evaluate(`(() => {
        const navs = [...document.querySelectorAll('nav')];
        for (const nav of navs.reverse()) {
            const btns = [...nav.querySelectorAll('button')].map(b => b.innerText.trim());
            if (btns.length) return JSON.stringify(btns);
        }
        return 'no tabs found';
    })()`);
    console.log('5. 搜索源标签:', tabs);
    await c.shot('_e2e-04-search-tabs.png');

    // 6. 输入搜索
    await c.evaluate(`(() => {
        const input = document.querySelector('input');
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '晴天');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(8000);
    const results = await c.evaluate(`(() => {
        const lines = document.body.innerText.split('\\n').filter(l => l.includes('晴天'));
        return JSON.stringify({ 含晴天行数: lines.length, 示例: lines.slice(0, 8) });
    })()`);
    console.log('6. 搜索结果:', results);
    await c.shot('_e2e-05-results.png');

    c.ws.close();
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
