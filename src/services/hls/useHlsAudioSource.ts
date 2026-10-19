// src/services/hls/useHlsAudioSource.ts
// Puts an HLS source onto the app's audio decks.
//
// The decks are plain `<audio src>` elements: React sets `src` and the browser loads it. An HLS
// URL cannot work that way, so for those the element is handed a MediaSource by hls.js instead and
// `src` is cleared. This hook owns that switch for one element:
//
//   - a normal URL: clear any HLS instance, set `src` as usual;
//   - an HLS URL: attach hls.js and leave `src` alone (hls.js sets it through MSE).
//
// It runs before React commits the `src` attribute, so an element never briefly loads a playlist as
// if it were a file. The instance is destroyed when the URL changes, the element changes, or the
// component unmounts — otherwise its network requests outlive the song.

import { useEffect, useRef } from 'react';
import { attachHlsSource, isHlsSource } from './hlsSource';

// src/services/hls/useHlsAudioSource.ts

/**
 * Applies `url` to `audio`, using hls.js when the URL is a playlist.
 *
 * `audio` is passed as a value rather than a ref because the app has two interchangeable decks: the
 * element that should carry the source changes with the song, and the effect has to re-run when it
 * does.
 */
export const useHlsAudioSource = (
    audio: HTMLAudioElement | null,
    url: string | null | undefined,
): void => {
    // The disposer for whatever instance is attached right now.
    const disposeRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        if (!audio) return undefined;

        const previous = disposeRef.current;
        const isHls = Boolean(url) && isHlsSource(url);

        if (!isHls) {
            // Leaving HLS for a plain file: drop the instance first so it cannot keep feeding a
            // MediaSource to an element that is about to load a URL.
            if (previous) {
                disposeRef.current = null;
                previous();
            }
            return undefined;
        }

        // A new playlist replaces the old instance; one instance per element per URL.
        if (previous) {
            disposeRef.current = null;
            previous();
        }

        let cancelled = false;
        void attachHlsSource(audio, url as string).then((dispose) => {
            if (!dispose) return;
            if (cancelled) {
                // The URL changed while hls.js was loading: this instance is already obsolete.
                dispose();
                return;
            }
            disposeRef.current = dispose;
        });

        return () => {
            cancelled = true;
        };
        // `audio` and `url` are the whole input: a new either one means a new source.
    }, [audio, url]);

    // The last instance is destroyed when the hook goes away.
    useEffect(() => () => {
        const dispose = disposeRef.current;
        disposeRef.current = null;
        if (dispose) dispose();
    }, []);
};
