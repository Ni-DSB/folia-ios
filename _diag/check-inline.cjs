// 确认内置脚本已内联进 bundle（而非运行时 fetch）
const fs = require('fs');
const path = require('path');

const dir = 'dist/assets';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));

console.log('=== 哪个 chunk 含插件源码 ===');
let found = 0;
for (const f of files) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    if (t.includes('哔哩哔哩独立源插件') || t.includes('musicfree')) {
        console.log(`  ✓ ${f}  ${Math.round(fs.statSync(path.join(dir, f)).size / 1024)} KB`);
        found++;
    }
}
if (!found) console.log('  ✗ 没有 chunk 含插件源码');

console.log('\n=== bundledSources 模块的取文件方式 ===');
const bs = files.find(f => /bundledSources/i.test(f));
if (bs) {
    const t = fs.readFileSync(path.join(dir, bs), 'utf8');
    console.log(`  文件: ${bs}  ${Math.round(fs.statSync(path.join(dir, bs)).size / 1024)} KB`);
    console.log(`  含 fetch(: ${/fetch\(/.test(t) ? '仍在使用' : '✓ 未使用'}`);
    console.log(`  含内联脚本: ${/哔哩哔哩|musicfree/.test(t) ? '✓' : '（在别的 chunk）'}`);
} else {
    console.log('  没有独立 chunk，已内联进其他 bundle');
}

console.log('\n=== 总大小 ===');
const total = fs.readdirSync(dir).reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
console.log(`  dist/assets: ${(total / 1024 / 1024).toFixed(1)} MB`);
