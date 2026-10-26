/**
 * Which ad-hoc gate runs a token has in flight, and whether it still admits more (issue #983): the
 * completion pass closes a token and drains it before it reads the gate record, so no ad-hoc run is
 * left on its way to a verdict the pass would not see.
 */
export interface GateAdmission {
    /** Opens the token to runs again: a later attempt of the same claim registers the same token. */
    open(token: string): void;
    /** Forgets the token entirely. */
    forget(token: string): void;
    isClosed(token: string): boolean;
    /** Tracks one admitted run until it settles. */
    admit<T>(token: string, run: Promise<T>): Promise<T>;
    /** Closes the token to new runs and resolves once every admitted one has settled. */
    close(token: string): Promise<void>;
}

export function createGateAdmission(): GateAdmission {
    const inflight = new Map<string, Set<Promise<unknown>>>();
    const closed = new Set<string>();
    return {
        open: (token) => void closed.delete(token),
        forget(token) {
            closed.delete(token);
            inflight.delete(token);
        },
        isClosed: (token) => closed.has(token),
        admit(token, run) {
            const admitted = inflight.get(token) ?? new Set<Promise<unknown>>();
            admitted.add(run);
            inflight.set(token, admitted);
            return run.finally(() => admitted.delete(run));
        },
        async close(token) {
            closed.add(token);
            await Promise.allSettled([...(inflight.get(token) ?? [])]);
        },
    };
}
