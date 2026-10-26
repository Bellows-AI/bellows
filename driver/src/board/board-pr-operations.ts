/**
 * The PR-operation record's board call (issue #983). Split out of `board.ts` for its line budget;
 * `createBoard` is the only importer. It never throws: a write the board did not take is "not
 * recorded", and the publish that already landed its PR goes on.
 */

import type { BoardJob } from './board.js';
import { type GateRunBoard, gateRunCalls } from './board-gate-runs.js';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

/** What the driver did to a PR (copied from the board's): opened it, or found it already there. */
export type PrOperationKind = 'created' | 'reused';

/** One managed publish operation as the board stores it. `operationId` is minted per operation. */
export interface PrOperationWrite {
    operationId: string;
    operation: PrOperationKind;
    repo: string;
    prNumber: number;
    prUrl: string;
    branch: string;
}

type Post = (
    path: string,
    body: unknown,
    allow404?: boolean,
    options?: { signal?: AbortSignal | undefined; allow?: readonly number[] }
) => Promise<Response>;

export interface PrOperationBoard {
    /**
     * Records one PR operation under the lease: `ok` only when the board took it. Never throws:
     * `lost` when the lease is not this attempt's, `rejected` for anything else the board did not take.
     */
    prOperation(job: BoardJob, write: PrOperationWrite): Promise<'ok' | 'lost' | 'rejected'>;
}

export function prOperationCalls(post: Post): PrOperationBoard {
    return {
        async prOperation(job, write) {
            try {
                const response = await post(
                    `/api/jobs/${job.id}/pr-operation`,
                    { leaseToken: job.leaseToken, ...write },
                    true
                );
                if (response.ok) return 'ok';
                if (response.status === HTTP_NOT_FOUND || response.status === HTTP_CONFLICT) return 'lost';
                return 'rejected';
            } catch {
                return 'rejected';
            }
        },
    };
}

/** The board's two per-execution records, gate runs (087) and PR operations (088), one composition for `createBoard`. */
export type RecordBoard = GateRunBoard & PrOperationBoard;

export const recordCalls = (post: Post): RecordBoard => ({ ...gateRunCalls(post), ...prOperationCalls(post) });
