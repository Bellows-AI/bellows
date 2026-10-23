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
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;

/** One ask: the token, null for an answer that is no token, or `retry` for a board that did not answer it. */
async function askOnce(url: string, fetch: Fetch, job: BoardJob): Promise<string | null | 'retry'> {
    let response: Response;
    try {
        response = await fetch(`${url}/api/jobs/${job.id}/credentials/github`, {
            method: 'POST',
            headers: { [JOB_ID_HEADER]: job.id, [LEASE_TOKEN_HEADER]: job.leaseToken },
            signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
        });
    } catch {
        return 'retry';
    }
    if (response.status === HTTP_TOO_MANY || response.status >= HTTP_SERVER_ERROR) return 'retry';
    if (!response.ok) return null;
    try {
        const body = (await response.json()) as { token?: unknown };
        return typeof body.token === 'string' && body.token ? body.token : null;
    } catch {
        return null;
    }
}

/**
 * `Board.githubCredential`: the attempt's GitHub token from `POST /api/jobs/:id/credentials/github`
 * (docs/connections.md), authenticated by the attempt pair and never the board secret. Any answer
 * but a token — no App (409), a refused attempt — is null at once; a board that did not answer is
 * asked again, a bounded number of times, before it is null too.
 */
export function githubCredentialCall({ url, fetch }: { url: string; fetch: Fetch }): {
    githubCredential(job: BoardJob): Promise<string | null>;
} {
    return {
        async githubCredential(job) {
            for (let attempt = 1; attempt <= ASK_ATTEMPTS; attempt++) {
                const answer = await askOnce(url, fetch, job);
                if (answer !== 'retry') return answer;
                if (attempt < ASK_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, ASK_RETRY_MS * attempt));
            }
            return null;
        },
    };
}
