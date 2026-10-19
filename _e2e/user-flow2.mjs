// 端到端 v2：登录切换器是独立窗口。枚举所有 target，连到登录窗口完成切换，
// 再回主窗口验证搜索界面的源标签跟着变。
import fs from 'node:fs';

const PORT = '9226';

const getTargets = async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT}/json`);
    return (await resp.json()).filter((t) => t.type === 'page');
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
    let targets = await getTargets();
    console.log('当前窗口:');
    targets.forEach((t) => console.log('  -', t.title, '|', t.url.slice(0, 80)));

    // 找主窗口
    const main = targets.find((t) => t.url.includes('app.asar') && !t.url.includes('login'));
    const cm = makeClient(main.webSocketDebuggerUrl);
    await cm.ready;

    // 若登录窗口没开，从主窗口点开头像
    let loginTarget = targets.find((t) => /login/i.test(t.url));
    if (!loginTarget) {
        await cm.evaluate(`(() => {
            const btns = [...document.querySelectorAll('button')];
            const avatar = btns.find(b => {
                const r = b.getBoundingClientRect();
                return b.querySelector('img') && r.y > window.innerHeight * 0.6 && r.x > window.innerWidth * 0.44 && r.x < window.innerWidth * 0.56;
            });
            if (avatar) avatar.click();
        })()`);
        await sleep(3000);
        targets = await getTargets();
        loginTarget = targets.find((t) => /login/i.test(t.url));
        console.log('\n重开登录窗口:', loginTarget ? loginTarget.url.slice(0, 80) : '仍未找到');
    }

    if (!loginTarget) {
        console.log('登录窗口找不到，列出全部 target:');
        targets.forEach((t) => console.log('  -', t.url.slice(0, 100)));
        cm.ws.close();
        return;
    }

    // 连登录窗口
    const cl = makeClient(loginTarget.webSocketDebuggerUrl);
    await cl.ready;
    await sleep(1000);

    // 1. 在登录窗口里点 bilibili 行
    const rowClicked = await cl.evaluate(`(() => {
        const all = [...document.querySelectorAll('button, [role=button], div[class*=cursor-pointer], li')];
        const row = all.find(b => /^bilibili/.test((b.innerText || '').trim()));
        if (!row) {
            const texts = [...new Set(all.map(b => (b.innerText || '').trim().split('\\n')[0]).filter(t => t && t.length < 20))];
            return 'bilibili row not found. 可见项: ' + texts.slice(0, 25).join(' | ');
        }
        row.click();
        return 'clicked bilibili row';
    })()`);
    console.log('\n1. 登录窗口点 bilibili:', rowClicked);
    await sleep(1500);
    await cl.shot('_e2e-login-chosen.png');

    // 2. 找「切换至」按钮
    const switchResult = await cl.evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const sw = btns.find(b => (b.innerText || '').includes('切换至') || (b.innerText || '').includes('Switch to'));
        if (!sw) {
            const visible = btns.filter(b => b.offsetParent).map(b => (b.innerText || '').trim()).filter(Boolean);
            return 'switch button not found. 可见按钮: ' + [...new Set(visible)].slice(0, 15).join(' | ');
        }
        const label = sw.innerText.trim();
        sw.click();
        return 'clicked: ' + label;
    })()`);
    console.log('2. 切换按钮:', switchResult);
    await sleep(2500);

    // 3. 回主窗口验证激活源
    const tabs = await cl.evaluate("document.title + ' / ' + location.href.slice(0, 60)").catch(() => '(窗口已关)');
    console.log('3. 登录窗口状态:', tabs);

    // 主窗口：开搜索看源标签
    await cm.evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const search = btns.find(b => (b.getAttribute('aria-label') || '').includes('搜索'));
        if (search) search.click();
    })()`);
    await sleep(2000);
    const searchTabs = await cm.evaluate(`(() => {
        const nav = [...document.querySelectorAll('nav')].pop();
        if (!nav) return 'no nav';
        return JSON.stringify([...nav.querySelectorAll('button')].map(b => b.innerText.trim()));
    })()`);
    console.log('4. 主窗口搜索源标签:', searchTabs);

    // 5. 搜索验证
    await cm.evaluate(`(() => {
        const input = document.querySelector('input');
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '晴天');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cm.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cm.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(7000);
    const resultInfo = await cm.evaluate(`(() => {
        const body = document.body.innerText;
        const lines = body.split('\\n').filter(l => l.includes('晴天'));
        return JSON.stringify({ 匹配行数: lines.length, 示例: lines.slice(0, 6) });
    })()`);
    console.log('5. 搜索结果:', resultInfo);
    await cm.shot('_e2e-final.png');

    cm.ws.close();
    try { cl.ws.close(); } catch {}
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
