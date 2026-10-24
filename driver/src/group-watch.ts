import { setTimeout as pause } from 'node:timers/promises';

/** How often a group's end is looked for (`K8sDeps.groupWatchMs` and its docker twin override it in tests only). */
export const GROUP_WATCH_MS = 2_000;

/** What a group's watch is given: where to look, who it is for, and what to do on a confirmed end. */
export interface GroupWatch {
    everyMs: number;
    /** Stops the watch quietly: a kill or a stand-down. */
    signal?: AbortSignal | undefined;
    /** Whether the group watched is still the attempt's own: false once it finished, was taken away or replaced. */
    isCurrent: () => boolean;
    /** True only on a CONFIRMED end of the group's supervisor; false or a throw is an unconfirmed read and keeps watching. */
    confirmedEnd: (signal?: AbortSignal) => Promise<boolean>;
    /** The group is gone: its waiting and later steps fail at once. Called once. */
    release: () => void;
}

/**
 * Watches a group for its whole life — from its supervisor's first contact to its forgetting — and
 * releases its steps on the first confirmed end (#967). Without it, a gate waiting on a supervisor
 * that died after its report waits out its own timeout. A read that fails, times out or answers
 * nothing is no end: it is read again.
 */
export async function watchGroupEnd(watch: GroupWatch): Promise<void> {
    const { everyMs, signal, isCurrent, confirmedEnd, release } = watch;
    for (;;) {
        try {
            // Unref'd: a watch never keeps the process alive.
            await pause(everyMs, undefined, { ref: false, ...(signal ? { signal } : {}) });
        } catch {
            return; // aborted: the group's owner stood it down.
        }
        if (!isCurrent()) return;
        const ended = await confirmedEnd(signal).catch(() => false);
        if (!ended) continue;
        if (isCurrent()) release();
        return;
    }
}
