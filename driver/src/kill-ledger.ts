import type { BoardJob } from './board/board.js';
import type { KillRecord } from './termination.js';

/**
 * What this driver did to an attempt, in one place per runner and keyed by lease token: the
 * in-memory "this driver ended it" (a supervised stop, a hard kill) and the durable record of why,
 * written by the executor where the claim that adopts the run reads it back (its adoption primitive). One instance per Runner,
 * so two runners addressing one attempt never see each other's kill.
 */
export interface KillLedger {
    /** A hard kill takes the whole group down, so it is a stop too. */
    note(job: BoardJob, kind: 'stopped' | 'hard'): void;
    was(job: BoardJob): { stopped: boolean; hard: boolean };
    forget(job: BoardJob): void;
    /** Aborts when this driver ends the attempt (`note`, either kind); fresh again after `forget`. */
    signal(job: BoardJob): AbortSignal;
    /**
     * Aborts `abandoned(job)`: the attempt left its group to the next holder (#829). No kill, so
     * `was`/`signal` are untouched — the group is not this driver's to end, only its timers and polls are.
     */
    abandon(job: BoardJob): void;
    /** Aborts when this process abandons the attempt; every in-process timer or poll of the run ends on it. */
    abandoned(job: BoardJob): AbortSignal;
    record(job: BoardJob, kill: KillRecord): Promise<void>;
}

/** The executor's durable write: a marker volume (docker) or a Job annotation (kubernetes). */
export interface KillPrimitives {
    write(job: BoardJob, kill: KillRecord): Promise<void>;
}

export function createKillLedger({ write }: KillPrimitives): KillLedger {
    const stopped = new Set<BoardJob['leaseToken']>();
    const hard = new Set<BoardJob['leaseToken']>();
    const controllers = new Map<BoardJob['leaseToken'], AbortController>();
    const left = new Map<BoardJob['leaseToken'], AbortController>();
    const leftOf = (job: BoardJob): AbortController => {
        const known = left.get(job.leaseToken);
        if (known) return known;
        const fresh = new AbortController();
        left.set(job.leaseToken, fresh);
        return fresh;
    };
    const controllerOf = (job: BoardJob): AbortController => {
        const known = controllers.get(job.leaseToken);
        if (known) return known;
        const fresh = new AbortController();
        controllers.set(job.leaseToken, fresh);
        return fresh;
    };
    return {
        note: (job, kind) => {
            stopped.add(job.leaseToken);
            controllerOf(job).abort();
            if (kind === 'hard') hard.add(job.leaseToken);
        },
        was: (job) => ({ stopped: stopped.has(job.leaseToken), hard: hard.has(job.leaseToken) }),
        forget: (job) => {
            stopped.delete(job.leaseToken);
            hard.delete(job.leaseToken);
            controllers.delete(job.leaseToken);
            left.delete(job.leaseToken);
        },
        signal: (job) => controllerOf(job).signal,
        abandon: (job) => leftOf(job).abort(),
        abandoned: (job) => leftOf(job).signal,
        record: write,
    };
}
