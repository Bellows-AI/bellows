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
 * What a content change does, given only whether the reader was following the tail before it:
 * a follower is carried to the new end, anyone else is told there is something unseen. Geometry
 * after the change never enters the decision — new content, or a shorter viewport, moves the
 * numbers under a reader who did not move.
 */
export function decideOnContent(following: boolean): { follow: boolean; unseen: boolean } {
    return { follow: following, unseen: !following };
}

/**
 * Keeps a live-following scroller on its tail only while its reader follows it. `following` is
 * state the READER sets: it is re-read from the element's live geometry on each scroll event
 * only, so a content change or a resize (both move the geometry, neither moves the reader)
 * never flips it, and programmatic scrolls to the end keep it true.
 *
 * Attach `ref` to the scroll element and pass `signal`: a value that changes exactly when
 * meaningful content lands (a string or key, never the element's own scroll height — a capped
 * well grows without its container moving). A resize of the scroller re-pins a follower to the
 * end. `hasUnseen` is true when content landed under a reader who scrolled up; `jumpToLatest`
 * scrolls to the end, resumes following and clears it.
 */
export function useStickToBottom<T extends HTMLElement>(signal: unknown) {
    const [element, setElement] = useState<T | null>(null);
    const [hasUnseen, setHasUnseen] = useState(false);
    const tracked = useRef<T | null>(null);
    const following = useRef(true);
    const ref: RefCallback<T> = useCallback((node) => setElement(node), []);

    // `signal` is the trigger: it changes when content lands.
    useLayoutEffect(() => {
        if (element === null) return;
        if (tracked.current !== element) {
            // A new scroller starts at its tail.
            tracked.current = element;
            following.current = true;
            element.scrollTop = element.scrollHeight;
            return;
        }
        const verdict = decideOnContent(following.current);
        if (verdict.follow) element.scrollTop = element.scrollHeight;
        setHasUnseen((seen) => (verdict.follow ? false : verdict.unseen || seen));
    }, [element, signal]);

    useLayoutEffect(() => {
        if (element === null) return;
        const onScroll = () => {
            following.current = isNearBottom(element);
            if (following.current) setHasUnseen(false);
        };
        element.addEventListener('scroll', onScroll, { passive: true });
        const observer = new ResizeObserver(() => {
            if (following.current) element.scrollTop = element.scrollHeight;
        });
        observer.observe(element);
        return () => {
            element.removeEventListener('scroll', onScroll);
            observer.disconnect();
        };
    }, [element]);

    const jumpToLatest = useCallback(() => {
        if (element === null) return;
        following.current = true;
        element.scrollTop = element.scrollHeight;
        setHasUnseen(false);
    }, [element]);

    return { ref, hasUnseen, jumpToLatest };
}
