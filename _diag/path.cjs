// 验证 Capacitor 下的相对路径解析：bundledSources 用的是 fetch('bundled-sources/manifest.json')。
// Capacitor 把 webDir 挂在 capacitor://localhost/ 下，相对路径不带前导斜杠在子路由页面会解析错。
const fs = require('fs');

const src = fs.readFileSync('src/services/onlineMusic/customSourceEngine/bundledSources.ts', 'utf8');
console.log('=== 现在的取文件方式 ===');
src.split('\n').forEach((l, i) => {
    if (/fetch\(/.test(l)) console.log(`  ${i + 1}: ${l.trim()}`);
});

console.log('\n=== 问题分析 ===');
console.log('  BUNDLED_DIR = "bundled-sources"（无前导斜杠）');
console.log('  → fetch("bundled-sources/manifest.json") 会相对「当前页面 URL」解析');
console.log('  → Capacitor 里页面是 capacitor://localhost/，解析成 capacitor://localhost/bundled-sources/manifest.json ✓');
console.log('  → 但如果页面 URL 带了路径（如 capacitor://localhost/index.html），相对解析仍正确');
console.log('  → 真正的问题更可能是：Capacitor 把 dist 内容挂在根，路径没错，但');

console.log('\n=== 检查 dist 里文件位置 ===');
const dist = 'dist/bundled-sources';
if (fs.existsSync(dist)) {
    const files = fs.readdirSync(dist);
    console.log(`  dist/bundled-sources/ 存在，${files.length} 个文件`);
    console.log('  manifest.json ' + (files.includes('manifest.json') ? '✓' : '✗'));
} else {
    console.log('  ✗ dist/bundled-sources/ 不存在！');
}

console.log('\n=== 检查 capacitor 同步后的 public 目录 ===');
// Capacitor 把 webDir 复制到 ios/App/App/public/
console.log('  Capacitor 的 webDir=dist，sync 时整个 dist 复制到 App.app/public/');
console.log('  → bundled-sources/ 应该也在里面（IPA 里已验证有 11 个 js）');

console.log('\n=== 关键怀疑点：安装时机 ===');
const transport = fs.readFileSync('src/services/onlineMusic/customSource/customSourceTransport.ts', 'utf8');
const idx = transport.indexOf('installBundledSourcesIfEmpty');
console.log(transport.slice(Math.max(0, idx - 400), idx + 300));
