import type { Board, Reclaim } from './board.js';
// board.ts imports this file, so its UUID_SHAPE would make a cycle; publish.ts's is the same shape.
import { UUID as UUID_SHAPE } from './publish.js';

/** The board's POST as `createBoard` hands it out: a 409 is always an answer, a 404 when asked for. */
type Post = (
    path: string,
    body: unknown,
    allow404?: boolean,
    options?: { signal?: AbortSignal | undefined }
) => Promise<Response>;

const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

/** An ack's or a renew's answer: 409 means another acquisition holds the row, 404 that it is gone. */
function answerOf<T extends 'ok' | 'held'>(response: Response, ok: T): T | 'lost' | 'missing' {
    if (response.status === HTTP_CONFLICT) return 'lost';
    return response.status === HTTP_NOT_FOUND ? 'missing' : ok;
}

/**
 * The worktree-reclaim queue's calls (issue #41): claim a row for the driver's lease, then renew and
 * ack it under the acquisition's own token (issue #821), never the worker name.
 */
export function reclaimCalls(
    post: Post,
    leaseSeconds: number
): Pick<Board, 'claimReclaim' | 'ackReclaim' | 'renewReclaim' | 'reclaimHolds'> {
    return {
        async claimReclaim(worker) {
            const response = await post('/api/reclaims/claim', { worker, leaseSeconds });
            if (response.status === HTTP_NO_CONTENT) return null;
            return (await response.json()) as Reclaim;
        },

        async ackReclaim(id, token) {
            return answerOf(await post(`/api/reclaims/${id}/ack`, { token }, true), 'ok');
        },

        async renewReclaim(id, token, signal) {
            const response = await post(`/api/reclaims/${id}/renew`, { token, leaseSeconds }, true, { signal });
            return answerOf(response, 'held');
        },

        // The reaper's read (issue #829), fail-closed like the lease lookup: a refused, failed or
        // partly unreadable answer is null ("cannot answer"), never a list the reaper would act on.
        async reclaimHolds(tokens) {
            try {
                const response = await post('/api/reclaims/holds', { tokens: [...tokens] });
                if (!response.ok) return null;
                const { held } = (await response.json()) as { held?: unknown };
                const ok = Array.isArray(held) && held.every((t) => typeof t === 'string' && UUID_SHAPE.test(t));
                return ok ? new Set(held as string[]) : null;
            } catch {
                return null;
            }
        },
    };
}
