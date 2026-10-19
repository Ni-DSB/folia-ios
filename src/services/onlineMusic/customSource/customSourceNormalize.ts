// src/services/onlineMusic/customSource/customSourceNormalize.ts
// Turns a custom source's answers into the host's own shapes.
//
// A provider must give every song a `sourceRef` naming it. Without one the host falls back to
// treating the song as a built-in platform's (src/utils/appPlaybackGuards.ts,
// getPlaybackSourceRef), which would route a custom source's song to a provider that never heard
// of it. So every song built here carries `{ kind: 'online', providerId, mediaId }`, and every
// collection carries its providerId.
//
// The id a song keeps is the plugin's own, so a queue or a play history entry that outlives the
// source still names the song. While the source is off it becomes unplayable rather than corrupt.

import type { SongResult, UnifiedSong } from '../../../types';
import type { ProviderCollection, ProviderUser } from '../../../types/onlineMusic';
import type { CustomSourceSong } from './customSourceTypes';

// src/services/onlineMusic/customSource/customSourceNormalize.ts

/** The id a source's songs are filed under: `custom.<sourceId>`. Dots keep it apart from builtins. */
export const customSourceProviderId = (sourceId: string) => `custom.${sourceId}`;

/** The source id inside a provider id, or null when the id is not a custom source's. */
export const customSourceIdFromProviderId = (providerId: string): string | null => (
    providerId.startsWith('custom.') ? providerId.slice('custom.'.length) : null
);

/** One song in the host's shape. */
export const normalizeCustomSourceSong = (providerId: string, song: CustomSourceSong): UnifiedSong => ({
    id: song.id,
    name: song.title,
    artists: (song.artists ?? []).map((name, index) => ({
        // A source gives no artist ids; a stable per-song one is enough for the UI to key on.
        id: `${song.id}#artist${index}`,
        name,
    })),
    album: {
        id: `${song.id}#album`,
        name: song.album ?? '',
        ...(song.artwork ? { coverUrl: song.artwork } : {}),
    },
    durationMs: Number.isFinite(song.durationMs) && song.durationMs > 0 ? song.durationMs : 0,
    sourceRef: {
        kind: 'online',
        providerId,
        mediaId: song.id,
        // The plugin's own object travels with the song: its getMediaSource reads fields of its
        // own invention from it, so a song reduced to the standard fields cannot be played.
        // `providerData` is the contract's slot for exactly this, and it survives the queue.
        ...(song.raw ? { providerData: song.raw as Record<string, import('../../../types/onlineMusic').JsonValue> } : {}),
    },
});

/** A song back in the source's own shape, for a call that takes one (getMediaSource, getLyric). */
export const toCustomSourceSong = (song: SongResult): CustomSourceSong => {
    const ref = song.sourceRef;
    const mediaId = ref?.kind === 'online' ? ref.mediaId : String(song.id);
    return {
        id: mediaId,
        title: song.name,
        artists: (song.artists ?? []).map((artist) => artist.name),
        album: song.album?.name ?? '',
        artwork: song.album?.coverUrl ?? '',
        durationMs: Number(song.durationMs) || 0,
        // Handing the plugin back its own object is what makes getMediaSource work for a source
        // that reads its own fields (bilibili needs `cid`).
        ...(ref?.kind === 'online' && ref.providerData ? { raw: ref.providerData as Record<string, unknown> } : {}),
    };
};

/** One collection (a top list, an album) in the host's shape. */
export const normalizeCustomSourceCollection = (
    providerId: string,
    sheet: { id: string; title: string; coverImg?: string; description?: string },
    type: ProviderCollection['type'] = 'playlist',
): ProviderCollection => ({
    providerId,
    id: sheet.id,
    type,
    name: sheet.title,
    coverUrl: sheet.coverImg ?? '',
    description: sheet.description ?? '',
});

/**
 * A source has no account: it is used without signing in. The host's account model still wants a
 * summary, and `requiresAccount: false` is what tells the UI not to offer a sign-in.
 */
export const customSourceUser = (providerId: string, platform: string): ProviderUser => ({
    id: providerId,
    nickname: platform,
    avatarUrl: '',
});

/** Whether a value is a song this provider made. */
export const isCustomSourceSong = (value: unknown, providerId: string): boolean => {
    const ref = (value as SongResult | null)?.sourceRef;
    return ref?.kind === 'online' && ref.providerId === providerId;
};
