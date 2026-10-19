// src/services/onlineMusic/customSource/customSourceTypes.ts
// The shapes the custom source subsystem's two halves agree on.
//
// These are the values that cross the IPC bridge: plain JSON, already reduced by
// electron/customSource/invoke.cjs. They are deliberately not MusicFree's own types — a plugin
// returns whatever its author wrote, and the main process is what narrows that to this.

// src/services/onlineMusic/customSource/customSourceTypes.ts

/** A song as a custom source reports it, in the host's units. */
export interface CustomSourceSong {
    id: string;
    title: string;
    artists: string[];
    album: string;
    artwork: string;
    /** Milliseconds; 0 when the source did not say. */
    durationMs: number;
    /**
     * The plugin's own object, as it returned it from `search`. A plugin's `getMediaSource` reads
     * fields of its own invention from it (bilibili's `cid`, for one), so a song stripped to the
     * standard fields cannot be played. It travels with the song through the queue for that reason.
     */
    raw?: Record<string, unknown>;
}

/** One page of search results. */
export interface CustomSourceSearchResult {
    items: CustomSourceSong[];
    /** The source has nothing after this page. */
    isEnd: boolean;
}

/** An audio URL and how to ask for it. */
export interface CustomSourceAudioSource {
    url: string;
    /** The quality the source actually answered at. */
    quality: string;
    /** Whether the request carries headers the source needs (a Referer, a signed User-Agent). */
    hasHeaders: boolean;
}

/** Lyrics as raw text; the host parses them itself. */
export interface CustomSourceLyrics {
    lrc: string;
    /** A translated copy of the same timing, when the source has one. */
    translation?: string;
}

/** One top list's entry (a 排行榜 the source publishes). */
export interface CustomSourceTopListSheet {
    id: string;
    title: string;
    coverImg: string;
    description: string;
}

export interface CustomSourceTopListGroup {
    title: string;
    items: CustomSourceTopListSheet[];
}

export interface CustomSourceTopListDetail {
    sheet: CustomSourceTopListSheet | null;
    items: CustomSourceSong[];
}

export interface CustomSourceAlbumInfo {
    isEnd: boolean;
    album: {
        id: string;
        title: string;
        artist: string;
        artwork: string;
        date: string;
        description: string;
    } | null;
    items: CustomSourceSong[];
}

/** One variable a source asks the listener to fill in. */
export interface CustomSourceUserVariable {
    key: string;
    name: string | null;
}

/** One installed source, as the settings page lists it. No script text. */
export interface CustomSourceEntry {
    id: string;
    platform: string;
    version: string | null;
    author: string | null;
    description: string | null;
    homepage: string | null;
    enabled: boolean;
    /** Why this source is unusable, or null. A disabled source is not an error. */
    error: string | null;
    /** The plugin methods it exposes (search, getMediaSource, getLyric, ...). */
    methods: string[];
    userVariables: CustomSourceUserVariable[];
    userVariableValues: Record<string, string>;
    addedAt: number;
    updatedAt: number;
    loadedAt: number;
}

/** A failure the subsystem classified. `kind` is what the provider turns into a failure case. */
export interface CustomSourceError {
    kind: string;
    message: string;
}

export type CustomSourceResult<T> =
    | { ok: true; data: T }
    | { ok: false; error: CustomSourceError };

/** The operations the bridge accepts. */
export type CustomSourceOperation =
    | 'list'
    | 'reload'
    | 'install'
    | 'installFromUrl'
    | 'update'
    | 'remove'
    | 'setEnabled'
    | 'setUserVariables'
    | 'search'
    | 'getMediaSource'
    | 'getLyric'
    | 'getMusicInfo'
    | 'getTopLists'
    | 'getTopListDetail'
    | 'getAlbumInfo'
    | 'getArtistWorks'
    | 'importMusicSheet'
    | 'importMusicItem'
    | 'diagnostics';

/** What a plugin's load state says about why a source does not work. */
export const CUSTOM_SOURCE_ERROR_KINDS = [
    'unknown-source',
    'disabled',
    'not-loaded',
    'unsupported',
    'timeout',
    'plugin-failed',
    'no-source',
    'invalid-script',
    'download-failed',
    'bridge-failed',
    'untrusted',
    'unknown-operation',
] as const;

export type CustomSourceErrorKind = typeof CUSTOM_SOURCE_ERROR_KINDS[number];
