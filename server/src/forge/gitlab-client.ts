import { READ_TRANSPORT, type RepoRef } from '@factory-ai/core';
import { GitHubReadError } from '../github/pr-read.js';
import {
    GitHubWriteError,
    type OpenedPullRequest,
    type PrCreate,
    type PrEdit,
    type PullRequestFacts,
} from '../github/pr-write.js';
import type { GitlabApi } from '../gitlab/gitlab-api.js';
import type { ActingCredential, ForgeClient } from './forge-client.js';
import { gitlabRequest, isSuccess, NO_TOKEN as NO_TOKEN_REASON } from './gitlab-call.js';
import { asRead, readMergeRequestPart } from './gitlab-change-request-read.js';
import { createGitLabMerge } from './gitlab-merge.js';
import { createGitLabReads } from './gitlab-reads.js';

/**
 * The GitLab adapter (docs/gitlab.md): the change-request writes of `ForgeClient` over REST v4, as the acting member's
 * token. The project is named by its URL-encoded full path. A draft is the `Draft: ` title prefix (v4 has no create
 * field for it). Failures reuse `GitHubWriteError`, the publish route's contract: `denied` (403/404), `refused`
 * (400/422), and `uncertain` for everything that is no answer to trust (401, 409, 5xx, transport, a body of the wrong
 * shape). The reads of a change request, a branch and a branch state are `gitlab-reads.ts`'s; the reads the board does not make on
 * GitLab yet reject, and none answers null or empty.
 */

const NO_TOKEN = 'no acting token was given for this write';
const DRAFT_PREFIX = 'Draft: ';
/** GitLab's own limit on a merge request title. */
const TITLE_LIMIT = 255;
const ERROR_DETAIL_LIMIT = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;
const OPENED = 'opened';
const ALREADY_EXISTS = /already exists/i;
/** GitLab's own reading of a title as a draft. */
const DRAFT_TITLE = /^\s*(?:\[draft\]|\(draft\)|draft:)/i;

/** What a caller relies on of one merge request; `draft` is GitLab's own flag. */
interface MergeRequest extends PullRequestFacts {
    draft: boolean;
}

/** Every entry a listing is trusted on also names its source branch and both projects (the fork guard). */
interface Listed extends MergeRequest {
    source: string;
    sourceProject: unknown;
    targetProject: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function factsOf(payload: unknown): MergeRequest | null {
    if (!isObject(payload)) return null;
    const { iid, web_url: url, target_branch: base, state, draft } = payload;
    if (!Number.isInteger(iid) || typeof url !== 'string' || typeof base !== 'string') return null;
    const gitlabState = typeof state === 'string' ? state : OPENED;
    return {
        url,
        number: iid as number,
        base,
        state: gitlabState === OPENED ? 'open' : gitlabState,
        draft: draft === true,
    };
}

function listedOf(payload: unknown): Listed | null {
    const facts = factsOf(payload);
    if (!facts || !isObject(payload)) return null;
    const { source_branch: source, source_project_id: sourceProject, target_project_id: targetProject } = payload;
    if (typeof source !== 'string' || !Number.isInteger(sourceProject) || !Number.isInteger(targetProject)) return null;
    return { ...facts, source, sourceProject, targetProject };
}

const publicFacts = ({ url, number, base, state }: MergeRequest): PullRequestFacts => ({ url, number, base, state });

/** The title as sent: the draft prefix when it is a draft, clipped so prefix and title fit GitLab's limit. */
function titled(title: string, draft: boolean): string {
    const marked = draft && !DRAFT_TITLE.test(title) ? DRAFT_PREFIX : '';
    return `${marked}${title.slice(0, TITLE_LIMIT - marked.length)}`;
}

function failureOf(what: string, status: number, text: string): GitHubWriteError {
    const detail = text.slice(0, ERROR_DETAIL_LIMIT);
    const message = `${what} failed with ${status}${detail ? `: ${detail}` : ''}`;
    if (status === HTTP_FORBIDDEN || status === HTTP_NOT_FOUND) return new GitHubWriteError(message, 'denied', status);
    if (status === HTTP_BAD_REQUEST || status === HTTP_UNPROCESSABLE) {
        return new GitHubWriteError(message, 'refused', status);
    }
    // A 401 is the token refused until it expires, and a 409 may be the create that already happened: no verdict.
    return new GitHubWriteError(message, 'uncertain', status);
}

const unconfirmed = (what: string) => `${what} of GitLab repositories cannot be read yet`;

const unread = (what: string) => async (): Promise<never> => {
    throw new GitHubReadError(unconfirmed(what), READ_TRANSPORT);
};

export function createGitLabForgeClient(
    deps: { api: GitlabApi; caBundle: string | undefined; signal?: AbortSignal | undefined },
    ref: RepoRef,
    credential: ActingCredential
): ForgeClient {
    const project = `/api/v4/projects/${encodeURIComponent(ref.path)}`;
    const mrs = `${project}/merge_requests`;

    const send = gitlabRequest(deps, ref, credential.kind === 'token' ? credential.token : null);
    /** One call: the parsed JSON of a 2xx, or the classified failure. The token is in no error text. */
    const call = async (
        method: 'GET' | 'POST' | 'PUT',
        path: string,
        signal: AbortSignal,
        body?: object
    ): Promise<unknown> => {
        const what = `${method} ${path.split('?')[0]}`;
        const answer = await send(method, path, signal, body);
        if (!answer.ok) {
            if (answer.reason === NO_TOKEN_REASON) throw new GitHubWriteError(NO_TOKEN, 'denied');
            throw new GitHubWriteError(`${what}: no answer (${answer.reason})`, 'uncertain');
        }
        if (!isSuccess(answer.status)) throw failureOf(what, answer.status, answer.text);
        return answer.json;
    };

    const owned = (payload: unknown, what: string): MergeRequest => {
        const facts = factsOf(payload);
        if (!facts) throw new GitHubWriteError(`${what}: the answer named no merge request`, 'uncertain');
        return facts;
    };

    /** The open merge requests of this project on `branch`: a fork's never counts. Every entry must be a clean one. */
    const openOn = async (branch: string, signal: AbortSignal): Promise<MergeRequest[]> => {
        const what = `GET ${mrs}`;
        const query = new URLSearchParams({ source_branch: branch, state: OPENED, per_page: '100' });
        const listed = await call('GET', `${mrs}?${query}`, signal);
        if (!Array.isArray(listed)) throw new GitHubWriteError(`${what}: the answer was not a list`, 'uncertain');
        const entries = listed.map(listedOf);
        if (entries.some((entry) => entry === null)) {
            throw new GitHubWriteError(`${what}: an entry named no merge request`, 'uncertain');
        }
        return (entries as Listed[]).filter(
            (entry) => entry.source === branch && entry.sourceProject === entry.targetProject
        );
    };

    const find = async (branch: string, signal: AbortSignal): Promise<MergeRequest | null> => {
        const open = await openOn(branch, signal);
        if (open.length > 1) {
            throw new GitHubWriteError(`GET ${mrs}: ${open.length} merge requests are open on the branch`, 'uncertain');
        }
        return open[0] ?? null;
    };

    /** The one open MR a create would collide with: the asked base's, else the only one; several and none fits is no answer. */
    const existingOn = async (branch: string, base: string, signal: AbortSignal): Promise<MergeRequest | null> => {
        const open = await openOn(branch, signal);
        const onBase = open.filter((entry) => entry.base === base);
        if (onBase.length === 1) return onBase[0] ?? null;
        if (open.length === 1) return open[0] ?? null;
        if (open.length === 0) return null;
        throw new GitHubWriteError(`GET ${mrs}: ${open.length} merge requests are open on the branch`, 'uncertain');
    };

    const put = async (number: number, fields: object, signal: AbortSignal) =>
        publicFacts(owned(await call('PUT', `${mrs}/${number}`, signal, fields), `PUT ${mrs}`));

    const open = async (
        { branch, base, create }: { branch: string; base: string; create: PrCreate },
        signal: AbortSignal
    ): Promise<OpenedPullRequest> => {
        const existing = await existingOn(branch, base, signal);
        if (existing) return { pr: publicFacts(existing), operation: 'reused' };
        try {
            const made = await call('POST', mrs, signal, {
                source_branch: branch,
                target_branch: base,
                title: titled(create.title, create.draft),
                description: create.body,
            });
            return { pr: publicFacts(owned(made, `POST ${mrs}`)), operation: 'created' };
        } catch (e) {
            // A create that failed or answered badly may still have happened: the branch decides, not the answer.
            if (!(e instanceof GitHubWriteError) || e.kind === 'denied') throw e;
            const reconciled = await existingOn(branch, base, signal).catch(() => null);
            if (reconciled) return { pr: publicFacts(reconciled), operation: 'reused' };
            if (e.kind === 'refused' && ALREADY_EXISTS.test(e.message))
                throw new GitHubWriteError(e.message, 'uncertain');
            throw e;
        }
    };

    const edit = async (number: number, change: PrEdit, signal: AbortSignal): Promise<PullRequestFacts> => {
        const fields: Record<string, string> = {};
        if (change.title !== undefined) {
            // GitLab un-drafts a merge request whose new title carries no marker: read it first, and never assume "not draft".
            const current = owned(await call('GET', `${mrs}/${number}`, signal), `GET ${mrs}`);
            fields.title = titled(change.title, current.draft);
        }
        if (change.body !== undefined) fields.description = change.body;
        if (change.base !== undefined) fields.target_branch = change.base;
        return put(number, fields, signal);
    };

    const reads = createGitLabReads(send, ref, () => deps.signal);

    return {
        forge: ref.forge,
        listRepositories: unread('the repository listing'),
        listBranches: unread('branches'),
        readBranchHead: reads.readBranchHead,
        readBranchState: reads.readBranchState,
        readFile: unread('files'),
        listSkills: unread('skills'),
        readChangeRequest: reads.readChangeRequest,
        readChangeRequestPart: (number, part, signal) =>
            readMergeRequestPart(asRead(call), { project, number }, part, signal),
        mergeChangeRequest: createGitLabMerge(send, ref, () => deps.signal),
        async findChangeRequest(branch, signal) {
            const found = await find(branch, signal);
            return found && publicFacts(found);
        },
        openChangeRequest: open,
        retargetChangeRequest: (number, base, signal) => put(number, { target_branch: base }, signal),
        editChangeRequest: edit,
    };
}
