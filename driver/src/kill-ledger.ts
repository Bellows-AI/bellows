import type { BoardJob } from './board.js';
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
    record(job: BoardJob, kill: KillRecord): Promise<void>;
}

/** The executor's durable write: a marker volume (docker) or a Job annotation (kubernetes). */
export interface KillPrimitives {
    write(job: BoardJob, kill: KillRecord): Promise<void>;
}

export function createKillLedger({ write }: KillPrimitives): KillLedger {
    const stopped = new Set<BoardJob['leaseToken']>();
    const hard = new Set<BoardJob['leaseToken']>();
    return {
        note: (job, kind) => {
            stopped.add(job.leaseToken);
            if (kind === 'hard') hard.add(job.leaseToken);
        },
        was: (job) => ({ stopped: stopped.has(job.leaseToken), hard: hard.has(job.leaseToken) }),
        forget: (job) => {
            stopped.delete(job.leaseToken);
            hard.delete(job.leaseToken);
        },
        record: write,
    };
}
