import { createHash } from 'node:crypto';
import { BoardHttpError } from './board-retry.js';
import type { Board, BoardJob } from './board.js';

/**
 * The worker read of one task input (`POST /api/jobs/:id/attachments/:attachmentId/content`), under the
 * live lease. Copied from `server/src/db/jobs/job-store-types.ts` rather than imported: this package
 * depends on nothing.
 */

/** One file of a claim's input set, as the claim lists it: root files first, then each follow-up's. */
export interface ClaimAttachment {
    id: string;
    name: string;
    mediaType: string;
    size: number;
    sha256: string;
    originJobId: string;
}

/** The board no longer holds the file's bytes (410): never deliverable. */
export class AttachmentGone extends Error {}
/** The board's stored bytes fail their recorded sha256 (422 ARTIFACT_CORRUPT): never deliverable. */
export class AttachmentCorrupt extends Error {}

type Post = (
    path: string,
    body: unknown,
    allow404?: boolean,
    options?: { allow?: readonly number[] }
) => Promise<Response>;

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;
const HTTP_UNPROCESSABLE = 422;
const ARTIFACT_CORRUPT_CODE = 'ARTIFACT_CORRUPT';
const SHA256 = /^[0-9a-f]{64}$/;

/** The read: one file's bytes under a row's lease, sha256 verified; null when the file is not in that row's set. */
export type AttachmentContent = (
    job: Pick<BoardJob, 'id' | 'leaseToken'>,
    attachmentId: string
) => Promise<{ bytes: Uint8Array; sha256: string } | null>;

/** A 422 from the board: its own corrupt code (core ERROR_CODES, copied) is `AttachmentCorrupt`; any other 422 is an ordinary error. */
async function unprocessable(response: Response, what: string): Promise<Error> {
    const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
    if (body?.code === ARTIFACT_CORRUPT_CODE) return new AttachmentCorrupt(`${what} is corrupt on the board`);
    return new BoardHttpError(response.status, `${what}: the board refused the read (422)`);
}

export function attachmentCalls(post: Post): Pick<Board, 'attachmentContent'> {
    return {
        async attachmentContent(job: Pick<BoardJob, 'id' | 'leaseToken'>, attachmentId: string) {
            const what = `job ${job.id}: attachment ${attachmentId}`;
            const response = await post(
                `/api/jobs/${job.id}/attachments/${attachmentId}/content`,
                { leaseToken: job.leaseToken },
                true,
                { allow: [HTTP_GONE, HTTP_UNPROCESSABLE] }
            );
            if (response.status === HTTP_NOT_FOUND) return null;
            if (response.status === HTTP_GONE) throw new AttachmentGone(`${what} is gone from the board`);
            if (response.status === HTTP_UNPROCESSABLE) throw await unprocessable(response, what);
            if (response.status === HTTP_CONFLICT) {
                throw new BoardHttpError(response.status, `${what}: the board refused the read (409)`);
            }
            const sha256 = response.headers.get('x-content-sha256') ?? '';
            if (!SHA256.test(sha256)) throw new BoardHttpError(response.status, `${what} came without its sha256`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
                throw new BoardHttpError(response.status, `${what} does not match its sha256`);
            }
            return { bytes, sha256 };
        },
    };
}
