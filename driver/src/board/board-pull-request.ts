import { pause } from '../github-credential-call.js';
import { FORGE_GRANT_REQUIRED_CODE, GITHUB_UNAVAILABLE_CODE, LEASE_LOST_CODE, NOT_FOUND_CODE } from '../http.js';
import type { BoardJob } from './board.js';
import { boardCodeOf } from './board-retry.js';

/**
 * The board's pull-request write (`POST /api/jobs/:id/pull-request`): the board views, opens, retargets and edits the
 * task's PR as the member who started it, and the driver only asks. Split out of `board.ts` for its line budget;
 * `createBoard` is the only importer. Types are copied from the board's, never imported: this process depends on
 * nothing. No token is in an ask or an answer.
 */

/** What the driver wants of the task's PR (copied from the board's). */
export interface PullRequestAsk {
    /** The task branch: the PR is found by it. */
    branch: string;
    /** The branch an EXISTING PR is retargeted to; null leaves it where it is. */
    base: string | null;
    /** Opens the PR (a draft or not, against `create.base`) when the branch has none. */
    create?: { title: string; body: string; draft: boolean; base: string };
    /** Rewrites the title and body of the PR the branch already has. */
    edit?: { title?: string; body?: string };
}

/** What the board confirmed. Never a guess: a board that did not answer throws `PullRequestUnanswered`. */
export type PullRequestAnswer =
    | { kind: 'pr'; url: string; number: number; operation: 'created' | 'reused' }
    /** A view-only ask found no PR for the branch. */
    | { kind: 'none' }
    /** The starter's forge grant cannot serve: the board holds the thread, the attempt hands itself back. */
    | { kind: 'waiting'; forge: string; reason: string }
    /** The board holds no GitHub App for the org: the push landed and there is no PR to write. */
    | { kind: 'no-forge' }
    /** GitHub refused the member's token for this repository. */
    | { kind: 'denied' }
    /** GitHub declined the request, with its own words. */
    | { kind: 'refused'; detail: string }
    | { kind: 'lost' }
    | { kind: 'removed' };

/** No confirmed answer before the deadline: a transport failure, a 5xx, an unrecognised 409 or a body that is not an answer. */
export class PullRequestUnanswered extends Error {
    constructor(job: Pick<BoardJob, 'id'>) {
        super(`job ${job.id}: the board did not answer the pull request ask`);
        this.name = 'PullRequestUnanswered';
    }
}

type Post = (
    path: string,
    body: unknown,
    allow404?: boolean,
    options?: { signal?: AbortSignal | undefined; allow?: readonly number[] }
) => Promise<Response>;

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
/** One request's bound, a little over the board's own deadline for the whole call. */
const REQUEST_TIMEOUT_MS = 35_000;
const RETRY_MS = 250;
const RETRY_BACKOFF_CAP = 3;
const RETRY = Symbol('retry');

const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The answer a 200 body is, or null when it is not one. */
function answerOf(body: unknown): PullRequestAnswer | null {
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    switch (b.answer) {
        case 'pr':
            return isString(b.url) &&
                Number.isSafeInteger(b.number) &&
                (b.number as number) > 0 &&
                (b.operation === 'created' || b.operation === 'reused')
                ? { kind: 'pr', url: b.url, number: b.number as number, operation: b.operation }
                : null;
        case 'none':
            return { kind: 'none' };
        case 'waiting':
            return isString(b.forge) && isString(b.reason)
                ? { kind: 'waiting', forge: b.forge, reason: b.reason }
                : null;
        case 'denied':
            return { kind: 'denied' };
        case 'refused':
            return isString(b.detail) ? { kind: 'refused', detail: b.detail } : null;
        default:
            return null;
    }
}

/** The 409's meaning by the board's own code; null for a code this driver does not know (inconclusive). */
async function conflictOf(response: Response): Promise<PullRequestAnswer | null> {
    const code = await boardCodeOf(response);
    if (code === LEASE_LOST_CODE) return { kind: 'lost' };
    if (code === GITHUB_UNAVAILABLE_CODE) return { kind: 'no-forge' };
    if (code !== FORGE_GRANT_REQUIRED_CODE) return null;
    const body = (await response.json().catch(() => null)) as { forge?: unknown; standing?: unknown } | null;
    return isString(body?.forge)
        ? { kind: 'waiting', forge: body.forge, reason: body.standing === 'missing' ? 'missing' : 'reconnect' }
        : null;
}

async function once(
    post: Post,
    job: BoardJob,
    ask: PullRequestAsk,
    signal: AbortSignal
): Promise<PullRequestAnswer | typeof RETRY> {
    let response: Response;
    try {
        response = await post(`/api/jobs/${job.id}/pull-request`, { leaseToken: job.leaseToken, ...ask }, true, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
    } catch {
        // A transport failure, a 5xx, a refused credential or an uncoded 4xx: the board did not answer.
        return RETRY;
    }
    if (response.status === HTTP_NOT_FOUND)
        return (await boardCodeOf(response)) === NOT_FOUND_CODE ? { kind: 'removed' } : RETRY;
    if (response.status === HTTP_CONFLICT) return (await conflictOf(response)) ?? RETRY;
    return answerOf(await response.json().catch(() => null)) ?? RETRY;
}

/**
 * `Board.pullRequest`: asks until the board answers or `signal` aborts (one absolute deadline over every try and back-off),
 * then throws `PullRequestUnanswered`. Only an answer is a verdict: a 5xx, a timeout, a malformed body, an uncoded 4xx or
 * an unknown 409 code is asked again, never read as a PR, a missing PR or a lost lease.
 */
export function pullRequestCalls(post: Post): {
    pullRequest(job: BoardJob, ask: PullRequestAsk, signal: AbortSignal): Promise<PullRequestAnswer>;
} {
    return {
        async pullRequest(job, ask, signal) {
            for (let attempt = 1; !signal.aborted; attempt++) {
                const answer = await once(post, job, ask, signal);
                if (answer !== RETRY) return answer;
                await pause(RETRY_MS * Math.min(attempt, RETRY_BACKOFF_CAP), signal);
            }
            throw new PullRequestUnanswered(job);
        },
    };
}
