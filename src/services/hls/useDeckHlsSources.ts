// src/services/hls/useDeckHlsSources.ts
// Keeps the app's two audio decks playing HLS sources.
//
// The decks are rendered by App.tsx with `src={automix.deckSrc(deck)}`. That works for every URL
// except a playlist: an `<audio>` element cannot play m3u8 in Chromium, so for those the element is
// handed a MediaSource by hls.js instead.
//
// This hook is the one place that knows which deck holds which source and which instance feeds it.
// It keeps exactly one hls.js instance per deck that needs one:
//
//   - a deck that moves from HLS to a file drops its instance (React then sets the new `src`);
//   - a deck that moves between two HLS sources replaces its instance;
//   - a deck that disappears drops its instance; so does unmounting.
//
// It deliberately does not touch the element's other behaviour: play, pause, seek and the analyser
// keep working on the element, because hls.js feeds that same element through MSE.

import { useEffect, useRef } from 'react';
import { attachHlsSource, isHlsSource } from './hlsSource';

// src/services/hls/useDeckHlsSources.ts

export interface DeckHlsSource {
    /** The element the deck is mounted on, or null before it mounts. */
    element: HTMLAudioElement | null;
    /** The source the deck is showing, as automix resolved it. */
    src: string | null | undefined;
}

/** What one deck currently holds: an attached instance, a pending attach, or nothing. */
type DeckState =
    | { kind: 'attached'; src: string; dispose: () => void }
    | { kind: 'pending'; src: string; cancelled: boolean }
    | { kind: 'none' };

/**
 * Manages HLS for `decks`, one entry per deck, in a stable order.
 *
 * The caller decides what to render as a deck's `src`: for an HLS source it renders none, which is
 * what `isHlsSource` is exported for. Both sides read that one predicate, so they cannot disagree.
 */
export const useDeckHlsSources = (decks: readonly DeckHlsSource[]): void => {
    // deck index -> what it holds. One ref, so the whole state lives with this hook instance and
    // nothing is shared between two callers or two renders.
    const stateRef = useRef<Map<number, DeckState>>(new Map());

    useEffect(() => {
        const state = stateRef.current;

        /** Releases whatever the deck holds and forgets it. A pending attach marks itself cancelled. */
        const release = (index: number) => {
            const current = state.get(index);
            if (!current) return;
            state.delete(index);
            if (current.kind === 'attached') current.dispose();
            else if (current.kind === 'pending') current.cancelled = true;
        };

        const seen = new Set<number>();

        decks.forEach((deck, index) => {
            const { element, src } = deck;
            if (!element) return;
            seen.add(index);

            const wanted = src && isHlsSource(src) ? src : null;
            const current = state.get(index);

            // This deck already holds (or is loading) exactly this source: nothing to do.
            if (wanted && current && current.kind !== 'none' && current.src === wanted) return;

            // Anything else means what it held is stale.
            release(index);
            if (!wanted) return;

            const token: DeckState = { kind: 'pending', src: wanted, cancelled: false };
            state.set(index, token);

            void attachHlsSource(element, wanted).then((dispose) => {
                if (!dispose) return;
                // Superseded while hls.js was loading (another source, or the deck went away):
                // the instance must not stay attached.
                if (token.cancelled || state.get(index) !== token) {
                    dispose();
                    return;
                }
                state.set(index, { kind: 'attached', src: wanted, dispose });
            });
        });

        // Decks that are gone release what they held.
        Array.from(state.keys()).forEach((index) => {
            if (!seen.has(index)) release(index);
        });
    });

    // Unmount: nothing may keep its network requests alive.
    useEffect(() => () => {
        const state = stateRef.current;
        state.forEach((current) => {
            if (current.kind === 'attached') current.dispose();
            else if (current.kind === 'pending') current.cancelled = true;
        });
        state.clear();
    }, []);
};
