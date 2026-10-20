// src/services/onlineMusic/localFavorites.ts
// 插件音源的「本地收藏」。
//
// 为什么需要它：登录平台的收藏（红心、加入歌单）是写回平台的——调平台的接口，存在平台账号里。
// 插件源没有这类接口（它们是匿名抓取器，不持有你的账号），所以二创包里的插件歌曲一直点不了
// 收藏。这里给它们一套本地实现：把歌曲完整存下来（含插件自己需要的字段），收藏列表和播放都从
// 本地读，不依赖任何平台。
//
// 存的是 normalizeSong 之后的形状，其中 `raw` 是插件返回的原对象——插件取音源时要读自己那些
// 字段（bilibili 的 cid/bvid 等），少了就播不了。所以整条记录原样保存。

import type { SongResult } from '../../types';

const STORAGE_KEY = 'folia.localFavorites.v1';

/** 一条本地收藏：歌曲本身 + 收藏时间 + 来源平台名（列表上要显示）。 */
export interface LocalFavoriteEntry {
    /** 稳定的键：pluginId + songId，用来判重。 */
    key: string;
    providerId: string;
    song: SongResult;
    addedAt: number;
}

type Listener = () => void;

let cache: LocalFavoriteEntry[] | null = null;
const listeners = new Set<Listener>();

const read = (): LocalFavoriteEntry[] => {
    if (cache) return cache;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        cache = Array.isArray(parsed) ? parsed.filter(entry => entry && typeof entry.key === 'string') : [];
    } catch {
        // 读不出来就当没有：坏数据不该让收藏功能整块不可用。
        cache = [];
    }
    return cache;
};

const write = (entries: LocalFavoriteEntry[]): void => {
    cache = entries;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch (error) {
        // 配额满了也要让内存里的状态正确，界面才不会与实际不符。
        console.warn('[LocalFavorites] 写入失败', error);
    }
    listeners.forEach(listener => {
        try { listener(); } catch { /* 订阅者的错不该影响其他人 */ }
    });
};

const entryKey = (providerId: string, song: SongResult): string => (
    `${providerId}::${String(song.id ?? '')}`
);

/** 全部收藏，最新的在前。 */
export const getLocalFavorites = (): LocalFavoriteEntry[] => (
    [...read()].sort((left, right) => right.addedAt - left.addedAt)
);

/** 某首歌是否已收藏。 */
export const isLocallyFavorited = (providerId: string, song: SongResult): boolean => (
    read().some(entry => entry.key === entryKey(providerId, song))
);

/** 收藏一首歌；已存在时原样返回。 */
export const addLocalFavorite = (providerId: string, song: SongResult): LocalFavoriteEntry => {
    const key = entryKey(providerId, song);
    const existing = read().find(entry => entry.key === key);
    if (existing) return existing;
    const entry: LocalFavoriteEntry = { key, providerId, song, addedAt: Date.now() };
    write([entry, ...read()]);
    return entry;
};

/** 取消收藏；返回是否真的删掉了。 */
export const removeLocalFavorite = (providerId: string, song: SongResult): boolean => {
    const key = entryKey(providerId, song);
    const before = read();
    const after = before.filter(entry => entry.key !== key);
    if (after.length === before.length) return false;
    write(after);
    return true;
};

/** 切换收藏状态；返回切换后是否为已收藏。 */
export const toggleLocalFavorite = (providerId: string, song: SongResult): boolean => {
    if (isLocallyFavorited(providerId, song)) {
        removeLocalFavorite(providerId, song);
        return false;
    }
    addLocalFavorite(providerId, song);
    return true;
};

/** 订阅收藏变化（收藏列表与按钮状态要跟着刷新）。返回取消订阅的函数。 */
export const subscribeLocalFavorites = (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

/** 收藏数量，给界面做角标用。 */
export const localFavoriteCount = (): number => read().length;
