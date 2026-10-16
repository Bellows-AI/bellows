import type { BoardJob } from './board.js';

type Fetch = typeof globalThis.fetch;

/** The attempt pair the runner-facing routes take, copied from the board's auth plugin (no shared types). */
const JOB_ID_HEADER = 'x-factory-job-id';
const LEASE_TOKEN_HEADER = 'x-factory-job-lease-token';

/**
 * `Board.githubCredential`: the attempt's GitHub token from `POST /api/jobs/:id/credentials/github`
 * (docs/connections.md), authenticated by the attempt pair and never the board secret. Any answer
 * but a token — no App (409), a refused attempt, a failed request — is null.
 */
export function githubCredentialCall({ url, fetch }: { url: string; fetch: Fetch }): {
    githubCredential(job: BoardJob): Promise<string | null>;
} {
    return {
        async githubCredential(job) {
            try {
                const response = await fetch(`${url}/api/jobs/${job.id}/credentials/github`, {
                    method: 'POST',
                    headers: { [JOB_ID_HEADER]: job.id, [LEASE_TOKEN_HEADER]: job.leaseToken },
                });
                if (!response.ok) return null;
                const body = (await response.json()) as { token?: unknown };
                return typeof body.token === 'string' && body.token ? body.token : null;
            } catch {
                return null;
            }
        },
    };
}
