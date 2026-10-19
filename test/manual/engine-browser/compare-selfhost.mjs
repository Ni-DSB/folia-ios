// 对照：同样三个插件在自托管服务端（Node）里是否可用。
// 若服务端也失败 → 插件/站点问题；若服务端成功 → 浏览器引擎有缺口。
const BASE = 'http://127.0.0.1:8081';
const REPO = 'https://raw.githubusercontent.com/hebijunge/musicfree-plugins/master/plugins/';
const post = (operation, params) => fetch(`${BASE}/custom-source`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, params }),
}).then(r => r.json());

const TARGETS = [
    ['5sing', '5sing-source.plugin.v1.0.2.js'],
    ['猫耳FM', 'missevan-source.plugin.v1.0.3.js'],
    ['1ting', '1ting-source.plugin.v1.0.2.js'],
];

(async () => {
    const list = (await post('list', {})).data || [];
    for (const [label, file] of TARGETS) {
        let src = list.find(e => e.platform === label);
        if (!src) {
            const inst = await post('installFromUrl', { url: REPO + file });
            if (!inst.ok) { console.log(`${label}: 安装失败 ${JSON.stringify(inst.error).slice(0, 70)}`); continue; }
            src = inst.data;
        }
        const s = await post('search', { sourceId: src.id, query: '晴天', page: 1, type: 'music' });
        const count = s.ok ? s.data.items.length : 0;
        let audioInfo = '—';
        if (s.ok && count) {
            const a = await post('getMediaSource', { sourceId: src.id, song: s.data.items[0], quality: 'high' });
            audioInfo = a.ok ? '✓ 有链' : `✗ ${String(a.error?.message ?? '').slice(0, 70)}`;
        }
        console.log(`${label.padEnd(10)} 搜索: ${s.ok ? count + ' 条' : '✗'} | 取链: ${audioInfo}`);
    }
})();
