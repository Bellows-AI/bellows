/**
 * Host stalls (#946, #972): a loaded host takes the CPU away from this process for longer than a lease lasts. The
 * simulated board, drivers, supervisors and cluster all live in this one process, so a stall freezes the whole
 * world; a watcher on the event loop measures it. The gremlin matches an unexplained interruption against the stalls
 * in its silence; the played board's `loopNow` leaves them out, so a lease is never judged against time nothing ran.
 */

/** The loop watcher's tick, and the least lag it counts as a stall (a smaller one is scheduling noise). */
export const STALL_TICK_MS = 25;
export const STALL_MIN_MS = 30;

/** A stretch in which the event loop did not turn: `ms` long, ending at `at` (wall clock). */
export interface Stall {
    at: number;
    ms: number;
}

/** How much of the window `[from, to]` the loop spent stalled. */
export function stalledIn(stalls: readonly Stall[], from: number, to: number): number {
    return stalls.reduce((sum, s) => sum + Math.max(0, Math.min(s.at, to) - Math.max(s.at - s.ms, from)), 0);
}

/** The longest single stall in the window `[from, to]`. */
export const worstStallIn = (stalls: readonly Stall[], from: number, to: number) =>
    Math.max(0, ...stalls.filter((s) => s.at > from && s.at - s.ms < to).map((s) => s.ms));

/** Holds the whole process, as a host that takes the CPU away does: no timer, socket or heartbeat runs meanwhile. */
export function busyWait(ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        /* held on purpose */
    }
}

/**
 * The wall clock `wallNow` with the loop's stalled time taken out: `committed` is the stalled time the watcher has
 * recorded, and a tick overdue by a stall's worth (`lastBeat` older than a tick plus `STALL_MIN_MS`) has not been
 * recorded yet. A timer that fires after a stall can run before that overdue tick, and must not see the stall as elapsed
 * because of that order.
 */
export function loopTime(wallNow: number, committed: number, lastBeat: number): number {
    const lag = wallNow - lastBeat - STALL_TICK_MS;
    return wallNow - committed - (lag >= STALL_MIN_MS ? lag : 0);
}

/** Watches the event loop for stalls; `loopNow()` never goes backwards. */
export class StallWatch {
    readonly stalls: Stall[] = [];
    private committed = 0;
    private lastBeat = Date.now();
    private high = 0;
    private readonly timer = setInterval(() => {
        const now = Date.now();
        const lag = now - this.lastBeat - STALL_TICK_MS;
        if (lag >= STALL_MIN_MS) {
            this.stalls.push({ at: now, ms: lag });
            this.committed += lag;
        }
        this.lastBeat = now;
    }, STALL_TICK_MS).unref();

    /** The wall clock with the loop's stalled time taken out: it stands still while the host holds the process. */
    readonly loopNow = () => {
        this.high = Math.max(this.high, loopTime(Date.now(), this.committed, this.lastBeat));
        return this.high;
    };

    stop = () => clearInterval(this.timer);
}
