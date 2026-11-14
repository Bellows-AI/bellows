import type { ArtifactManifest, Board, BoardJob, ChunkAnswer } from './board/board.js';
import { BoardHttpError } from './board/board-retry.js';
import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE, OCTET_STREAM_CONTENT_TYPE } from './http.js';

/**
 * The two artifact calls (`PUT /api/jobs/:id/artifact/chunk` and `/manifest`). Neither carries the
 * lease token: the board authorizes them by the claim sequence the job was claimed under, which is
 * what lets a superseded attempt finish its uploads. A 5xx, a dropped connection or a refused driver
 * credential (401, 403: no answer about the upload, see `board-retry.ts`) throws — the caller retries it,
 * the relay answers the exporter 502 — while every answer the board gives on purpose is returned.
 */

type Fetch = typeof globalThis.fetch;

const HTTP_OK = 200;
const HTTP_CONFLICT = 409;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const ERROR_BODY_PREVIEW_LENGTH = 200;

/** Copied from core/src/error-codes.ts, for the same reason as ./http.ts. */
const ARTIFACT_CONFLICT_CODE = 'ARTIFACT_CONFLICT';

/** A chunk 409, with the recorded chunk's length and digest when the board named them. */
function conflictOf(body: Record<string, unknown>): ChunkAnswer {
    const { recorded } = body as { recorded?: { length?: unknown; sha256?: unknown } };
    return typeof recorded?.length === 'number' && typeof recorded.sha256 === 'string'
        ? { result: 'conflict', recorded: { length: recorded.length, sha256: recorded.sha256 } }
        : { result: 'conflict' };
}

export function artifactCalls({
    url,
    credential,
    fetch,
}: {
    url: string;
    /** Read per call, like every board call's (`board-credential.ts`). */
    credential: () => string;
    fetch: Fetch;
}): Pick<Board, 'putArtifactChunk' | 'finalizeArtifact'> {
    const authorization = () => {
        const token = credential();
        return token ? { authorization: `Bearer ${token}` } : {};
    };
    const target = (job: BoardJob, kind: 'chunk' | 'manifest', query = '') =>
        `${url}/api/jobs/${job.id}/artifact/${kind}${query}`;

    /** The board's answer, or a throw when it was a transient failure worth another try. */
    const answered = async (response: Response): Promise<{ status: number; body: Record<string, unknown> }> => {
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const refusedCredential = response.status === HTTP_UNAUTHORIZED || response.status === HTTP_FORBIDDEN;
        if (response.status >= HTTP_SERVER_ERROR_MIN || refusedCredential) {
            throw new BoardHttpError(
                response.status,
                `the board answered ${response.status}: ${JSON.stringify(body).slice(0, ERROR_BODY_PREVIEW_LENGTH)}`
            );
        }
        return { status: response.status, body };
    };

    return {
        async putArtifactChunk(job, ref, offset, bytes): Promise<ChunkAnswer> {
            const query = `?${new URLSearchParams({
                claimSeq: String(job.claimSeq),
                executor: ref.executor,
                session: ref.session,
                stream: ref.stream,
                offset: String(offset),
            })}`;
            const { status, body } = await answered(
                await fetch(target(job, 'chunk', query), {
                    method: 'PUT',
                    headers: { [CONTENT_TYPE_HEADER]: OCTET_STREAM_CONTENT_TYPE, ...authorization() },
                    body: bytes,
                })
            );
            if (status === HTTP_OK) return { result: body.result === 'duplicate' ? 'duplicate' : 'stored' };
            if (status === HTTP_PAYLOAD_TOO_LARGE) {
                return { result: 'refused', cause: typeof body.cause === 'string' ? body.cause : 'refused' };
            }
            if (status === HTTP_CONFLICT && body.code === ARTIFACT_CONFLICT_CODE) return conflictOf(body);
            // Any other 4xx (a claim the board does not know, a removed job) will not change on retry.
            // A refused credential never gets here: it threw above, inconclusive.
            return { result: 'rejected' };
        },

        async finalizeArtifact(job, ref, manifest: ArtifactManifest) {
            const { status, body } = await answered(
                await fetch(target(job, 'manifest'), {
                    method: 'PUT',
                    headers: { [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE, ...authorization() },
                    body: JSON.stringify({ claimSeq: job.claimSeq, ...ref, ...manifest }),
                })
            );
            if (status === HTTP_OK) return body.result === 'duplicate' ? 'duplicate' : 'stored';
            if (status === HTTP_CONFLICT && body.code === ARTIFACT_CONFLICT_CODE) return 'conflict';
            return 'rejected';
        },
    };
}
