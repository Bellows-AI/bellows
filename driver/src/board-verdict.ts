/**
 * The verdict's two board calls (issue #821): the staged conclusion and the complete, which send
 * one body — the board fingerprints both alike, so a staged envelope and the verdict it stands for
 * are the same request. Split out of `board.ts` for its line budget; `createBoard` is the only importer.
 */

import type { Board, BoardJob } from './board.js';
import { CONCLUSION_CONFLICT_CODE } from './http.js';
import { fitCompleteBody } from './verdict-budget.js';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

/** The board's POST, as `createBoard` builds it: a 409 answered, a 404 too when `allow404`. */
type Post = (path: string, body: unknown, allow404?: boolean) => Promise<Response>;

/**
 * The verdict's POST body: every measured field rides, and absent stays absent — the never-zero
 * contract is the driver's to keep on the wire too. Extracted from `complete` so the client
 * method stays a round trip, not a payload builder.
 */
function completeBody({
    status,
    exitCode,
    output,
    contextTokens,
    contextCostUsd,
    agentTurns,
    setupMs,
    summary,
    failureKind,
    failureCause,
    treeChanged,
    evidence,
    publication,
}: Parameters<Board['complete']>[1]): Record<string, unknown> {
    return {
        status,
        exitCode,
        output,
        ...(typeof contextTokens === 'number' ? { contextTokens } : {}),
        ...(typeof contextCostUsd === 'number' ? { contextCostUsd } : {}),
        // A number only: null and absent both stay off the wire, and the board stores
        // unmeasured — the never-zero contract is the driver's to keep too.
        ...(typeof agentTurns === 'number' ? { agentTurns } : {}),
        ...(typeof setupMs === 'number' ? { setupMs } : {}),
        ...(summary ? { summary } : {}),
        // The structured failure reason, when there is one (issue #339); absent stays null.
        ...(failureKind ? { failureKind } : {}),
        ...(failureCause ? { failureCause } : {}),
        // Measured only after a failed gate; unknown stays off the wire.
        ...(typeof treeChanged === 'boolean' ? { treeChanged } : {}),
        // What the gates and the review assessed, for the board's completion check.
        ...(evidence ? { evidence } : {}),
        // The identity of what was published, when anything was — the board keys review
        // traffic and the thread's wait on it.
        ...(publication ? { publication } : {}),
    };
}

/** The verdict POST carries the lease token beside the payload, like every worker write, fit to the route's limit. */
const completeWireBody = (job: BoardJob, result: Parameters<Board['complete']>[1]): Record<string, unknown> =>
    fitCompleteBody({ leaseToken: job.leaseToken, ...completeBody(result) });

/** The `code` a 409 body names, read defensively: undefined for a body that names none. */
const conflictCodeOf = async (response: Response): Promise<unknown> =>
    ((await response.json().catch(() => ({}))) as { code?: unknown }).code;

export function verdictCalls(post: Post, leaseSeconds: number): Pick<Board, 'stageConclusion' | 'complete'> {
    return {
        async stageConclusion(job, result) {
            const response = await post(
                `/api/jobs/${job.id}/conclusion`,
                { ...completeWireBody(job, result), leaseSeconds },
                true
            );
            if (response.status === HTTP_NOT_FOUND) return 'removed';
            if (response.status !== HTTP_CONFLICT) return 'held';
            return (await conflictCodeOf(response)) === CONCLUSION_CONFLICT_CODE ? 'conflict' : 'lost';
        },

        async complete(job, result) {
            const response = await post(`/api/jobs/${job.id}/complete`, completeWireBody(job, result));
            // 409 is a verdict, not a failure: the lease is gone and with it any say over the
            // thread — no reclaim was ordered, not an unknown one. The attempt's own staged
            // conclusion refusing a different verdict (issue #821) is the same answer, flagged.
            if (response.status === HTTP_CONFLICT) {
                return (await conflictCodeOf(response)) === CONCLUSION_CONFLICT_CODE
                    ? { state: 'lost', reclaimId: null, conflict: true }
                    : { state: 'lost', reclaimId: null };
            }
            // Read defensively, like every other board field: anything but a non-empty string —
            // absent, null, a body that is not the shape we asked for — means "the user may
            // still want this thread's tree", which is the only safe reading of an unclear answer.
            const body = (await response.json()) as { reclaimId?: unknown };
            const reclaimId = typeof body.reclaimId === 'string' && body.reclaimId !== '' ? body.reclaimId : null;
            return { state: 'held', reclaimId };
        },
    };
}
