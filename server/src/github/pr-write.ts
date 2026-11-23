import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE, READ_RATE_LIMITED } from '@factory-ai/core';
import { GitHubAppError } from './app-token.js';
import { classifyReadFailure } from './pr-read.js';

/**
 * The board's write of a task's pull request (docs/connections.md): view by head, create, edit and retarget
 * under an explicit token, the acting member's. Each call runs under the caller's signal; a body read that
 * stalls or ends early settles on it. A failure names what the caller may conclude: `denied` (the token may
 * not write here), `refused` (GitHub declined the request) or `uncertain` (no answer to trust: a 5xx, a rate
 * limit, transport, abort, a body that is not the shape asked for). `uncertain` is never a verdict.
 */

export type PrWriteErrorKind = 'denied' | 'uncertain' | 'refused';

export class GitHubWriteError extends GitHubAppError {
    constructor(
        message: string,
        readonly kind: PrWriteErrorKind,
        /** GitHub's HTTP status when the failure is its answer; null for a failure with none (transport, abort, a bad body). */
        readonly status: number | null = null
    ) {
        super(message);
    }
}

/** The facts of one open pull request. */
export interface PullRequestFacts {
    url: string;
    number: number;
    base: string;
    state: string;
}

export interface PrAuth {
    token: string;
    signal: AbortSignal;
}

export interface PrCreate {
    title: string;
    body: string;
    draft: boolean;
}

export interface PrEdit {
    title?: string;
    body?: string;
    base?: string;
}

export interface OpenedPullRequest {
    pr: PullRequestFacts;
    /** `created` by this call; `reused` when the head already had an open PR. */
    operation: 'created' | 'reused';
}

export interface PrWriter {
    /** The open PR on `branch`, or null for a validated empty answer. */
    findPullRequest(repo: string, branch: string, auth: PrAuth): Promise<PullRequestFacts | null>;
    /** View by head, create when none, view again before any create failure stands. */
    openPullRequest(
        repo: string,
        ask: { branch: string; base: string; create: PrCreate },
        auth: PrAuth
    ): Promise<OpenedPullRequest>;
    retarget(repo: string, number: number, base: string, auth: PrAuth): Promise<PullRequestFacts>;
    edit(repo: string, number: number, edit: PrEdit, auth: PrAuth): Promise<PullRequestFacts>;
}

export interface PrWriterDeps {
    apiUrl: string;
    fetchFn?: typeof fetch;
}

/** How much of a failed response's body is worth quoting back in an error. */
const ERROR_DETAIL_LIMIT = 200;
/** One request's own bound, under the caller's deadline. */
const REQUEST_TIMEOUT_MS = 20_000;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;
const ALREADY_EXISTS = /already exists/i;

/** Rejects with `uncertain` when the signal aborts, so a body or a stub that ignores it still settles. */
function settleOn<T>(work: Promise<T>, signal: AbortSignal, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const aborted = () => reject(new GitHubWriteError(`${what}: no answer before the deadline`, 'uncertain'));
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
        if (signal.aborted) return aborted();
        signal.addEventListener('abort', aborted, { once: true });
    });
}

const uncertain = (what: string, cause: unknown) =>
    cause instanceof GitHubWriteError
        ? cause
        : new GitHubWriteError(`${what}: ${(cause as Error | undefined)?.message ?? 'no answer'}`, 'uncertain');

interface PullPayload {
    number?: unknown;
    html_url?: unknown;
    state?: unknown;
    base?: { ref?: unknown } | null;
}

/** The facts of a pull payload, or null when it lacks what a caller relies on. */
function factsOf(payload: unknown): PullRequestFacts | null {
    const pull = payload as PullPayload | null;
    if (typeof pull !== 'object' || pull === null) return null;
    const { number, html_url: url, state, base } = pull;
    if (!Number.isInteger(number) || typeof url !== 'string' || typeof base?.ref !== 'string') return null;
    return { url, number: number as number, base: base.ref, state: typeof state === 'string' ? state : 'open' };
}

export function createPrWriter({ apiUrl, fetchFn = fetch }: PrWriterDeps): PrWriter {
    /** One call: the parsed JSON of a 2xx, or the classified failure. The token is in no error text. */
    const call = async (method: string, path: string, { token, signal }: PrAuth, body?: object): Promise<unknown> => {
        const what = `${method} ${path}`;
        try {
            const bound = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
            const text = await settleOn(
                (async () => {
                    const response = await fetchFn(`${apiUrl}${path}`, {
                        method,
                        headers: {
                            authorization: `Bearer ${token}`,
                            accept: 'application/vnd.github+json',
                            // GitHub rejects an API request with no User-Agent outright.
                            'user-agent': 'factory-ai',
                            ...(body ? { [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE } : {}),
                        },
                        ...(body ? { body: JSON.stringify(body) } : {}),
                        signal: bound,
                    });
                    const content = await response.text();
                    if (!response.ok) throw failureOf(what, response, content);
                    return content;
                })(),
                bound,
                what
            );
            try {
                return JSON.parse(text);
            } catch {
                throw new GitHubWriteError(`${what}: the answer was not JSON`, 'uncertain');
            }
        } catch (e) {
            throw uncertain(what, e);
        }
    };

    const failureOf = (what: string, response: Response, content: string): GitHubWriteError => {
        const { status } = response;
        const detail = content.slice(0, ERROR_DETAIL_LIMIT);
        const message = `${what} failed with ${status}${detail ? `: ${detail}` : ''}`;
        const read = classifyReadFailure(what, { status, headers: response.headers, detail }, Date.now());
        if (read.kind === READ_RATE_LIMITED) return new GitHubWriteError(message, 'uncertain', status);
        if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN || status === HTTP_NOT_FOUND) {
            return new GitHubWriteError(message, 'denied', status);
        }
        if (status === HTTP_UNPROCESSABLE) return new GitHubWriteError(message, 'refused', status);
        return new GitHubWriteError(message, 'uncertain', status);
    };

    const owned = (payload: unknown, what: string): PullRequestFacts => {
        const facts = factsOf(payload);
        if (!facts) throw new GitHubWriteError(`${what}: the answer named no pull request`, 'uncertain');
        return facts;
    };

    const findPullRequest: PrWriter['findPullRequest'] = async (repo, branch, auth) => {
        const [owner] = repo.split('/');
        const head = encodeURIComponent(`${owner}:${branch}`);
        const what = `GET /repos/${repo}/pulls`;
        const listed = await call('GET', `/repos/${repo}/pulls?head=${head}&state=open`, auth);
        if (!Array.isArray(listed)) throw new GitHubWriteError(`${what}: the answer was not a list`, 'uncertain');
        if (listed.length === 0) return null;
        return owned(listed[0], what);
    };

    const patch = async (repo: string, number: number, fields: PrEdit, auth: PrAuth) =>
        owned(await call('PATCH', `/repos/${repo}/pulls/${number}`, auth, fields), `PATCH /repos/${repo}/pulls`);

    return {
        findPullRequest,

        async openPullRequest(repo, { branch, base, create }, auth) {
            const existing = await findPullRequest(repo, branch, auth);
            if (existing) return { pr: existing, operation: 'reused' };
            try {
                const made = await call('POST', `/repos/${repo}/pulls`, auth, { head: branch, base, ...create });
                return { pr: owned(made, `POST /repos/${repo}/pulls`), operation: 'created' };
            } catch (e) {
                // A create that failed or answered badly may still have happened: the head decides, not the answer.
                if (!(e instanceof GitHubWriteError) || e.kind === 'denied') throw e;
                const reconciled = await findPullRequest(repo, branch, auth).catch(() => null);
                if (reconciled) return { pr: reconciled, operation: 'reused' };
                if (e.kind === 'refused' && ALREADY_EXISTS.test(e.message)) {
                    throw new GitHubWriteError(e.message, 'uncertain');
                }
                throw e;
            }
        },

        retarget: (repo, number, base, auth) => patch(repo, number, { base }, auth),
        edit: (repo, number, edit, auth) => patch(repo, number, edit, auth),
    };
}
