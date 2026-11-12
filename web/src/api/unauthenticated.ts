/**
 * How an expired session reaches the gate.
 *
 * `useStats` polls every two seconds while a fetch is running, so a session expiring in the
 * middle of a poll is not an edge case — any tab left open overnight meets an expired session on
 * its next request. The 401 arrives at the data layer, but the thing that has to react to it is
 * the gate, and they have no component relationship: the gate renders the tree that contains the poll.
 *
 * A Set rather than a single slot, because more than one `useSession` instance can be mounted at
 * once (the shell reads the session for the user menu, and the settings and environment pages read
 * it for themselves). A single slot let the second mount steal it and the first unmount silence the
 * gate for both.
 */
const listeners = new Set<() => void>();

/** The status code that means "the session is gone"; `request()` hands the gate the news. */
export const HTTP_STATUS_UNAUTHORIZED = 401;

export function reportUnauthenticated(): void {
    for (const listener of listeners) listener();
}

/** Registers a 401 listener; returns the unsubscribe. `useSession` is one caller of it. */
export function subscribeUnauthenticated(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
