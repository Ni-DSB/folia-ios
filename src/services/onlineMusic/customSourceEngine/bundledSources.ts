// src/services/onlineMusic/customSourceEngine/bundledSources.ts
// 内置音源：把随 App 打包的插件在启动时装进本地引擎。
//
// 为什么需要它：App 的插件存储（IndexedDB）一开始是空的，而「添加音源」要么贴脚本、要么填网址——
// 那些网址指向 GitHub raw，国内经常连不上。所以把实测可用的插件直接打进包里，用户装完就有源可用。
//
// 为什么用 ?raw 内联而不是 fetch：App 跑在 Capacitor 的 capacitor://localhost/ 下，静态文件的
// 取法依赖页面 URL 与 webDir 的映射关系；一旦路径算错，表现是「一个源都没有」，而且只会在真机上
// 出现（浏览器里一切正常）。用 import.meta.glob 的 ?raw 把脚本文本直接打进 JS 包，就完全没有
// 这个环节——代价是 bundle 大 3 MB，换来的是不会因宿主路径差异而整块失效。
//
// 脚本来源：deploy/ios/export-bundled-sources.cjs 从自托管服务端已装好的源导出，产物复制到
// 本目录下的 bundled/。

interface BundledManifestEntry {
    file: string;
    platform: string;
    version: string | null;
}

interface BundledManifest {
    version: number;
    sources: BundledManifestEntry[];
}

// 构建期就把所有脚本作为字符串打进来：`?raw` 让 Vite 返回文件原文。
const scriptModules = import.meta.glob('./bundled/*.txt', {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>;

const manifestModule = import.meta.glob('./bundled/manifest.json', {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>;

/** 从 `./bundled/xxx.js` 取出文件名部分，与 manifest 里的 file 对齐。 */
const scriptOf = (file: string): string | null => {
    const key = `./bundled/${file}`;
    const text = scriptModules[key];
    return typeof text === 'string' && text.trim() ? text : null;
};

const readManifest = (): BundledManifest | null => {
    const raw = Object.values(manifestModule)[0];
    if (typeof raw !== 'string') return null;
    try {
        const manifest = JSON.parse(raw) as BundledManifest;
        return Array.isArray(manifest?.sources) ? manifest : null;
    } catch (error) {
        console.warn('[CustomSource] 内置源清单解析失败', error);
        return null;
    }
};

/**
 * 装上随包内置的音源。
 *
 * 只在缺少时补装：已经装过同名平台的跳过，所以
 *   · 首次启动（空存储）→ 全部装上；
 *   · 上次安装中断（只装了几个）→ 补上剩下的；
 *   · 用户删掉某个源 → 不会被强行装回来（列表里有记录就算"装过"）。
 */
export const installBundledSourcesIfEmpty = async (system: any): Promise<number> => {
    const manifest = readManifest();
    if (!manifest) {
        console.warn('[CustomSource] 包里没有内置源清单');
        return 0;
    }

    const existing = await system.request('list', {});
    const have = new Set<string>(
        (existing?.ok ? existing.data : [])
            .map((entry: any) => String(entry?.platform ?? ''))
            .filter(Boolean),
    );

    let installed = 0;
    for (const entry of manifest.sources) {
        if (have.has(entry.platform)) continue;
        const script = scriptOf(entry.file);
        if (!script) {
            console.warn(`[CustomSource] 内置源 ${entry.platform} 的脚本没打进包 (${entry.file})`);
            continue;
        }
        try {
            const result = await system.request('install', { script });
            if (result?.ok) installed += 1;
            else console.warn(`[CustomSource] ${entry.platform} 安装失败`, result?.error);
        } catch (error) {
            console.warn(`[CustomSource] ${entry.platform} 安装异常`, error);
        }
    }
    console.log(`[CustomSource] 内置源: 已有 ${have.size}，本次装 ${installed}，清单 ${manifest.sources.length}`);
    return installed;
};
