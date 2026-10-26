/**
 * The facts the orphan reaper decides a task volume on (issue #775), copied from the server's
 * `JobThreadFacts` rather than imported. `lastFinalizedAt` is when the thread's newest attempt
 * finalized (null while it has not); `artifactsComplete` is false while that attempt has an artifact
 * stream still pending; `checkpoint` is `complete` only when the root's pointer names that attempt whole;
 * `lastJobId` / `lastClaimSeq` name that attempt (issue #938).
 */
export interface BoardThreadFacts {
    live: boolean;
    lastFinalizedAt: string | null;
    artifactsComplete: boolean;
    checkpoint: 'complete' | 'truncated' | 'none';
    checkpointFinalizedAt: string | null;
    lastJobId: string;
    lastClaimSeq: number;
}

const CHECKPOINT_STATES: readonly string[] = ['complete', 'truncated', 'none'];

const isTimeOrNull = (value: unknown): boolean =>
    value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));

/** Whether a row's `thread` is fully readable: every field present and well-shaped, its ids shaped like `idShape`. */
export const isThreadFacts = (value: unknown, idShape: RegExp): value is BoardThreadFacts => {
    const thread = value as Partial<BoardThreadFacts> | null;
    return (
        typeof thread === 'object' &&
        thread !== null &&
        typeof thread.live === 'boolean' &&
        typeof thread.artifactsComplete === 'boolean' &&
        CHECKPOINT_STATES.includes(thread.checkpoint as string) &&
        isTimeOrNull(thread.lastFinalizedAt) &&
        isTimeOrNull(thread.checkpointFinalizedAt) &&
        idShape.test(String(thread.lastJobId)) &&
        Number.isInteger(thread.lastClaimSeq) &&
        Number(thread.lastClaimSeq) >= 0
    );
};
