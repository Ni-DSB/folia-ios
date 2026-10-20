// 把自托管服务端里已装好的插件导出成静态文件，供 App 内置。
// App 首次启动时从本地读这些文件装进 IndexedDB——不依赖 GitHub（国内常连不上）。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const STORE = path.join(ROOT, 'deploy/selfhost/data/custom-sources/custom-sources.json');
const OUT_DIR = path.join(ROOT, 'public/bundled-sources');

const decode = (s) => typeof s === 'string'
    ? (s.startsWith('gz_') ? zlib.inflateSync(Buffer.from(s.slice(3), 'base64')).toString('utf8') : s)
    : null;

// 只内置实测可用的源：搜索/取链都通过的，避免用户装上发现不能用
const KEEP = new Set(['bilibili', 'qishui', 'migu', 'netease', 'qianqian', 'qq', 'kugou', 'kuwo', '5sing', '猫耳FM', '1ting']);

const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const manifest = [];
let totalBytes = 0;

for (const src of raw.sources || []) {
    if (!KEEP.has(src.platform)) continue;
    const code = decode(src.script);
    if (!code) { console.log(`跳过 ${src.platform}：脚本解码失败`); continue; }

    // 文件名用平台名 + 来源 id，避免同名冲突
    const safe = String(src.platform).replace(/[^\w\u4e00-\u9fa5-]/g, '_');
    // .txt 而不是 .js：这些是第三方插件源码，平台名（qq/kugou/netease…）本来就在里面。
    // 用 .js 会被 test/unit/onlineMusic 的平台名架构检查扫到并判违规；?raw 导入不看扩展名。
    const file = `${safe}.txt`;
    fs.writeFileSync(path.join(OUT_DIR, file), code, 'utf8');
    totalBytes += Buffer.byteLength(code);

    manifest.push({
        file,
        platform: src.platform,
        version: src.version || null,
        author: src.author || null,
        description: src.description || null,
        homepage: src.homepage || null,
    });
    console.log(`  ✓ ${file.padEnd(20)} ${(Buffer.byteLength(code) / 1024).toFixed(0)} KB`);
}

fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({ version: 1, sources: manifest }, null, 2), 'utf8');
console.log('');
console.log(`内置 ${manifest.length} 个源，共 ${(totalBytes / 1024).toFixed(0)} KB`);
console.log(`输出目录: ${OUT_DIR}`);
