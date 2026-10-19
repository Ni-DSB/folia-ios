// src/services/onlineMusic/customSource/customSourceProvider.ts
// The host provider that fronts every installed custom source.
//
// One installed script is one provider, so a listener with three sources gets three rows in the
// source switcher, each searchable and playable on its own. `buildCustomSourceProvider` makes one
// of those; `registerInstalledCustomSources` makes them all and keeps the registry in step with
// what is installed.
//
// What a custom source can do is exactly what its script implements. `capabilities` is built from
// the method list the main process read at load time, because the UI decides a lot from those
// flags alone (whether an explore tab appears, whether a like button is offered). Claiming a
// capability the script lacks would give the listener a control that does nothing.
//
// No custom source has an account. `requiresAccount: false` is what tells the UI to use the source
// without a sign-in, and there is no `auth` member at all.

import type { SongResult, UnifiedSong } from '../../../types';
import {
    OnlineProviderError,
    type AudioQualityPreference,
    type OnlineMusicProvider,
    type ProviderAudioSource,
    type ProviderCapabilities,
    type ProviderLyricsResult,
    type ProviderPage,
    type ProviderSongAvailability,
} from '../../../types/onlineMusic';
import type { CustomSourceEntry } from './customSourceTypes';
import { customSourceProviderId, normalizeCustomSourceSong, toCustomSourceSong } from './customSourceNormalize';
import {
    CUSTOM_SOURCE_BRIDGE_FAILED,
    CUSTOM_SOURCE_NEEDS_DESKTOP,
    getCustomSourceTransportAvailability,
    requestCustomSource,
} from './customSourceTransport';

// src/services/onlineMusic/customSource/customSourceProvider.ts

/**
 * Turns a failed bridge call into the host's error. A bridge that is missing or threw is a network
 * -level failure for the UI's purposes; a source's own failure keeps its message so the failure
 * texts can quote it.
 */
const asProviderError = (providerId: string, error: unknown): OnlineProviderError => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === CUSTOM_SOURCE_NEEDS_DESKTOP || message.startsWith(CUSTOM_SOURCE_BRIDGE_FAILED)) {
        return new OnlineProviderError('unavailable', message, providerId, error);
    }
    return new OnlineProviderError('network', message, providerId, error);
};

/** Reads one operation's answer, or throws the source's own failure as a provider error. */
const readAnswer = async <T>(
    providerId: string,
    operation: Parameters<typeof requestCustomSource>[0],
    params: Record<string, unknown>,
): Promise<T> => {
    let answer;
    try {
        answer = await requestCustomSource<T>(operation, params);
    } catch (error) {
        throw asProviderError(providerId, error);
    }
    if (!answer.ok) {
        // A source that says "no audio URL" is not a network failure; it is the source having
        // nothing to play. The distinction decides which failure text the listener reads.
        const code = answer.error.kind === 'no-source' ? 'not-playable'
            : answer.error.kind === 'unsupported' ? 'unsupported'
                : answer.error.kind === 'timeout' ? 'network'
                    : 'unavailable';
        throw new OnlineProviderError(code, answer.error.message, providerId);
    }
    return answer.data as T;
};

/** The capabilities a script's method list implies. */
const capabilitiesOf = (entry: CustomSourceEntry): ProviderCapabilities => {
    const methods = new Set(entry.methods);
    return {
        search: methods.has('search'),
        playback: methods.has('getMediaSource'),
        lyrics: methods.has('getLyric'),
        // A custom source never signs in.
        auth: false,
        // Nothing account-shaped: no library, no playlists of the listener's own, no mutations.
        userLibrary: false,
        playlists: methods.has('importMusicSheet'),
        albums: methods.has('getAlbumInfo'),
        artists: methods.has('getArtistWorks'),
        // Top lists are not the host's recommendation page; leaving this false keeps the explore
        // tab from offering something the source cannot fill.
        recommendations: false,
        mutations: false,
        // A source's lyrics are LRC text, which the host parses into word timing when the file has
        // it. Saying true here only declares the possibility.
        wordByWordLyrics: methods.has('getLyric'),
    };
};

/** The availability the UI reads: the bridge must exist and the source must have loaded. */
const availabilityOf = (entry: CustomSourceEntry) => {
    const transport = getCustomSourceTransportAvailability();
    if (!transport.configured) return { configured: false, reason: 'runtime-unavailable' } as const;
    if (entry.error) return { configured: false, reason: 'runtime-unavailable' } as const;
    return { configured: true } as const;
};

/**
 * One installed source as a host provider.
 *
 * `entry` is a snapshot: the installed list is re-read when the registry changes, and each change
 * builds fresh providers, so a provider never has to watch its own source.
 */
export const buildCustomSourceProvider = (entry: CustomSourceEntry): OnlineMusicProvider => {
    const providerId = customSourceProviderId(entry.id);
    const capabilities = capabilitiesOf(entry);
    const methods = new Set(entry.methods);

    return {
        id: providerId,
        displayName: entry.platform,
        // The switcher's row and the search overlay's chip use the short name; the platform name
        // the script declares is already short.
        shortName: entry.platform,
        // A source declares no mark. The UI takes the short name's first character and a neutral
        // colour when there is none, which is exactly what a third-party source should look like.
        getAvailability: () => availabilityOf(entry),
        capabilities,
        // Every song already carries its sourceRef; this is the identity normalisation the contract
        // asks for, and it must not invent a different id than the one the song arrived with.
        normalizeSong: (raw) => {
            const candidate = raw as UnifiedSong;
            if (candidate?.sourceRef?.kind === 'online' && candidate.sourceRef.providerId === providerId) {
                return candidate;
            }
            throw new Error(`${providerId}: cannot normalize song`);
        },
        ...(capabilities.search ? {
            search: {
                searchSongs: async (query: string, limit: number, offset: number): Promise<ProviderPage<UnifiedSong>> => {
                    // MusicFree's search is page-based, not offset-based. The host asks in offsets, so
                    // the page number is derived; a page is what the source can answer.
                    const page = Math.floor(offset / Math.max(1, limit)) + 1;
                    const result = await readAnswer<{ items: import('./customSourceTypes').CustomSourceSong[]; isEnd: boolean }>(
                        providerId, 'search', { sourceId: entry.id, query, page, type: 'music' },
                    );
                    const items = result.items.map((song) => normalizeCustomSourceSong(providerId, song));
                    return {
                        items,
                        hasMore: !result.isEnd && items.length > 0,
                        nextOffset: offset + items.length,
                    };
                },
            },
        } : {}),
        ...(capabilities.playback ? {
            playback: {
                getSongDetail: async (id) => {
                    if (!methods.has('getMusicInfo')) return null;
                    const song = await readAnswer<import('./customSourceTypes').CustomSourceSong | null>(
                        providerId, 'getMusicInfo', { sourceId: entry.id, song: { id: String(id) } },
                    );
                    return song ? normalizeCustomSourceSong(providerId, song) : null;
                },
                getAudioSource: async (song: SongResult, quality: AudioQualityPreference): Promise<ProviderAudioSource | null> => {
                    const result = await readAnswer<{ url: string; quality: string; hasHeaders: boolean }>(
                        providerId, 'getMediaSource', {
                            sourceId: entry.id,
                            song: toCustomSourceSong(song),
                            quality,
                        },
                    );
                    if (!result?.url) return null;
                    return {
                        url: result.url,
                        fetchedAt: Date.now(),
                        quality,
                    };
                },
                /*
                 * A source that cannot say whether a song is playable must answer `unknown`, not
                 * `playable`: the host writes an unavailable answer back onto the song, and guessing
                 * wrong there would mark a working song dead.
                 */
                getAvailability: (): ProviderSongAvailability => ({ state: 'unknown' }),
            },
        } : {}),
        ...(capabilities.lyrics ? {
            lyrics: {
                getLyrics: async (song: SongResult): Promise<ProviderLyricsResult> => {
                    const result = await readAnswer<{ lrc: string; translation?: string } | null>(
                        providerId, 'getLyric', { sourceId: entry.id, song: toCustomSourceSong(song) },
                    );
                    if (!result?.lrc) {
                        return { lyrics: null, isPureMusic: false };
                    }
                    // The host parses LRC into its own LyricData; this provider only supplies text,
                    // which is what the contract's `mainText` is for.
                    return {
                        lyrics: null,
                        mainText: result.lrc,
                        ...(result.translation ? { translationText: result.translation } : {}),
                        isPureMusic: false,
                    };
                },
            },
        } : {}),
    };
};

/** Every usable installed source, as providers. */
export const buildInstalledCustomSourceProviders = (entries: readonly CustomSourceEntry[]): OnlineMusicProvider[] => (
    entries
        // A source that failed to load, or is switched off, is not offered as a provider: the
        // switcher would otherwise list a row that cannot answer anything.
        .filter((entry) => entry.enabled && !entry.error && entry.platform)
        .map(buildCustomSourceProvider)
);
