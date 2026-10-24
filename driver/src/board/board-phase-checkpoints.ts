/**
 * The post-run phase checkpoints' two board calls (issue #829). Split out of `board.ts` for its
 * line budget; `createBoard` is the only importer. Neither throws: a write the board did not take
 * and a read it did not answer are both "no checkpoint", and the caller runs the phase again.
 */

import type { BoardJob } from './board.js';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const CONFLICT_CODE = 'PHASE_CHECKPOINT_CONFLICT';

/**
 * The phases that leave a checkpoint, in the order they run (copied from the board's): the pre-agent
 * setup outcome, then the post-run phases.
 */
export const CHECKPOINT_PHASES = ['setup', 'gates', 'post', 'publish'] as const;
export type CheckpointPhase = (typeof CHECKPOINT_PHASES)[number];

/** One checkpoint the board stored: the claim that wrote it, the tree its phase ran against, its outcome. */
export interface PhaseCheckpoint {
    phase: CheckpointPhase;
    claimSeq: number;
    tree: string | null;
    result: unknown;
}

/** A checkpoint to record: the run it belongs to, its phase, the tree it ran against and its outcome. */
export interface PhaseCheckpointWrite {
    runClaimSeq: number;
    phase: CheckpointPhase;
    tree: string | null;
    result: unknown;
}

type Post = (
    path: string,
    body: unknown,
    allow404?: boolean,
    options?: { signal?: AbortSignal | undefined; allow?: readonly number[] }
) => Promise<Response>;

/** A row read field by field: anything the driver cannot vouch for makes the whole answer unreadable. */
function rowOf(raw: unknown): PhaseCheckpoint | null {
    const row = raw as Partial<PhaseCheckpoint> | null;
    if (typeof row !== 'object' || row === null) return null;
    if (!CHECKPOINT_PHASES.includes(row.phase as CheckpointPhase)) return null;
    if (typeof row.claimSeq !== 'number' || !Number.isSafeInteger(row.claimSeq) || row.claimSeq < 1) return null;
    if (row.tree !== null && typeof row.tree !== 'string') return null;
    if (!('result' in row)) return null;
    return { phase: row.phase!, claimSeq: row.claimSeq, tree: row.tree, result: row.result };
}

export interface PhaseCheckpointBoard {
    /**
     * Records a post-run phase's outcome on the board under the lease (issue #829), for the run
     * `runClaimSeq` started. Never throws: `lost` when the lease is not this attempt's, `rejected`
     * for anything else the board did not take — the run goes on either way.
     */
    phaseCheckpoint(
        job: BoardJob,
        checkpoint: PhaseCheckpointWrite,
        signal?: AbortSignal
    ): Promise<'ok' | 'lost' | 'rejected'>;
    /**
     * The checkpoints of the run `runClaimSeq` started. Null for any answer the driver cannot fully
     * read (non-2xx, a lost lease, a malformed row, an aborted request): an unconfirmed read is
     * never an empty one, so the caller runs every phase again.
     */
    phaseCheckpoints(job: BoardJob, runClaimSeq: number, signal?: AbortSignal): Promise<PhaseCheckpoint[] | null>;
}

export function phaseCheckpointCalls(post: Post): PhaseCheckpointBoard {
    return {
        async phaseCheckpoint(job, checkpoint, signal) {
            try {
                const response = await post(
                    `/api/jobs/${job.id}/phase-checkpoint`,
                    { leaseToken: job.leaseToken, ...checkpoint },
                    true,
                    { signal }
                );
                if (response.ok) return 'ok';
                if (response.status === HTTP_NOT_FOUND) return 'lost';
                if (response.status !== HTTP_CONFLICT) return 'rejected';
                const code = ((await response.json().catch(() => ({}))) as { code?: unknown }).code;
                return code === CONFLICT_CODE ? 'rejected' : 'lost';
            } catch {
                return 'rejected';
            }
        },

        async phaseCheckpoints(job, runClaimSeq, signal) {
            try {
                const response = await post(
                    `/api/jobs/${job.id}/phase-checkpoints`,
                    { leaseToken: job.leaseToken, runClaimSeq },
                    false,
                    { signal }
                );
                if (!response.ok) return null;
                const raw = ((await response.json()) as { checkpoints?: unknown }).checkpoints;
                if (!Array.isArray(raw)) return null;
                const rows = raw.map(rowOf);
                if (rows.some((r) => r === null)) return null;
                const checkpoints = rows as PhaseCheckpoint[];
                // One row per phase: a duplicate is a board answer the driver cannot read.
                if (new Set(checkpoints.map((c) => c.phase)).size !== checkpoints.length) return null;
                return checkpoints;
            } catch {
                return null;
            }
        },
    };
}
