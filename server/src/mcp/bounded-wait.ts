import type { Tagged } from './result.js';

/**
 * The tools that wait (`wait_task`, `wait_batch`) hold one call open for at most `WAIT_BUDGET_MAX_S`: TS SDK clients
 * time a request out at 60 s, and the whole call must answer before that. The loop knows nothing about tasks; a
 * caller supplies `hold` (one board long-poll of at most `seconds`) and says whether it settled.
 */
export const WAIT_BUDGET_DEFAULT_S = 45;
export const WAIT_BUDGET_MAX_S = 55;
/** What is kept back from the budget so the answer, and the re-read behind it, still land inside it. */
export const WAIT_HEADROOM_S = 3;
/** The longest hold the board accepts (`WAIT_TIMEOUT_MAX_S` in `server/src/routes/jobs/job-limits.ts`). */
export const WAIT_HOLD_MAX_S = 60;
const MS_PER_SECOND = 1000;

/** What one hold found. `open`: the thing is still moving. `stop`: the call is over with this answer. */
export type Hold<T> =
    | { readonly kind: 'settled'; readonly value: T }
    | { readonly kind: 'open' }
    | { readonly kind: 'stop'; readonly tagged: Tagged };

export type WaitEnd<T> =
    | { readonly kind: 'settled'; readonly value: T }
    | { readonly kind: 'timeout' }
    | { readonly kind: 'stopped'; readonly tagged: Tagged }
    | { readonly kind: 'aborted' };

export interface BoundedWait<T> {
    /** The requested budget in seconds, possibly fractional; clamped to `WAIT_BUDGET_MAX_S`. */
    readonly budgetSeconds: number;
    readonly now: () => number;
    /** The client leaving ends the loop; the in-flight hold carries the same signal and ends with it. */
    readonly signal: AbortSignal;
    /** One long-poll of a whole number of seconds, `1..WAIT_HOLD_MAX_S`, never longer than what is left of the budget. */
    hold(seconds: number): Promise<Hold<T>>;
    /** Called after each hold that left the thing open, with the seconds spent of the budget. */
    progress?(elapsedSeconds: number, budgetSeconds: number): Promise<void>;
}

/** The effective budget: what the caller asked for, never above the maximum. */
export const effectiveBudgetSeconds = (requested: number): number => Math.min(requested, WAIT_BUDGET_MAX_S);

/**
 * The whole hold in seconds the budget still allows, or 0 when none does. Always an integer, and never more than the
 * board's cap, so no hold is started that would outlive the deadline (or ask for `timeout=0`).
 */
export const holdSecondsLeft = (deadlineAt: number, now: number): number => {
    const seconds = Math.floor(Math.min(WAIT_HOLD_MAX_S, (deadlineAt - now) / MS_PER_SECOND - WAIT_HEADROOM_S));
    return seconds >= 1 ? seconds : 0;
};

/**
 * Holds until the thing settles or the absolute deadline (`start + budget`) leaves no room for another hold. A replica
 * lost mid-wait is a transport error out of `hold`; nothing is kept between calls, so the client simply calls again.
 */
export async function boundedWait<T>(wait: BoundedWait<T>): Promise<WaitEnd<T>> {
    const start = wait.now();
    const budgetMs = effectiveBudgetSeconds(wait.budgetSeconds) * MS_PER_SECOND;
    const deadlineAt = start + budgetMs;
    for (;;) {
        if (wait.signal.aborted) return { kind: 'aborted' };
        const seconds = holdSecondsLeft(deadlineAt, wait.now());
        if (seconds < 1) return { kind: 'timeout' };
        const held = await wait.hold(seconds);
        if (held.kind === 'settled') return held;
        if (held.kind === 'stop') return { kind: 'stopped', tagged: held.tagged };
        await wait.progress?.(Math.round((wait.now() - start) / MS_PER_SECOND), budgetMs / MS_PER_SECOND);
    }
}
