import type { JobStatus } from './jobs/job-store-types.js';

/**
 * The facts the reaper decides a task volume on (issue #775), read with the lease lookup rather than
 * per volume. `lastFinalizedAt` is the newest attempt's `finished_at` (null while it is live);
 * `artifactsComplete` is false while any stream of that attempt has chunks without a terminal manifest;
 * `checkpoint` is `complete` only when the root's pointer names THAT attempt and is whole.
 * `lastJobId` / `lastClaimSeq` name the newest attempt that was ever claimed (null when none was): the identity a late transcript export (issue
 * #938) uploads under.
 */
export interface JobThreadFacts {
    live: boolean;
    lastFinalizedAt: string | null;
    artifactsComplete: boolean;
    checkpoint: 'complete' | 'truncated' | 'none';
    checkpointFinalizedAt: string | null;
    lastJobId: string | null;
    lastClaimSeq: number | null;
}

/**
 * One row of the batched lease lookup the orphan reaper sweeps with (issue #301): the job's
 * status and its CURRENT lease token — null when the row holds none, which is what marks every
 * labelled object of the job as a dead attempt's. An id the board does not know is absent from
 * the answer, never a row with a made-up status: absence IS the verdict the reaper acts on.
 */
export interface JobLeaseInfo {
    id: string;
    status: JobStatus;
    leaseToken: string | null;
    /** Only on a thread's ROOT row (issue #775): what the reaper decides the thread's task volume on. */
    thread?: JobThreadFacts;
}
