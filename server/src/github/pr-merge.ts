import {
    MERGE_ERR_FORBIDDEN,
    MERGE_ERR_RATE_LIMITED,
    MERGE_ERR_REFUSED,
    MERGE_ERR_UNCERTAIN,
    READ_RATE_LIMITED,
    type MergeErrorKind,
} from '@factory-ai/core';
import { GitHubAppError } from './app-token.js';
import { classifyReadFailure } from './pr-read.js';

/**
 * The installation-authenticated merge of a task's PR (docs/batches.md): one PUT, bound to the head
 * the board decided on (`sha`), so GitHub itself refuses if the head moved. Branch protection,
 * required checks, reviews and merge queues are GitHub's to enforce; their refusal is `refused`,
 * never retried around. A failure names how the provider answered, because "did it merge?" is
 * different for a 405 (no) and a timeout (unknown).
 */

export class GitHubMergeError extends GitHubAppError {
    constructor(
        message: string,
        readonly kind: MergeErrorKind,
        readonly retryAfterMs: number | null = null
    ) {
        super(message);
    }
}

export interface MergeResult {
    /** The commit the merge produced on the target; null when the provider did not say. */
    mergeCommitSha: string | null;
}

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;

/**
 * A non-2xx answer to the merge request. 405 (not mergeable: requirements, protection, a merge
 * queue), 409 (the head moved) and 422 are the provider declining; 401/403/404 mean the
 * installation cannot write here; a rate limit means the request was not accepted; anything else
 * (5xx) leaves it unknown whether the merge happened.
 */
export function classifyMergeFailure(
    path: string,
    response: { status: number; headers: Headers; detail: string },
    nowMs: number
): GitHubMergeError {
    const { status, detail } = response;
    const message = `PUT ${path} failed with ${status}${detail ? `: ${detail}` : ''}`;
    const read = classifyReadFailure(path, response, nowMs);
    if (read.kind === READ_RATE_LIMITED) {
        return new GitHubMergeError(message, MERGE_ERR_RATE_LIMITED, read.retryAfterMs);
    }
    if (status === HTTP_METHOD_NOT_ALLOWED || status === HTTP_CONFLICT || status === HTTP_UNPROCESSABLE) {
        return new GitHubMergeError(message, MERGE_ERR_REFUSED);
    }
    if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN || status === HTTP_NOT_FOUND) {
        return new GitHubMergeError(message, MERGE_ERR_FORBIDDEN);
    }
    return new GitHubMergeError(message, MERGE_ERR_UNCERTAIN);
}

/** A 2xx answer: merged unless the body says otherwise; an unreadable body still means the provider merged. */
export function readMergeResponse(body: { merged?: boolean; sha?: string; message?: string } | null): MergeResult {
    if (body?.merged === false) {
        throw new GitHubMergeError(
            `the provider did not merge: ${body.message ?? 'no reason given'}`,
            MERGE_ERR_REFUSED
        );
    }
    return { mergeCommitSha: body?.sha ?? null };
}
