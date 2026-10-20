// src/services/onlineMusic/customSource/customSourceRegistry.ts
// Keeps the provider registry in step with the installed custom sources.
//
// The provider registry is a plain map plus a version counter (providerRegistry.ts). Custom sources
// are installed, switched off and removed while the app runs, so this file owns the difference:
// it reads the installed list once, builds one provider per usable source, and re-reads it whenever
// the settings page changes something. Every re-read unregisters what is gone and registers what is
// new, so a removed source cannot keep answering searches.
//
// Nothing here runs in the web build: `listCustomSources` answers an empty list there, so the
// registry never gains a provider and the source switcher shows the built-in platforms only.

import type { OnlineMusicProvider } from '../../../types/onlineMusic';
import { getOnlineMusicProvider, registerOnlineMusicProvider, unregisterOnlineMusicProvider } from '../providerRegistry';
import { buildInstalledCustomSourceProviders } from './customSourceProvider';
import { customSourceProviderId } from './customSourceNormalize';
import { getCustomSourceTransportAvailability, listCustomSources } from './customSourceTransport';

// src/services/onlineMusic/customSource/customSourceRegistry.ts

/** Which provider ids this file registered, so a re-read removes exactly what it added. */
let registered: string[] = [];
let syncing: Promise<OnlineMusicProvider[]> | null = null;

/** Registers the providers for every usable installed source, replacing the previous set. */
const syncOnce = async (): Promise<OnlineMusicProvider[]> => {
    if (!getCustomSourceTransportAvailability().configured) {
        registered.forEach((id) => unregisterOnlineMusicProvider(id));
        registered = [];
        return [];
    }

    const entries = await listCustomSources();
    const providers = buildInstalledCustomSourceProviders(entries);
    const nextIds = providers.map((provider) => provider.id);
    const nextIdSet = new Set(nextIds);

    // Removed first, so a source that was replaced does not briefly answer with its old code.
    registered.forEach((id) => {
        if (!nextIdSet.has(id)) unregisterOnlineMusicProvider(id);
    });

    providers.forEach((provider) => {
        // A provider that is already registered is replaced in place; registering is a map set, so
        // this is also how a source whose script changed picks up its new capabilities.
        registerOnlineMusicProvider(provider);
    });

    registered = nextIds;
    return providers;
};

/**
 * Re-reads the installed sources and updates the registry. Concurrent callers share one read:
 * the settings page can save two changes in a row, and both must see the same list.
 *
 * `force` 用于「源刚被装上」的场景（内置源首次安装）：必须等上一次读完再读一次，不能join 它。
 * 内置源是异步装进 IndexedDB 的，而 providerRegistry 在应用启动时就调过一次同步——那次拿到的
 * 是空列表。若这里直接返回进行中的那次，界面就永远看不到新装上的源。
 */
export const syncCustomSourceProviders = (options: { force?: boolean } = {}): Promise<OnlineMusicProvider[]> => {
    if (!options.force && syncing) return syncing;
    const attempt = syncOnce().finally(() => {
        if (syncing === attempt) syncing = null;
    });
    syncing = attempt;
    return attempt;
};

/** The provider ids this file currently has registered. For diagnostics. */
export const registeredCustomSourceProviderIds = (): readonly string[] => registered;

/**
 * Whether a provider id belongs to a custom source that is registered right now. The UI uses this
 * where it has to tell a custom source from a built-in platform.
 */
export const isCustomSourceProviderRegistered = (providerId: string): boolean => (
    registered.includes(providerId) && Boolean(getOnlineMusicProvider(providerId))
);

/** The source id behind a registered custom source provider, or null. */
export const customSourceIdOfProvider = (providerId: string): string | null => (
    isCustomSourceProviderRegistered(providerId) ? providerId.slice('custom.'.length) : null
);

/** The provider id for one installed source. Exported so the settings page can name it. */
export { customSourceProviderId };

// 内置源是异步装进 IndexedDB 的（独立 App 首次启动要装 11 个脚本）。providerRegistry 在应用
// 启动时已经同步过一遍，那次存储还是空的——所以装完必须再读一次，否则搜索标签与设置页永远看不到
// 这些源。用事件而不是让 transport 直接 import 本模块：两者互相引用会形成环形依赖。
if (typeof window !== 'undefined') {
    window.addEventListener('folia:custom-sources-installed', () => {
        void syncCustomSourceProviders({ force: true })
            .then((providers) => {
                console.log(`[CustomSource] 注册表已刷新: ${providers.length} 个 provider`);
            })
            .catch((error: unknown) => {
                console.warn('[CustomSource] 安装后刷新注册表失败', error);
            });
    });
}
