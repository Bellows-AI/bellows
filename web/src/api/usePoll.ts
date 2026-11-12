import { useCallback, useEffect, useState } from 'react';
import { request, type RequestOptions, type RequestResult } from './request.js';

/** What one tick of the chain answered, as far as the next tick's delay is concerned. */
export type PollOutcome<T> =
    | { kind: 'ok'; value: T; status: number }
    | { kind: 'partial'; value: T; status: number }
    | { kind: 'error'; error: string };

export interface PollOptions<T> {
    /**
     * Milliseconds until the next tick, or null to stop the chain (`refresh()` starts it again). `hidden`
     * is the tab's state NOW, so a hidden tab can poll slower. An error outcome is answered too: a
     * failed tick keeps the chain alive unless this says otherwise.
     */
    next: (outcome: PollOutcome<T>, hidden: boolean) => number | null;
    /** Runtime shape check of a 2xx body; one that fails it is an error outcome, never a cast. */
    guard?: (body: unknown, status: number) => body is T;
    /** The sentence for a body that fails `guard` or is not JSON. */
    malformed?: string;
    /** The caller's fallback wording for a refusal that named nothing. */
    verb?: string;
    /** A 2xx status that means "still working": its body is `partial`, and `data` and `error` stay as they are. */
    isPartial?: (status: number) => boolean;
    /** A hidden tab that becomes visible asks at once instead of waiting out its armed tick. */
    refetchOnVisible?: boolean;
    /** A changed URL keeps what is on screen until the new answer lands, instead of clearing it. */
    keepOnUrlChange?: boolean;
    /** A changed value restarts the chain without a URL change (the stats poll's `live`). */
    restartKey?: unknown;
}

export interface UsePoll<T> {
    data: T | null;
    /** The last "still working" body, cleared by the next settled answer. */
    partial: T | null;
    error: string | null;
    /** True from the start of a chain until its first settled answer; false for a null URL. */
    loading: boolean;
    /** Ask now: aborts the tick in flight and starts the chain over. */
    refresh: () => void;
}

interface Held<T> {
    url: string | null;
    data: T | null;
    partial: T | null;
    error: string | null;
    pending: boolean;
}

const blank = <T>(url: string | null): Held<T> => ({
    url,
    data: null,
    partial: null,
    error: null,
    pending: url !== null,
});

type Settled<T> = RequestResult<T>;

/** What a settled tick does to the held state. A failure keeps `data`: an outage leaves the last true answer the best view there is. */
function landed<T>(
    previous: Held<T>,
    url: string,
    result: Settled<T>,
    isPartial: PollOptions<T>['isPartial']
): Held<T> {
    if (!result.ok) {
        return result.unauthenticated
            ? { ...previous, pending: false }
            : { ...previous, error: result.error, pending: false };
    }
    if (isPartial?.(result.status)) return { ...previous, partial: result.value, pending: true };
    return { url, data: result.value, partial: null, error: null, pending: false };
}

/**
 * What a chain's start does to the held state. A new URL is a different question, so its predecessor's
 * answer goes (unless the caller keeps what is on screen); a restart on the SAME URL (`refresh`, a
 * `restartKey`) keeps everything: an answer the page holds is still the best view until the new one lands.
 */
function started<T>(previous: Held<T>, url: string, keep: boolean): Held<T> {
    if (previous.url !== url) return keep ? { ...previous, url, pending: true } : blank<T>(url);
    return keep ? { ...previous, pending: true } : previous;
}

/** The request a tick sends: the poll's shape check and wording, under its own abort signal. */
function requestOptionsOf<T>(options: PollOptions<T>, signal: AbortSignal): RequestOptions<T> {
    const { guard, malformed, verb } = options;
    return {
        signal,
        ...(guard ? { guard } : {}),
        ...(malformed ? { malformed } : {}),
        ...(verb ? { verb } : {}),
    };
}

/** What a settled tick tells `next`. */
function outcomeOf<T>(result: Settled<T>, isPartial: PollOptions<T>['isPartial']): PollOutcome<T> {
    if (!result.ok) return { kind: 'error', error: result.error };
    const kind = isPartial?.(result.status) ? 'partial' : 'ok';
    return { kind, value: result.value, status: result.status };
}

/**
 * Whether a tab coming back to the front should ask now instead of waiting out its armed tick. A tick
 * armed while hidden waits the hidden pace, so an open page would otherwise show its old answer for up
 * to a minute. `armed` is false while a request is in flight: that one re-arms itself, and asking
 * again would overlap it.
 */
export function refetchOnVisible(on: boolean, hidden: boolean, armed: boolean): boolean {
    return on && !hidden && armed;
}

/**
 * The ONE poll chain of `web/src/api`: one abortable request at a time, re-armed by `next`, and a
 * superseded chain (a new URL, a `refresh`, an unmount) never lands: after every await the tick checks
 * its own signal before it touches state. A 401 goes to the gate (inside `request`) and ends the chain,
 * since every later request would 401 too. The answer is keyed to its URL, so another URL's rows are
 * never shown under this one's heading, not even for the one render before the new chain starts.
 */
export function usePoll<T>(url: string | null, options: PollOptions<T>): UsePoll<T> {
    const [held, setHeld] = useState<Held<T>>(() => blank<T>(url));
    const [nonce, setNonce] = useState(0);
    const refresh = useCallback(() => setNonce((n) => n + 1), []);
    // The latest options, read by a tick that is already running; the chain itself restarts only on
    // the URL, `refresh` and `restartKey`.
    const latest = useLatest(options);

    useEffect(() => {
        if (url === null) {
            setHeld(blank<T>(null));
            return;
        }
        const controller = new AbortController();
        const { signal } = controller;
        let timer: number | null = null;
        setHeld((previous) => started(previous, url, latest.current.keepOnUrlChange === true));

        const arm = (outcome: PollOutcome<T>) => {
            const delay = latest.current.next(outcome, document.hidden);
            if (delay === null) return;
            timer = window.setTimeout(() => {
                timer = null;
                void tick();
            }, delay);
        };

        const tick = async () => {
            const { isPartial } = latest.current;
            const result = await request<T>(url, requestOptionsOf(latest.current, signal));
            if (signal.aborted) return;
            setHeld((previous) => landed(previous, url, result, isPartial));
            // The gate takes over a lost session, which ends the chain: a banner would never clear.
            if (!result.ok && result.unauthenticated) return;
            arm(outcomeOf(result, isPartial));
        };

        const onVisibilityChange = () => {
            if (!refetchOnVisible(latest.current.refetchOnVisible === true, document.hidden, timer !== null)) return;
            window.clearTimeout(timer!);
            timer = null;
            void tick();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        void tick();
        return () => {
            controller.abort();
            document.removeEventListener('visibilitychange', onVisibilityChange);
            if (timer !== null) window.clearTimeout(timer);
        };
        // `latest` is a ref; the chain restarts on exactly these.
    }, [url, nonce, options.restartKey]);

    return viewOf(held, url, options.keepOnUrlChange === true, refresh);
}

/**
 * What the hook shows: the held answer when it is this URL's. For the one render of a changed URL,
 * before its chain has started, never the old URL's answer (unless the caller keeps what is on screen).
 */
function viewOf<T>(held: Held<T>, url: string | null, keep: boolean, refresh: () => void): UsePoll<T> {
    if (held.url === url) {
        return { data: held.data, partial: held.partial, error: held.error, loading: held.pending, refresh };
    }
    return {
        data: keep ? held.data : null,
        partial: keep ? held.partial : null,
        error: keep ? held.error : null,
        loading: url !== null,
        refresh,
    };
}

function useLatest<V>(value: V): { current: V } {
    const [box] = useState<{ current: V }>(() => ({ current: value }));
    box.current = value;
    return box;
}
