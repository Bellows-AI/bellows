import type { Board, BoardJob } from './board.js';

/**
 * The runtime connection requirement's board call and claim field. Split out of `board.ts`
 * for its line budget; `createBoard` is the only importer. Types are copied from the board's, never
 * imported: this process depends on nothing.
 */

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_NOT_FOUND = 404;

/** The board's decision on a runtime ask (`POST /api/jobs/:id/requirements`). */
export type RequirementAnswer = 'bound' | 'unavailable' | 'waiting';
const ANSWERS: readonly unknown[] = ['bound', 'unavailable', 'waiting'];

/**
 * How the board took the ask: its answer, or `lost` (409, the lease is no longer this attempt's), `removed`
 * (404, the job is gone) or `refused` (400, a provider the board does not bind at runtime).
 */
export type RequirementVerdict = RequirementAnswer | 'lost' | 'removed' | 'refused';

/** What became of a requirement this task's earlier attempt raised: the connection was bound, or the user went on without it. */
export interface ConnectionOutcome {
    provider: string;
    label: string;
    outcome: 'bound' | 'dismissed';
}

const isOutcome = (value: unknown): value is ConnectionOutcome => {
    if (typeof value !== 'object' || value === null) return false;
    const { provider, label, outcome } = value as Record<string, unknown>;
    return (
        typeof provider === 'string' && typeof label === 'string' && (outcome === 'bound' || outcome === 'dismissed')
    );
};

/** The claim's `connectionOutcomes`, keeping the well-formed entries; none when the board sent none. */
export const connectionOutcomesOf = (wire: unknown): { connectionOutcomes?: ConnectionOutcome[] } => {
    const outcomes = Array.isArray(wire) ? wire.filter(isOutcome) : [];
    return outcomes.length > 0 ? { connectionOutcomes: outcomes } : {};
};

type Post = (
    path: string,
    body: unknown,
    allow404?: boolean,
    options?: { allow?: readonly number[] }
) => Promise<Response>;

export function connectionCalls(post: Post): Pick<Board, 'requireConnection'> {
    return {
        async requireConnection(job: BoardJob, provider: string, target?: string) {
            const body = { leaseToken: job.leaseToken, provider, ...(target === undefined ? {} : { target }) };
            const response = await post(`/api/jobs/${job.id}/requirements`, body, true, { allow: [HTTP_BAD_REQUEST] });
            if (response.status === HTTP_NOT_FOUND) return 'removed';
            if (response.status === HTTP_CONFLICT) return 'lost';
            if (response.status === HTTP_BAD_REQUEST) return 'refused';
            const { answer } = (await response.json()) as { answer?: unknown };
            // A body that is not one of the three is not an answer: the caller retries or gives up, never decides.
            if (!ANSWERS.includes(answer)) throw new Error('the board answered a connection ask with no answer');
            return answer as RequirementAnswer;
        },
    };
}
