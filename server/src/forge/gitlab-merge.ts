import {
    MERGE_ERR_FORBIDDEN,
    MERGE_ERR_NOT_SENT,
    MERGE_ERR_RATE_LIMITED,
    MERGE_ERR_REFUSED,
    MERGE_ERR_UNCERTAIN,
    MERGE_METHOD,
    type MergeErrorKind,
    type RepoRef,
} from '@factory-ai/core';
import { GitHubMergeError, type MergeResult } from '../github/pr-merge.js';
import { isSuccess, NO_TOKEN, type GitlabCall } from './gitlab-call.js';

/**
 * The merge of a GitLab merge request as the acting member (docs/gitlab.md): one PUT bound to the head the board decided
 * on (`sha`), after one read of the project's squash rule. The board merges by squash, so a project that forbids squash
 * merges is a named refusal with nothing sent. A refused member token (401) is no verdict, and a 2xx that is not a merged
 * merge request is never read as merged: both are `uncertain`, which the merger settles by reading the MR back.
 */

/** The whole merge, both requests, is bounded by one deadline; it stays under `MERGE_LEASE_MS`. */
export const MERGE_REQUEST_DEADLINE_MS = 60_000;

const ERROR_DETAIL_LIMIT = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_NOT_ACCEPTABLE = 406;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const HTTP_TOO_MANY_REQUESTS = 429;
const SQUASH_NEVER = 'never';
/** The values of a project's `squash_option` that allow the board's squash merge. */
const SQUASH_ALLOWED: ReadonlySet<string> = new Set(['always', 'default_on', 'default_off']);
const MERGED = 'merged';
/** The source branch outlives its merge, as GitHub's does. */
const KEEP_SOURCE_BRANCH = false;

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const sha = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const failure = (what: string, kind: MergeErrorKind, detail = '') =>
    new GitHubMergeError(`${what}${detail ? `: ${detail.slice(0, ERROR_DETAIL_LIMIT)}` : ''}`, kind);

/** A non-2xx answer to the PUT: the instance declining, the member lacking rights, a rate limit, or no verdict at all. */
function declined(what: string, status: number, text: string): GitHubMergeError {
    const message = `${what} failed with ${status}`;
    if (status === HTTP_TOO_MANY_REQUESTS) return failure(message, MERGE_ERR_RATE_LIMITED, text);
    if (
        status === HTTP_METHOD_NOT_ALLOWED ||
        status === HTTP_NOT_ACCEPTABLE ||
        status === HTTP_CONFLICT ||
        status === HTTP_UNPROCESSABLE
    ) {
        return failure(message, MERGE_ERR_REFUSED, text);
    }
    // A 401 is the member's token refused until the lineage notices: it says nothing about the merge.
    if (status === HTTP_FORBIDDEN || status === HTTP_NOT_FOUND) return failure(message, MERGE_ERR_FORBIDDEN, text);
    return failure(message, MERGE_ERR_UNCERTAIN, status === HTTP_UNAUTHORIZED ? '' : text);
}

/** The project's `squash_option`, or a `not_sent` when it cannot be confirmed: nothing was sent yet. */
async function squashOption(call: GitlabCall, project: string, signal: AbortSignal): Promise<string> {
    const what = `GET ${project}`;
    const answer = await call('GET', project, signal);
    if (!answer.ok) {
        if (answer.reason === NO_TOKEN) throw failure('no acting token was given for this merge', MERGE_ERR_FORBIDDEN);
        throw failure(`${what}: no answer (${answer.reason})`, MERGE_ERR_NOT_SENT);
    }
    const option = isObject(answer.json) ? answer.json.squash_option : undefined;
    if (
        !isSuccess(answer.status) ||
        typeof option !== 'string' ||
        !(option === SQUASH_NEVER || SQUASH_ALLOWED.has(option))
    ) {
        throw failure(`${what}: the squash rule was not confirmed (${answer.status})`, MERGE_ERR_NOT_SENT);
    }
    return option;
}

export function createGitLabMerge(call: GitlabCall, ref: RepoRef, deadline: () => AbortSignal | undefined) {
    const project = `/api/v4/projects/${encodeURIComponent(ref.path)}`;
    return async (number: number, request: { sha: string; method: string }): Promise<MergeResult> => {
        const signal = deadline() ?? AbortSignal.timeout(MERGE_REQUEST_DEADLINE_MS);
        const squash = request.method === MERGE_METHOD;
        if ((await squashOption(call, project, signal)) === SQUASH_NEVER && squash) {
            throw failure(
                `${ref.path} !${number}: the project forbids squash merges; the board merges by squash`,
                MERGE_ERR_REFUSED
            );
        }
        const path = `${project}/merge_requests/${number}/merge`;
        const what = `PUT ${path}`;
        const answer = await call('PUT', path, signal, {
            sha: request.sha,
            squash,
            should_remove_source_branch: KEEP_SOURCE_BRANCH,
        });
        // The request may have left: only a connection that never opened is known not to have merged.
        if (!answer.ok) {
            throw failure(
                `${what}: no answer (${answer.reason})`,
                answer.sent ? MERGE_ERR_UNCERTAIN : MERGE_ERR_NOT_SENT
            );
        }
        if (!isSuccess(answer.status)) throw declined(what, answer.status, answer.text);
        const body = answer.json;
        if (!isObject(body) || body.state !== MERGED || body.iid !== number) {
            throw failure(`${what}: the answer was not a merged merge request`, MERGE_ERR_UNCERTAIN);
        }
        return { mergeCommitSha: sha(body.merge_commit_sha) ?? sha(body.squash_commit_sha) };
    };
}
