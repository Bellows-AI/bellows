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

/** One raw Claude transcript stream of the thread: an attempt's bytes of one session, with their chunks. */
export interface TranscriptStream {
    jobId: string;
    claimSeq: number;
    executor: string;
    session: string;
    bytes: number;
    chunks: CheckpointChunk[];
}

/** The coordinates of one transcript stream. */
export type TranscriptRef = Pick<TranscriptStream, 'jobId' | 'claimSeq' | 'session'>;

/** What the board holds: nothing yet, a pointer whose bytes are gone, or a checkpoint. */
export type CheckpointRead = { state: 'none' } | { state: 'gone' } | { state: 'found'; checkpoint: CheckpointPointer };

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const SHA256 = /^[0-9a-f]{64}$/;

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function chunksOf(value: unknown): CheckpointChunk[] | null {
    if (!Array.isArray(value)) return null;
    const chunks: CheckpointChunk[] = [];
    for (const chunk of value as unknown[]) {
        if (!record(chunk) || !count(chunk.offset) || !count(chunk.length)) return null;
        if (typeof chunk.sha256 !== 'string' || !SHA256.test(chunk.sha256)) return null;
        chunks.push({ offset: chunk.offset, length: chunk.length, sha256: chunk.sha256 });
    }
    return chunks;
}

/** The stream, or null when any field is not what the board promises. */
function streamOf(value: unknown): TranscriptStream | null {
    if (!record(value) || typeof value.jobId !== 'string' || typeof value.session !== 'string') return null;
    if (typeof value.executor !== 'string' || !count(value.claimSeq) || !count(value.bytes)) return null;
    const chunks = chunksOf(value.chunks);
    if (!chunks) return null;
    return {
        jobId: value.jobId,
        claimSeq: value.claimSeq,
        executor: value.executor,
        session: value.session,
        bytes: value.bytes,
        chunks,
    };
}

/** The pointer, or null when any field is not what the board promises: an unreadable answer is never a verdict. */
function pointerOf(value: unknown): CheckpointPointer | null {
    if (!record(value) || !count(value.bytes) || typeof value.truncated !== 'boolean') return null;
    const chunks = chunksOf(value.chunks);
    if (!chunks) return null;
    return { bytes: value.bytes, truncated: value.truncated, chunks };
}

type Post = (
    path: string,
    body: unknown,
    allow404?: boolean,
    options?: { allow?: readonly number[] }
) => Promise<Response>;

const HTTP_UNPROCESSABLE = 422;

/** The board reports the stored bytes of a chunk corrupt (they fail their recorded sha256): never restorable. */
export class CheckpointChunkCorrupt extends Error {}

export function checkpointCalls(
    post: Post
): Pick<Board, 'checkpoint' | 'checkpointChunk' | 'transcripts' | 'transcriptChunk'> {
    /** A lease the board no longer honours, or a thread it no longer has: this attempt has nothing to restore into. */
    const refused = (job: BoardJob, response: Response): BoardHttpError =>
        new BoardHttpError(
            response.status,
            `job ${job.id}: the board refused the checkpoint read (${response.status})`
        );

    /** One chunk under the lease, its bytes checked against the digest the board sent before anyone trusts them. */
    const readChunk = async (job: BoardJob, route: string, params: object, what: string) => {
        const response = await post(`/api/jobs/${job.id}${route}`, { leaseToken: job.leaseToken, ...params }, true, {
            allow: [HTTP_UNPROCESSABLE],
        });
        if (response.status === HTTP_NOT_FOUND) return null;
        if (response.status === HTTP_UNPROCESSABLE) {
            throw new CheckpointChunkCorrupt(`job ${job.id}: the board's stored ${what} is corrupt`);
        }
        if (response.status === HTTP_CONFLICT) throw refused(job, response);
        const sha256 = response.headers.get('x-chunk-sha256') ?? '';
        if (!SHA256.test(sha256))
            throw new BoardHttpError(response.status, `job ${job.id}: ${what} came without its sha256`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
            throw new BoardHttpError(response.status, `job ${job.id}: ${what} does not match its sha256`);
        }
        return { bytes, sha256 };
    };

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

        checkpointChunk: (job, offset) => readChunk(job, '/checkpoint/chunk', { offset }, 'a checkpoint chunk'),

        async transcripts(job) {
            const response = await post(`/api/jobs/${job.id}/transcripts`, { leaseToken: job.leaseToken }, true);
            if (response.status === HTTP_CONFLICT || response.status === HTTP_NOT_FOUND) throw refused(job, response);
            const body: unknown = await response.json().catch(() => null);
            const streams = record(body) && Array.isArray(body.streams) ? body.streams.map(streamOf) : null;
            if (!streams || streams.includes(null))
                throw new BoardHttpError(response.status, `job ${job.id}: the transcript listing is unreadable`);
            return streams as TranscriptStream[];
        },

        transcriptChunk: (job, ref, offset) =>
            readChunk(job, '/transcripts/chunk', { ...ref, offset }, 'a transcript chunk'),
    };
}
