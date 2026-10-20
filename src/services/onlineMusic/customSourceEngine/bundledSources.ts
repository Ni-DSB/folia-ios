// src/services/onlineMusic/customSourceEngine/bundledSources.ts
// 内置音源：把随 App 打包的插件在首次启动时装进本地引擎。
//
// 为什么需要它：App 的插件存储（IndexedDB）一开始是空的，而"添加音源"要么贴脚本、要么填网址——
// 那些网址指向 GitHub raw，国内经常连不上。所以把实测可用的插件直接打进包里，用户装完就有源可用。
//
// 文件来自 deploy/ios/export-bundled-sources.cjs（从自托管服务端已装好的源导出），放在 public/
// 下随构建进 dist。只在存储为空时安装：用户自己删掉的源不会被强行装回来。

interface BundledManifestEntry {
    file: string;
    platform: string;
    version: string | null;
}

interface BundledManifest {
    version: number;
    sources: BundledManifestEntry[];
}

const BUNDLED_DIR = 'bundled-sources';

/** 随包内置的音源清单；取不到时返回 null（例如桌面/网页构建里没有这个目录）。 */
const readManifest = async (): Promise<BundledManifest | null> => {
    try {
        const response = await fetch(`${BUNDLED_DIR}/manifest.json`, { cache: 'no-store' });
        if (!response.ok) return null;
        const manifest = await response.json() as BundledManifest;
        return Array.isArray(manifest?.sources) ? manifest : null;
    } catch {
        return null;
    }
};

/**
 * 存储为空时装上内置音源。
 *
 * 返回装了几个；已经有源、或这份构建没带内置源时返回 0。整个过程在后台跑，不阻塞界面——
 * 11 个脚本约 3 MB，装完设置页和搜索标签会自己刷新。
 */
export const installBundledSourcesIfEmpty = async (system: any): Promise<number> => {
    const existing = await system.request('list', {});
    if (existing?.ok && Array.isArray(existing.data) && existing.data.length > 0) return 0;

    const manifest = await readManifest();
    if (!manifest) return 0;

    let installed = 0;
    for (const entry of manifest.sources) {
        try {
            const response = await fetch(`${BUNDLED_DIR}/${entry.file}`, { cache: 'no-store' });
            if (!response.ok) continue;
            const script = await response.text();
            if (!script.trim()) continue;
            const result = await system.request('install', { script });
            if (result?.ok) installed += 1;
            else console.warn(`[CustomSource] 内置源 ${entry.platform} 安装失败`, result?.error);
        } catch (error) {
            console.warn(`[CustomSource] 内置源 ${entry.platform} 读取失败`, error);
        }
    }
    return installed;
};
