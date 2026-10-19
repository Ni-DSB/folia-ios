// src/services/hls/hlsSource.ts
// HLS (m3u8) playback, for the sources that serve one.
//
// Some custom sources hand back a playlist rather than a file: 猫耳FM answers
// `application/vnd.apple.mpegurl`, and so do several podcast and radio sources. Chromium's
// `<audio>` element plays MP4 and WebM natively but not HLS — only Safari does — so those URLs
// need a Media Source Extensions player in front of them.
//
// hls.js is that player. This module owns the decision and the lifecycle: whether a URL needs it,
// and attaching/detaching it to one audio element. It is loaded on demand, so an app that never
// meets an m3u8 never pays for the library.
//
// What it does not do: change the audio element's contract. The element still plays, pauses and
// seeks as before; hls.js feeds it a MediaSource instead of a URL.

// src/services/hls/hlsSource.ts

/**
 * Whether a URL is an HLS playlist by its own shape.
 *
 * Checked before any request is made, so a source that serves HLS is recognised from the URL its
 * provider returned. The query is ignored: these URLs carry signed tokens after `?`.
 */
export const isHlsSource = (url: string | null | undefined): boolean => {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        // `.m3u8` is the playlist extension; `.m3u` is the older one some servers still use.
        return /\.m3u8?$/i.test(parsed.pathname);
    } catch {
        // Not a URL the browser can parse (a blob: URL, a bare path): not ours to attach to.
        return false;
    }
};

/** What hls.js needs from the host, kept narrow so the module can be tested without a browser. */
export type HlsInstance = {
    attachMedia: (element: HTMLMediaElement) => void;
    detachMedia: () => void;
    loadSource: (url: string) => void;
    destroy: () => void;
    on: (event: string, listener: (event: string, data: unknown) => void) => void;
    off: (event: string, listener: (event: string, data: unknown) => void) => void;
};

type HlsConstructor = new (config?: Record<string, unknown>) => HlsInstance;

let hlsConstructorPromise: Promise<HlsConstructor | null> | null = null;

/**
 * The hls.js constructor, loaded once. Resolves to null where it cannot be used — a browser
 * without Media Source Extensions, or a build that does not ship the library.
 */
export const loadHlsConstructor = (): Promise<HlsConstructor | null> => {
    if (hlsConstructorPromise) return hlsConstructorPromise;
    const attempt = (async () => {
        if (typeof window === 'undefined') return null;
        // Without MSE there is nothing for hls.js to feed; the element's own HLS support (Safari)
        // is used instead, which is why this is not a hard failure.
        if (typeof window.MediaSource === 'undefined' && typeof (window as unknown as { ManagedMediaSource?: unknown }).ManagedMediaSource === 'undefined') {
            return null;
        }
        try {
            const module = await import('hls.js');
            const Constructor = (module.default ?? module) as unknown as HlsConstructor & { isSupported?: () => boolean };
            if (typeof Constructor?.isSupported === 'function' && !Constructor.isSupported()) return null;
            return Constructor;
        } catch (error) {
            console.warn('[HLS] hls.js could not be loaded', error);
            return null;
        }
    })();
    hlsConstructorPromise = attempt;
    return attempt;
};

/**
 * Attaches hls.js to one audio element and loads `url` into it.
 *
 * Resolves to a disposer that detaches and destroys the instance, or to null when the URL is not
 * HLS or the player is unavailable. The caller owns the disposer: it must run when the source
 * changes or the element goes away, or the instance keeps its network requests alive.
 */
export const attachHlsSource = async (
    audio: HTMLAudioElement,
    url: string,
): Promise<(() => void) | null> => {
    if (!isHlsSource(url)) return null;
    const Constructor = await loadHlsConstructor();
    if (!Constructor) return null;

    let instance: HlsInstance | null = null;
    try {
        instance = new Constructor({
            // The host's own audio pipeline (the analyser, the automix decks) reads the element, so
            // hls.js must not create its own element; it feeds this one through MSE.
            enableWorker: true,
            // A source that fails is reported once and left alone: the app's own playback-error
            // path decides whether to skip, retry or tell the listener.
            manifestLoadingMaxRetry: 1,
            levelLoadingMaxRetry: 2,
            fragLoadingMaxRetry: 3,
        });
        const active = instance;
        active.on('hlsError', (_event, data) => {
            const detail = (data as { details?: string; fatal?: boolean } | null);
            if (detail?.fatal) {
                console.warn('[HLS] playback failed', detail.details ?? 'unknown');
            }
        });
        active.attachMedia(audio);
        active.loadSource(url);
    } catch (error) {
        console.warn('[HLS] attaching the player failed', error);
        try {
            instance?.destroy();
        } catch {
            // A half-built instance may throw on destroy; nothing to recover.
        }
        return null;
    }

    return () => {
        try {
            instance?.detachMedia();
        } catch {
            // Detaching an already-detached instance is harmless.
        }
        try {
            instance?.destroy();
        } catch {
            // Destroying twice is harmless too.
        }
    };
};
