import { createHash } from 'node:crypto';
import { BoardHttpError } from './board-retry.js';
import type { Board, BoardJob } from './board.js';

/**
 * The two reads of a thread's checkpoint (issue #775): the pointer, and one chunk of its stream.
 * Both run under the live lease (`POST /api/jobs/:id/checkpoint`, `/checkpoint/chunk`). Copied from
 * `server/src/db/restore-types.ts` rather than imported: this package depends on nothing.
 */

/** One chunk of the checkpoint stream: where it starts, how long it is and the sha256 of its bytes. */
export interface CheckpointChunk {
    offset: number;
    length: number;
    sha256: string;
}

/** The checkpoint the board holds for the thread. */
export interface CheckpointPointer {
    bytes: number;
    truncated: boolean;
    chunks: CheckpointChunk[];
}

/** What the board holds: nothing yet, a pointer whose bytes are gone, or a checkpoint. */
export type CheckpointRead = { state: 'none' } | { state: 'gone' } | { state: 'found'; checkpoint: CheckpointPointer };

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const SHA256 = /^[0-9a-f]{64}$/;

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** The pointer, or null when any field is not what the board promises: an unreadable answer is never a verdict. */
function pointerOf(value: unknown): CheckpointPointer | null {
    if (!record(value) || !count(value.bytes) || typeof value.truncated !== 'boolean') return null;
    if (!Array.isArray(value.chunks)) return null;
    const chunks: CheckpointChunk[] = [];
    for (const chunk of value.chunks as unknown[]) {
        if (!record(chunk) || !count(chunk.offset) || !count(chunk.length)) return null;
        if (typeof chunk.sha256 !== 'string' || !SHA256.test(chunk.sha256)) return null;
        chunks.push({ offset: chunk.offset, length: chunk.length, sha256: chunk.sha256 });
    }
    return { bytes: value.bytes, truncated: value.truncated, chunks };
}

type Post = (path: string, body: unknown, allow404?: boolean) => Promise<Response>;

export function checkpointCalls(post: Post): Pick<Board, 'checkpoint' | 'checkpointChunk'> {
    /** A lease the board no longer honours, or a thread it no longer has: this attempt has nothing to restore into. */
    const refused = (job: BoardJob, response: Response): BoardHttpError =>
        new BoardHttpError(
            response.status,
            `job ${job.id}: the board refused the checkpoint read (${response.status})`
        );

    return {
        async checkpoint(job): Promise<CheckpointRead> {
            const response = await post(`/api/jobs/${job.id}/checkpoint`, { leaseToken: job.leaseToken }, true);
            if (response.status === HTTP_CONFLICT || response.status === HTTP_NOT_FOUND) throw refused(job, response);
            const body: unknown = await response.json().catch(() => null);
            if (record(body) && (body.state === 'none' || body.state === 'gone')) return { state: body.state };
            const checkpoint = record(body) && body.state === 'found' ? pointerOf(body.checkpoint) : null;
            if (!checkpoint)
                throw new BoardHttpError(response.status, `job ${job.id}: the checkpoint answer is unreadable`);
            return { state: 'found', checkpoint };
        },

        async checkpointChunk(job, offset) {
            const response = await post(
                `/api/jobs/${job.id}/checkpoint/chunk`,
                { leaseToken: job.leaseToken, offset },
                true
            );
            if (response.status === HTTP_NOT_FOUND) return null;
            if (response.status === HTTP_CONFLICT) throw refused(job, response);
            const sha256 = response.headers.get('x-chunk-sha256') ?? '';
            if (!SHA256.test(sha256))
                throw new BoardHttpError(response.status, `job ${job.id}: a checkpoint chunk came without its sha256`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            // The bytes are checked against the digest the board sent before anyone downstream trusts them.
            if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
                throw new BoardHttpError(
                    response.status,
                    `job ${job.id}: a checkpoint chunk does not match its sha256`
                );
            }
            return { bytes, sha256 };
        },
    };
}
