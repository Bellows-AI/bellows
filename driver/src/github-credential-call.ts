import type { BoardJob } from './board/board.js';

type Fetch = typeof globalThis.fetch;

/** The attempt pair the runner-facing routes take, copied from the board's auth plugin (no shared types). */
const JOB_ID_HEADER = 'x-factory-job-id';
const LEASE_TOKEN_HEADER = 'x-factory-job-lease-token';
/** The ask runs inside a held sync turn and before a push: a board that never answers must not hold either. */
const ASK_TIMEOUT_MS = 15_000;

/** A failed request, a 5xx or a 429 is asked again this many times in all, this far apart: a push with no token loses its PR. */
const ASK_ATTEMPTS = 3;
const ASK_RETRY_MS = 250;
/** A deadline-bound ask backs off 250 ms, 500 ms, then 750 ms apart at most. */
const ASK_BACKOFF_CAP = 3;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;

/** What the board answered to one ask of the credential endpoint. */
export type GithubGrant =
    /** A token, with the ISO instant it stops working when the board said (null: unknown). */
    | { kind: 'token'; token: string; expiresAt: string | null }
    /** A confirmed no: no App installation (409), a refused attempt (403), any other 4xx but 429. */
    | { kind: 'refused' }
    /** No confirmed answer: a failed request, a timeout, a 5xx, a 429 or a malformed body. Never a verdict. */
    | { kind: 'unanswered' };

/** One ask: the board's answer, or `retry` for a board that did not answer it. */
async function askOnce(url: string, fetch: Fetch, job: BoardJob, signal?: AbortSignal): Promise<GithubGrant | 'retry'> {
    const timeout = AbortSignal.timeout(ASK_TIMEOUT_MS);
    let response: Response;
    try {
        response = await fetch(`${url}/api/jobs/${job.id}/credentials/github`, {
            method: 'POST',
            headers: { [JOB_ID_HEADER]: job.id, [LEASE_TOKEN_HEADER]: job.leaseToken },
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
    } catch {
        return 'retry';
    }
    if (response.status === HTTP_TOO_MANY || response.status >= HTTP_SERVER_ERROR) return 'retry';
    if (!response.ok) return { kind: 'refused' };
    try {
        const body = (await response.json()) as { token?: unknown; expiresAt?: unknown };
        if (typeof body.token !== 'string' || !body.token) return 'retry';
        return {
            kind: 'token',
            token: body.token,
            expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
        };
    } catch {
        return 'retry';
    }
}

/** Waits `ms`, or less when `signal` aborts first. */
const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });

/**
 * `Board.githubGrant` / `Board.githubCredential`: the attempt's GitHub token from
 * `POST /api/jobs/:id/credentials/github` (docs/connections.md), authenticated by the attempt pair and
 * never the board secret. A board that did not answer is asked again — `githubGrant` until its signal
 * aborts (an absolute deadline), `githubCredential` a bounded number of times — and then the answer is
 * `unanswered`, which is no verdict: only a confirmed 4xx is `refused`.
 */
export function githubCredentialCall({ url, fetch }: { url: string; fetch: Fetch }): {
    githubGrant(job: BoardJob, signal: AbortSignal): Promise<GithubGrant>;
    githubCredential(job: BoardJob): Promise<string | null>;
} {
    const grant = async (job: BoardJob, signal?: AbortSignal, attempts = Number.POSITIVE_INFINITY) => {
        for (let attempt = 1; attempt <= attempts && !signal?.aborted; attempt++) {
            const answer = await askOnce(url, fetch, job, signal);
            if (answer !== 'retry') return answer;
            if (attempt < attempts) await pause(ASK_RETRY_MS * Math.min(attempt, ASK_BACKOFF_CAP), signal);
        }
        return { kind: 'unanswered' } as const;
    };
    return {
        githubGrant: (job, signal) => grant(job, signal),
        async githubCredential(job) {
            const answer = await grant(job, undefined, ASK_ATTEMPTS);
            return answer.kind === 'token' ? answer.token : null;
        },
    };
}
