import { setTimeout as delay } from 'node:timers/promises';

/** A pause that a stand-down cuts short: rejects once `signal` aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** The real pause: `node:timers/promises`, which rejects the moment `signal` aborts. */
export const abortableSleep: Sleep = (ms, signal) => delay(ms, undefined, signal ? { signal } : {});

/** Milliseconds left until the absolute `deadline` (epoch ms); 0 once past, which a request refuses. */
export const timeLeft = (deadline: number): number => Math.max(0, deadline - Date.now());

/**
 * Runs `step` every `everyMs` until it answers a defined value, and answers `undefined` at the
 * bound. Bounded by elapsed wall-clock time, step time included, not a count of polls. The step
 * gets the absolute `deadline` so every nested request it makes can be bounded by `timeLeft`.
 * An aborted `signal` ends the wait before the next step or during the sleep with `abandoned()`.
 */
export async function pollFor<T>(
    opts: {
        ms: number;
        everyMs: number;
        sleep: Sleep;
        signal?: AbortSignal;
        abandoned?: () => Error;
    },
    step: (deadline: number) => Promise<T | undefined>
): Promise<T | undefined> {
    const { ms, everyMs, sleep, signal } = opts;
    const abandoned = opts.abandoned ?? ((): Error => new Error('the wait was abandoned: its signal aborted'));
    const started = Date.now();
    const deadline = started + ms;
    for (let polls = 0; Math.max(polls * everyMs, Date.now() - started) < ms; polls += 1) {
        if (signal?.aborted) throw abandoned();
        const found = await step(deadline);
        if (found !== undefined) return found;
        // The pause after the last poll would only delay the answer.
        if ((polls + 1) * everyMs >= ms) return undefined;
        try {
            await sleep(everyMs, signal);
        } catch (e) {
            if (signal?.aborted) throw abandoned();
            throw e;
        }
    }
    return undefined;
}
