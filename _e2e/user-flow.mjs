// 端到端：模拟用户完整流程——点头像开切换器 → 点 bilibili 行 → 点「切换至」→
// 关窗 → 开搜索 → 输入 → 提交 → 读结果 + 截图。每一步都验证中间状态。
import fs from 'node:fs';

const PORT = '9226';

const getPageTarget = async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT}/json`);
    return (await resp.json()).find((t) => t.type === 'page' && t.url.startsWith('file://'));
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
    return { ws, ready, send, evaluate, shot };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const page = await getPageTarget();
    const c = makeClient(page.webSocketDebuggerUrl);
    await c.ready;

    // 0. 记录初始激活源
    const before = await c.evaluate("window.electron?.getSettings ? 'bridge-ok' : 'no-bridge'");
    console.log('桥:', before);

    // 读 store 里的 activeProviderId（通过 React DevTools hook 不现实，用 DOM 上的切换器推断）
    // 直接走 UI：1. 点右侧栏头像
    const avatarClicked = await c.evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const avatar = btns.find(b => {
            const r = b.getBoundingClientRect();
            return b.querySelector('img') && r.y > window.innerHeight * 0.6 && r.x > window.innerWidth * 0.44 && r.x < window.innerWidth * 0.56;
        });
        if (!avatar) return 'avatar not found';
        avatar.click();
        return 'avatar clicked';
    })()`);
    console.log('1.', avatarClicked);
    await sleep(2000);

    // 2. 点 bilibili 行
    const rowClicked = await c.evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const row = btns.find(b => (b.innerText || '').includes('bilibili'));
        if (!row) return 'bilibili row not found';
        row.click();
        return 'bilibili row clicked';
    })()`);
    console.log('2.', rowClicked);
    await sleep(1500);
    await c.shot('_e2e-01-chosen.png');

    // 3. 右侧面板应有「切换至 bilibili」按钮
    const switchClicked = await c.evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const sw = btns.find(b => (b.innerText || '').includes('切换至'));
        if (!sw) return 'switch button not found; buttons: ' + btns.filter(b=>b.offsetParent).map(b=>(b.innerText||'').trim()).filter(Boolean).slice(0,15).join(' | ');
        const label = sw.innerText.trim();
        sw.click();
        return 'clicked: ' + label;
    })()`);
    console.log('3.', switchClicked);
    await sleep(2500);
    await c.shot('_e2e-02-switched.png');

    // 4. 关窗（点 X 或按 Escape）
    await c.evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const close = btns.find(b => b.getAttribute('aria-label')?.includes('close') || b.getAttribute('aria-label')?.includes('关闭'));
        if (close) { close.click(); return 'closed'; }
        return 'no close button, trying Escape';
    })()`);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(1500);

    // 5. 点搜索按钮
    const searchOpened = await c.evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const search = btns.find(b => (b.getAttribute('aria-label') || '').includes('搜索'));
        if (!search) return 'search button not found';
        search.click();
        return 'search opened';
    })()`);
    console.log('4.', searchOpened);
    await sleep(2000);

    // 6. 看搜索界面的源标签
    const tabs = await c.evaluate(`(() => {
        const nav = document.querySelector('nav');
        if (!nav) return 'no nav';
        return JSON.stringify([...nav.querySelectorAll('button')].map(b => b.innerText.trim()));
    })()`);
    console.log('5. 搜索界面的源标签:', tabs);
    await c.shot('_e2e-03-search-tabs.png');

    // 7. 输入并搜索
    const typed = await c.evaluate(`(() => {
        const input = document.querySelector('input');
        if (!input) return 'no input';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '晴天');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return 'typed: ' + input.value;
    })()`);
    console.log('6.', typed);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(6000);

    // 8. 读结果
    const results = await c.evaluate(`(() => {
        const body = document.body.innerText;
        const hasQingtian = body.includes('晴天');
        const rows = document.querySelectorAll('[class*=result] , [class*=track], li').length;
        // 找歌名行
        const titles = [];
        document.querySelectorAll('div,li').forEach(el => {
            const t = (el.innerText || '').split('\\n')[0];
            if (t && t.length > 2 && t.length < 40 && t.includes('晴天') && !t.includes('搜索')) titles.push(t);
        });
        return JSON.stringify({ hasQingtian, sampleTitles: [...new Set(titles)].slice(0, 8) });
    })()`);
    console.log('7. 搜索结果:', results);
    await c.shot('_e2e-04-results.png');

    c.ws.close();
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
