import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, Job, JobStore } from '../src/db/jobs/job-store-types.js';
import { testOrg } from './fixtures.js';

/*
 * What the docker lane's board-row checks read (scripts/lanes/jobs/{orphan-reaper,node-disruption,driver-kill,
 * run-deadline}.sh) on the real store: the same rows, the same strings, with a scripted driver in place of
 * the real one. The lane keeps what only a daemon can show (containers, supervisors, logs).
 */

/** The reasons the driver records (driver/src/recovery.ts) and the board records for a lease expiry. */
export const REASONS = {
    // Literal on purpose: the lane compared this exact text, so a reworded constant must fail here.
    expired: 'the lease expired: its driver went silent',
    drained: 'the driver was drained',
    adopted: 'adopted the finished runner of claim 1, whose driver was lost',
    tookOver: 'took over the running agent of claim 1, whose driver was lost',
} as const;

export const WORKER = 'lane-worker';

export interface LaneRig {
    sql: Sql;
    store: JobStore;
    /** A queued job allowed one attempt (the lane's `last_attempt`), so an expiry spending one would retire it dead. */
    lastAttempt: () => Promise<string>;
    claim: () => Promise<Claim>;
}

export const laneRig = (sql: Sql, orgId = testOrg()): LaneRig => {
    const store = createJobStore({ sql, orgId });
    return {
        sql,
        store,
        lastAttempt: async () => {
            const job = await store.create('lane command', null, { repo: null, executor: null });
            if (typeof job === 'string') throw new Error(job);
            await sql`update job set max_attempts = 1 where id = ${job.id}`;
            return job.id;
        },
        claim: async () => {
            const claim = await store.claim(WORKER, 60);
            if (!claim) throw new Error('nothing was claimable');
            return claim;
        },
    };
};

/** The lane's `interruptions_of`: "<count>|<claimSeq of the first>|<reason of the first>". */
export const interruptionsOf = (job: Pick<Job, 'interruptions'>): string => {
    const list = job.interruptions ?? [];
    return `${list.length}|${list[0]?.claimSeq ?? ''}|${list[0]?.reason ?? ''}`;
};
