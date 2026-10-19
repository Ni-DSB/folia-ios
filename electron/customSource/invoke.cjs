// electron/customSource/invoke.cjs
// The operations the renderer may ask of a custom source, each one a call into plugin code.
//
// This is the boundary the provider layer talks to. Everything crossing it is plain JSON: a plugin
// returns whatever its author wrote (MusicFree's own shapes, with extra fields, dates, class
// instances), and none of that survives IPC intact. So each operation picks the fields the host
// uses, and drops the rest. That also keeps a plugin from handing the renderer a value it would
// have to trust structurally.
//
// A failure is returned, not thrown: `{ ok: false, error: { kind, message } }`. The provider layer
// turns `kind` into one of its failure cases, which is what decides whether the listener is told
// "this source is not configured" or "the source failed".

'use strict';

const { CustomSourceCallError } = require('./registry.cjs');

// Quality names MusicFree uses, in the order a host may ask for them.
const MUSICFREE_QUALITIES = ['low', 'standard', 'high', 'super'];

// The four levels the host's own quality preference uses, mapped onto MusicFree's names. Folia
// asks for one of standard / high / lossless / hires; a plugin understands low..super.
const QUALITY_TO_MUSICFREE = {
    standard: 'standard',
    high: 'high',
    lossless: 'super',
    hires: 'super',
    // 'ultra' is a level only one built-in platform offers; a custom source has nothing above
    // 'super', which is the highest MusicFree names.
    ultra: 'super',
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A string field, or undefined when absent. Long values are cut: they cross IPC and get rendered. */
const text = (value, maxLength = 2048) => (
    typeof value === 'string' ? value.slice(0, maxLength) : undefined
);

const number = (value) => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

/*
 * One song as the host needs it. MusicFree's IMusicItem has `title`, `artist`, `album`, `artwork`,
 * `duration`, `id`, plus anything the plugin adds; `artist` is a single string there, which is why
 * it is split on the separators the sources use.
 *
 * `raw` keeps the plugin's own object. A plugin's getMediaSource reads fields of its own invention
 * from it — bilibili's needs `aid`/`bvid`/`cid`, which are nowhere in the standard shape — so a song
 * that has been reduced to the host's fields cannot be played. The object is JSON-clean (it crossed
 * IPC to get here) and is stored beside the normalised fields rather than replacing them.
 */
const ARTIST_SEPARATOR = /\s*(?:,|、|\/|&|;|feat\.?|ft\.?)\s*/i;

/**
 * Duration in milliseconds, from whatever unit the plugin used.
 *
 * MusicFree's own type says seconds, but plugins disagree in practice: bilibili reports seconds
 * (270) and 猫耳FM reports milliseconds (2563866 for a 42-minute episode). A number above two hours
 * in "seconds" is not a song, so it is read as milliseconds instead.
 */
const DURATION_LOOKS_LIKE_MS = 7200;

const durationMsOf = (value) => {
    const parsed = number(value);
    if (parsed === undefined || parsed <= 0) return 0;
    return Math.round(parsed > DURATION_LOOKS_LIKE_MS ? parsed : parsed * 1000);
};

const normalizeSong = (raw) => {
    if (!isPlainObject(raw)) return null;
    const id = raw.id === undefined || raw.id === null ? '' : String(raw.id);
    const title = text(raw.title, 512);
    if (!id || !title) return null;

    const artistText = text(raw.artist, 512) ?? '';
    const artists = artistText
        .split(ARTIST_SEPARATOR)
        .map((name) => name.trim())
        .filter((name) => name.length > 0);

    return {
        id,
        title,
        artists: artists.length > 0 ? artists : [],
        album: text(raw.album, 512) ?? '',
        artwork: text(raw.artwork ?? raw.coverImg ?? raw.pic, 4096) ?? '',
        durationMs: durationMsOf(raw.duration),
        // The plugin's own object, so a later getMediaSource can read the fields only it knows.
        raw,
    };
};

const normalizeSearchResult = (raw) => {
    if (!isPlainObject(raw)) return { items: [], isEnd: true };
    const list = Array.isArray(raw.data) ? raw.data : [];
    const items = list.map(normalizeSong).filter(Boolean);
    return { items, isEnd: raw.isEnd !== false };
};

/*
 * The lyric answer. MusicFree's `getLyric` returns `{ lrc, rawLrc, translation, ... }`; only the LRC
 * text is used, and the host parses it itself. `rawLrc` wins when present because it is the
 * untranslated original that timing is read from.
 */
const normalizeLyric = (raw) => {
    if (typeof raw === 'string') return { lrc: raw.slice(0, 512 * 1024) };
    if (!isPlainObject(raw)) return null;
    const lrc = text(raw.rawLrc, 512 * 1024) ?? text(raw.lrc, 512 * 1024);
    if (!lrc) return null;
    const translation = text(raw.translation, 512 * 1024) ?? text(raw.tlyric, 512 * 1024);
    return translation ? { lrc, translation } : { lrc };
};

/**
 * Builds the invoker. `registry` is the live set; `mediaHeaders` records the headers an audio URL
 * needs so the request can be rewritten before it leaves.
 */
const createCustomSourceInvoke = ({ registry, mediaHeaders, log = console }) => {
    /*
     * The object to hand a plugin for a song. A song that came from this source carries `raw`, the
     * plugin's own object as it returned it from `search`; that is what its getMediaSource expects,
     * because it reads fields of its own invention from it (bilibili's `cid`). A song from
     * somewhere else — a queue entry restored from disk, or one the host built — has no `raw`, and
     * the standard fields are all there is to give.
     */
    const unwrapSong = (song) => {
        if (!isPlainObject(song)) return song;
        if (isPlainObject(song.raw)) return song.raw;
        return {
            id: song.id,
            title: song.title,
            artist: Array.isArray(song.artists) ? song.artists.join('/') : (song.artist ?? ''),
            album: song.album ?? '',
            artwork: song.artwork ?? '',
            duration: song.durationMs ? Math.round(song.durationMs / 1000) : 0,
        };
    };

    /** Wraps one operation: a thrown CustomSourceCallError becomes the returned error shape. */
    const guard = async (operation) => {
        try {
            return { ok: true, data: await operation() };
        } catch (error) {
            const kind = error instanceof CustomSourceCallError ? error.kind : 'plugin-failed';
            const message = error && error.message ? error.message : String(error);
            log.warn(`[CustomSource] ${kind}: ${message}`);
            return { ok: false, error: { kind, message } };
        }
    };

    const search = (sourceId, query, page, type) => guard(async () => {
        const result = await registry.call(
            sourceId,
            'search',
            [String(query), Number(page) || 1, type || 'music'],
            `search(${String(query).slice(0, 40)})`,
        );
        return normalizeSearchResult(result);
    });

    /*
     * The audio URL. MusicFree's getMediaSource may answer `{ url, headers, userAgent }`, or null
     * when it cannot resolve. The headers are registered here so the main process can put them on
     * the request the audio element makes; the URL alone is what the renderer gets.
     *
     * The song handed back to the plugin is the object it returned from `search`, not the host's
     * reduced view of it: a plugin's getMediaSource reads its own fields (bilibili needs `cid`),
     * and those only exist there. `unwrapSong` is what recovers it; a caller that passes a song
     * without one still gets the standard fields, which is all a plugin that only reads those needs.
     *
     * Quality is tried downwards. A source offers only the levels it has — 猫耳FM answers only
     * 'standard' and 'low', and returns null for anything above — while the host asks for the
     * listener's preference, which is usually 'high' or above. Asking once at the preference would
     * leave such a source unplayable for no reason, so a null answer is retried at the next level
     * down until one produces a URL.
     */
    const QUALITY_FALLBACK_ORDER = ['super', 'high', 'standard', 'low'];

    const getMediaSource = (sourceId, song, quality) => guard(async () => {
        const preferred = QUALITY_TO_MUSICFREE[quality] || 'standard';
        const startAt = Math.max(0, QUALITY_FALLBACK_ORDER.indexOf(preferred));
        const attempts = QUALITY_FALLBACK_ORDER.slice(startAt);

        let result = null;
        let answeredAt = preferred;
        for (const attempt of attempts) {
            result = await registry.call(
                sourceId,
                'getMediaSource',
                [unwrapSong(song), attempt],
                `getMediaSource(${String(song?.title ?? '').slice(0, 40)})`,
            );
            if (result && typeof result === 'object' && text(result.url, 8192)) {
                answeredAt = attempt;
                break;
            }
            result = null;
        }

        if (!result) {
            throw new CustomSourceCallError('no-source', 'the source returned no audio URL');
        }
        const url = text(result.url, 8192);
        if (!url) throw new CustomSourceCallError('no-source', 'the source returned no audio URL');

        const headers = isPlainObject(result.headers) ? result.headers : {};
        // MusicFree reports the UA separately as well; it is what the CDN expects on the media
        // request, so it joins the header set when the plugin did not already put it there.
        const userAgent = text(result.userAgent, 1024);
        if (userAgent && !Object.keys(headers).some((name) => name.toLowerCase() === 'user-agent')) {
            headers['user-agent'] = userAgent;
        }
        const registered = mediaHeaders.register(url, headers);
        return {
            url,
            // The level the source actually answered at, which may be below the one asked for.
            quality: answeredAt,
            // Whether the request carries extra headers, for the settings page's diagnostics.
            hasHeaders: registered,
        };
    });

    const getLyric = (sourceId, song) => guard(async () => {
        const result = await registry.call(
            sourceId,
            'getLyric',
            [unwrapSong(song)],
            `getLyric(${String(song?.title ?? '').slice(0, 40)})`,
        );
        return normalizeLyric(result);
    });

    /*
     * A song's details, when the source can answer them. MusicFree's getMusicInfo takes a
     * `{ id, platform }` base; the host asks with the song it already has.
     */
    const getMusicInfo = (sourceId, song) => guard(async () => {
        const result = await registry.call(
            sourceId,
            'getMusicInfo',
            [{ id: song?.id, platform: song?.platform }],
            `getMusicInfo(${String(song?.title ?? '').slice(0, 40)})`,
        );
        return normalizeSong(result);
    });

    /* A source's top lists (排行榜): MusicFree's getTopLists answers groups of sheets. */
    const getTopLists = (sourceId) => guard(async () => {
        const result = await registry.call(sourceId, 'getTopLists', [], 'getTopLists()');
        if (!Array.isArray(result)) return [];
        return result.map((group) => {
            if (!isPlainObject(group)) return null;
            const data = Array.isArray(group.data) ? group.data : [];
            return {
                title: text(group.title, 256) ?? '',
                items: data
                    .filter(isPlainObject)
                    .map((item) => ({
                        id: item.id === undefined || item.id === null ? '' : String(item.id),
                        title: text(item.title, 512) ?? '',
                        coverImg: text(item.coverImg, 4096) ?? '',
                        description: text(item.description, 1024) ?? '',
                    }))
                    .filter((item) => item.id && item.title),
            };
        }).filter(Boolean);
    });

    const getTopListDetail = (sourceId, item) => guard(async () => {
        const result = await registry.call(sourceId, 'getTopListDetail', [item], `getTopListDetail(${String(item?.title ?? '').slice(0, 30)})`);
        if (!isPlainObject(result)) return { sheet: null, items: [] };
        const musicList = Array.isArray(result.musicList) ? result.musicList : [];
        return {
            sheet: {
                id: result.id === undefined || result.id === null ? String(item?.id ?? '') : String(result.id),
                title: text(result.title, 512) ?? text(item?.title, 512) ?? '',
                coverImg: text(result.coverImg, 4096) ?? '',
                description: text(result.description, 1024) ?? '',
            },
            items: musicList.map(normalizeSong).filter(Boolean),
        };
    });

    const getAlbumInfo = (sourceId, album, page) => guard(async () => {
        const result = await registry.call(sourceId, 'getAlbumInfo', [album, Number(page) || 1], 'getAlbumInfo()');
        if (!isPlainObject(result)) return { isEnd: true, items: [] };
        const musicList = Array.isArray(result.musicList) ? result.musicList : [];
        return {
            isEnd: result.isEnd !== false,
            album: isPlainObject(result.albumItem)
                ? {
                    id: result.albumItem.id === undefined ? String(album?.id ?? '') : String(result.albumItem.id),
                    title: text(result.albumItem.title, 512) ?? '',
                    artist: text(result.albumItem.artist, 512) ?? '',
                    artwork: text(result.albumItem.artwork, 4096) ?? '',
                    date: text(result.albumItem.date, 64) ?? '',
                    description: text(result.albumItem.description, 2048) ?? '',
                }
                : null,
            items: musicList.map(normalizeSong).filter(Boolean),
        };
    });

    const getArtistWorks = (sourceId, artist, page, type) => guard(async () => {
        const result = await registry.call(
            sourceId,
            'getArtistWorks',
            [artist, Number(page) || 1, type || 'music'],
            'getArtistWorks()',
        );
        return normalizeSearchResult(result);
    });

    const importMusicSheet = (sourceId, urlLike) => guard(async () => {
        const result = await registry.call(sourceId, 'importMusicSheet', [String(urlLike)], 'importMusicSheet()');
        if (!Array.isArray(result)) return [];
        return result.map(normalizeSong).filter(Boolean);
    });

    const importMusicItem = (sourceId, urlLike) => guard(async () => {
        const result = await registry.call(sourceId, 'importMusicItem', [String(urlLike)], 'importMusicItem()');
        return normalizeSong(result);
    });

    return {
        search,
        getMediaSource,
        getLyric,
        getMusicInfo,
        getTopLists,
        getTopListDetail,
        getAlbumInfo,
        getArtistWorks,
        importMusicSheet,
        importMusicItem,
    };
};

module.exports = { createCustomSourceInvoke, normalizeSong, normalizeSearchResult, normalizeLyric, QUALITY_TO_MUSICFREE, MUSICFREE_QUALITIES };
