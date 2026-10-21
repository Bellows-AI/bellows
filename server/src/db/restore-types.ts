/** The restore reads' shapes (issue #775), apart from `job-store-types.ts` to keep that file under its line budget. */

/** The root row's checkpoint pointer (078): which finalized `checkpoint` stream holds the thread's newest state. */
export interface CheckpointPointer {
    jobId: string;
    claimSeq: number;
    executor: string;
    session: string;
    truncated: boolean;
    cause: string | null;
    finalizedAt: Date;
}

/** What a live lease may read of its own thread when the driver restores (issue #775). */
export interface RestoreScope {
    root: string;
    /** Null when no checkpoint has ever finalized for the thread. */
    checkpoint: CheckpointPointer | null;
    /** Every row of the thread; `member` is the author the row's artifacts are filed under. */
    jobs: { id: string; member: string | null; claimSeq: number }[];
}

export type RestoreScopeResult = { result: 'ok'; scope: RestoreScope } | { result: 'missing' } | { result: 'lost' };
