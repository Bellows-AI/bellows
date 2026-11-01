/**
 * The leased board write the gate-run and phase-checkpoint records share. Never throws: a 404 or a
 * 409 without the record's own conflict code is a lease that is not this attempt's (`lost`); any
 * other refusal, or a request that failed, is `rejected`.
 */

import type { BoardJob } from './board.js';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

export type Post = (
    path: string,
    body: unknown,
    allow404?: boolean,
    options?: { signal?: AbortSignal | undefined; allow?: readonly number[] }
) => Promise<Response>;

export type LeasedWrite = (
    path: string,
    job: BoardJob,
    write: object,
    signal: AbortSignal | undefined
) => Promise<'ok' | 'lost' | 'rejected'>;

export const leasedWriter =
    (post: Post, conflictCode: string): LeasedWrite =>
    async (path, job, write, signal) => {
        try {
            const response = await post(path, { leaseToken: job.leaseToken, ...write }, true, { signal });
            if (response.ok) return 'ok';
            if (response.status === HTTP_NOT_FOUND) return 'lost';
            if (response.status !== HTTP_CONFLICT) return 'rejected';
            const code = ((await response.json().catch(() => ({}))) as { code?: unknown }).code;
            return code === conflictCode ? 'rejected' : 'lost';
        } catch {
            return 'rejected';
        }
    };
