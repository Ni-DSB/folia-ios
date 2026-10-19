// 端到端 v4：完整用户流程——切换器选 bilibili → 切换 → 搜索 → 播放。
// 每步读 DOM 状态并截图；选择器全部按文本找，不依赖元素类型。
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
    const clickAt = async (x, y) => {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    };
    return { ws, ready, send, evaluate, shot, esc, clickAt };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const page = await getMain();
    const c = makeClient(page.webSocketDebuggerUrl);
    await c.ready;

    // 0. 回到首页
    for (let i = 0; i < 4; i++) { await c.esc(); await sleep(500); }
    await sleep(1500);

    // 1. 点头像开切换器
    const avatar = await c.evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '').includes('切换在线音乐平台'));
        if (!b) return 'no avatar button';
        b.click();
        return 'avatar clicked';
    })()`);
    console.log('1.', avatar);
    await sleep(2500);

    // 2. 读切换器里每一行的状态文字（诊断「未登录 vs 无需登录」）
    const rows = await c.evaluate(`(() => {
        const out = [];
        document.querySelectorAll('button, [role=button], div').forEach(el => {
            const t = (el.innerText || '').trim().replace(/\\s+/g, ' ');
            const m = /^(QQ音乐|网易云|酷狗|波点|YT Music|Spotify|bilibili|qishui|migu|netease|qianqian|1ting|5sing|猫耳FM)\\s*(未登录|无需登录|.*E$)/.exec(t);
            if (m && t.length < 40) out.push(m[1] + ' => ' + m[2]);
        });
        return JSON.stringify([...new Set(out)]);
    })()`);
    console.log('2. 切换器各行状态:', rows);

    // 3. 点 bilibili 行（找文本以 bilibili 开头、最短的可点元素）
    const rowClick = await c.evaluate(`(() => {
        const cands = [...document.querySelectorAll('button, [role=button], div')]
            .filter(el => /^bilibili/.test((el.innerText || '').trim()) && (el.innerText || '').trim().length < 30);
        if (!cands.length) return 'bilibili row not found';
        // 取最深的（最短文本、最后出现的那个）
        const el = cands[cands.length - 1];
        el.click();
        return 'clicked: ' + el.tagName + ' "' + (el.innerText || '').trim().replace(/\\s+/g, ' ') + '"';
    })()`);
    console.log('3.', rowClick);
    await sleep(1500);
    await c.shot('_e2e-chosen.png');

    // 4. 右侧面板找「切换」按钮
    const switchClick = await c.evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')].filter(b => b.offsetParent);
        const sw = btns.find(b => /切换至|切换|使用/.test((b.innerText || '').trim()));
        if (!sw) {
            const visible = [...new Set(btns.map(b => (b.innerText || '').trim().split('\\n')[0]).filter(Boolean))];
            return 'no switch button. 可见按钮: ' + visible.slice(0, 15).join(' | ');
        }
        const label = sw.innerText.trim();
        sw.click();
        return 'clicked: ' + label;
    })()`);
    console.log('4.', switchClick);
    await sleep(3000);
    await c.shot('_e2e-switched.png');

    // 5. 关切换器，开搜索
    for (let i = 0; i < 3; i++) { await c.esc(); await sleep(400); }
    await sleep(800);
    const searchOpen = await c.evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '').includes('搜索在线平台'));
        if (!b) return 'no search button';
        b.click();
        return 'search clicked';
    })()`);
    console.log('5.', searchOpen);
    await sleep(2000);

    // 6. 读搜索界面的源标签
    const tabs = await c.evaluate(`(() => {
        const nav = [...document.querySelectorAll('nav')].pop();
        if (!nav) return 'no nav';
        return JSON.stringify([...nav.querySelectorAll('button')].map(b => b.innerText.trim()));
    })()`);
    console.log('6. 搜索源标签:', tabs);
    await c.shot('_e2e-tabs.png');

    // 7. 真实点击输入框 + 敲键盘（trusted events）
    const inputBox = await c.evaluate(`(() => {
        const input = [...document.querySelectorAll('input')].find(i => i.offsetParent);
        if (!input) return null;
        const r = input.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`);
    if (!inputBox) { console.log('7. 找不到输入框'); c.ws.close(); return; }
    const { x, y } = JSON.parse(inputBox);
    await c.clickAt(x, y);
    await sleep(400);
    await c.send('Input.insertText', { text: '晴天 周杰伦' });
    await sleep(400);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    console.log('7. 已输入并回车');
    await sleep(9000);

    // 8. 读结果
    const results = await c.evaluate(`(() => {
        const lines = document.body.innerText.split('\\n').map(l => l.trim()).filter(Boolean);
        const songLines = lines.filter(l => /晴天|周杰伦/.test(l) && l.length < 60);
        return JSON.stringify({ 结果行数: songLines.length, 示例: songLines.slice(0, 10) });
    })()`);
    console.log('8. 搜索结果:', results);
    await c.shot('_e2e-results.png');

    // 9. 点第一条结果播放
    const playClick = await c.evaluate(`(() => {
        const rows = [...document.querySelectorAll('div,li,button')]
            .filter(el => {
                const t = (el.innerText || '').trim();
                return /晴天/.test(t) && t.length > 3 && t.length < 80 && el.offsetParent
                    && el.getBoundingClientRect().height < 90 && el.getBoundingClientRect().height > 20;
            });
        if (!rows.length) return 'no result row to click';
        const el = rows[rows.length - 1];
        el.click();
        return 'clicked result: ' + (el.innerText || '').trim().split('\\n')[0].slice(0, 30);
    })()`);
    console.log('9.', playClick);
    await sleep(8000);

    // 10. 验证音频状态
    const audio = await c.evaluate(`(() => {
        const els = [...document.querySelectorAll('audio')];
        return JSON.stringify(els.map(a => ({
            srcKind: (a.currentSrc || a.src || '').slice(0, 40) || '(空)',
            paused: a.paused,
            readyState: a.readyState,
            duration: Math.round(a.duration || 0),
            currentTime: Math.round(a.currentTime),
        })));
    })()`);
    console.log('10. 音频元素状态:', audio);
    await c.shot('_e2e-playing.png');

    c.ws.close();
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
