import { type RefCallback, useCallback, useLayoutEffect, useRef, useState } from 'react';

/** How close to its bottom (px) a reader still counts as following the tail. */
export const NEAR_BOTTOM_PX = 48;

export interface ScrollMetrics {
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
}

/** Whether a scroller sits at, or within `threshold` of, the end of its content. */
export function isNearBottom(
    { scrollTop, clientHeight, scrollHeight }: ScrollMetrics,
    threshold: number = NEAR_BOTTOM_PX
): boolean {
    return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * What to do when a render has landed content. `previousHeight` is the scroll height before it
 * landed (null: the first content this scroller ever showed); the live metrics are read after it
 * landed. Content grows below the reader, so scrollTop did not move — judge nearness against the
 * OLD height, or every append would look like the reader scrolled away.
 */
export function decideOnContent(
    previousHeight: number | null,
    live: ScrollMetrics
): { follow: boolean; unseen: boolean } {
    if (previousHeight === null) return { follow: true, unseen: false };
    const { scrollTop, clientHeight, scrollHeight } = live; // a DOM element's geometry is not spreadable
    if (isNearBottom({ scrollTop, clientHeight, scrollHeight: previousHeight })) return { follow: true, unseen: false };
    return { follow: false, unseen: scrollHeight > previousHeight };
}

/**
 * Keeps a live-following scroller on its tail only while its reader is near the bottom.
 * Attach the returned `ref` to the scroll element; pass `signal` (anything that changes when
 * content lands). The near-bottom decision reads the element's live geometry in the layout
 * effect that follows the render — no flag cached from earlier. `hasUnseen` is true when content
 * landed under a reader who scrolled up; `jumpToLatest` scrolls to the end and clears it.
 */
export function useStickToBottom<T extends HTMLElement>(signal: unknown) {
    const [element, setElement] = useState<T | null>(null);
    const [hasUnseen, setHasUnseen] = useState(false);
    const tracked = useRef<T | null>(null);
    const lastHeight = useRef<number | null>(null);
    const ref: RefCallback<T> = useCallback((node) => setElement(node), []);

    // `signal` is the trigger: it changes when content lands.
    useLayoutEffect(() => {
        if (element === null) return;
        const previous = tracked.current === element ? lastHeight.current : null;
        tracked.current = element;
        const verdict = decideOnContent(previous, element);
        if (verdict.follow) element.scrollTop = element.scrollHeight;
        setHasUnseen((seen) => (verdict.follow ? false : verdict.unseen || seen));
        lastHeight.current = element.scrollHeight;
    }, [element, signal]);

    // The reader's own scrolling: re-record the height it was read at, and clear the flag on
    // arriving back at the bottom.
    useLayoutEffect(() => {
        if (element === null) return;
        const onScroll = () => {
            lastHeight.current = element.scrollHeight;
            if (isNearBottom(element)) setHasUnseen(false);
        };
        element.addEventListener('scroll', onScroll, { passive: true });
        return () => element.removeEventListener('scroll', onScroll);
    }, [element]);

    const jumpToLatest = useCallback(() => {
        if (element === null) return;
        element.scrollTop = element.scrollHeight;
        lastHeight.current = element.scrollHeight;
        setHasUnseen(false);
    }, [element]);

    return { ref, hasUnseen, jumpToLatest };
}
