import type { Board } from './board.js';

/**
 * One row of the board's removed-thread queue (issue #41): a Remove deleted the thread and left
 * the tree for somebody to take down. The lease claims the row so the reclaim is mutually
 * exclusive with a live attempt's startup sync; the row is deleted when the work is acked.
 */
export interface Reclaim {
    /** The queue row's own id — the work order's name. */
    id: string;
    /** This acquisition's own token (issue #821): the ack, the renew and the checkout claim ride it. */
    token: string;
    /** The thread whose tree the removed job left behind. */
    rootJobId: string;
    /** The checkout the thread's worktree belonged to, when the removed job named one. */
    repo: string | null;
    workspacePath: string | null;
    leaseExpiresAt: string;
}

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
): Pick<Board, 'claimReclaim' | 'ackReclaim' | 'renewReclaim'> {
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
    };
}
