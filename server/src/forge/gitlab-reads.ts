import {
    CHECKS_PENDING,
    gitlabCheckItem,
    gitlabCheckState,
    gitlabMergeable,
    READ_NOT_FOUND,
    READ_RATE_LIMITED,
    READ_TRANSPORT,
    type CheckItem,
    type GitlabCheck,
    type PrFacts,
    type ReadErrorKind,
    type RepoRef,
} from '@factory-ai/core';
import { GitHubReadError, type BranchState } from '../github/pr-read.js';
import { isSuccess, type GitlabCall } from './gitlab-call.js';

/**
 * What the board reads of a GitLab merge request, branch and branch state (docs/gitlab.md), as the acting member's token.
 * Facts are returned only for a fully validated answer: a malformed entry, a page past the cap, an MR that is not
 * `opened`/`closed`/`merged` and any answer that is not a confirmed one is a `GitHubReadError`, never an empty or a
 * "closed" read. A 404 of the object asked for is `not_found`; a 403 or 401 under a member's token is `transport` (the
 * member lost access, which says nothing about the MR), and a 404 of a nested read is `transport` too.
 */

/** The whole read, every page and request, is bounded by one deadline; it stays under `OBSERVATION_LEASE_MS`. */
export const FORGE_READ_DEADLINE_MS = 60_000;

const PAGE_SIZE = 100;
/** Pages read before a listing is called too long: past 500 entries on one commit something is looping. */
const MAX_PAGES = 5;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;
const HTTP_TOO_MANY_REQUESTS = 429;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const OPENED = 'opened';
const CLOSED = 'closed';
const MERGED = 'merged';
const PIPELINE_CHECK = 'pipeline';
const STALE_PIPELINE = 'the head pipeline ran on an older commit';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const textOrNull = (value: unknown): string | null => (text(value) && value !== '' ? value : null);

const fail = (what: string, kind: ReadErrorKind = READ_TRANSPORT) => new GitHubReadError(what, kind);
const unclean = (what: string) => fail(`${what}: not a clean answer`);

/** One request of a read. `found` and `denied` are the two answers a caller may treat as absence. */
type Sent =
    | { kind: 'ok'; json: unknown }
    | { kind: 'absent' }
    | { kind: 'denied' }
    | { kind: 'refused'; status: number };

/** What every read of one project needs: the request, and the project's path under the API. */
interface Ctx {
    call: GitlabCall;
    project: string;
}
const branchPath = (ctx: Ctx, branch: string) => `${ctx.project}/repository/branches/${encodeURIComponent(branch)}`;
const failed = (path: string, status: number) => fail(`GET ${path.split('?')[0]} failed with ${status}`);

async function send(ctx: Ctx, path: string, signal: AbortSignal): Promise<Sent> {
    const answer = await ctx.call('GET', path, signal);
    if (!answer.ok) throw fail(`GET ${path.split('?')[0]}: no answer (${answer.reason})`);
    const { status, json } = answer;
    if (isSuccess(status)) return { kind: 'ok', json };
    if (status === HTTP_NOT_FOUND) return { kind: 'absent' };
    if (status === HTTP_FORBIDDEN) return { kind: 'denied' };
    if (status === HTTP_TOO_MANY_REQUESTS)
        throw fail(`GET ${path.split('?')[0]} failed with ${status}`, READ_RATE_LIMITED);
    return { kind: 'refused', status };
}

/** The body of a 2xx. A 404 is `not_found` only when `primary` (the object asked for), else the read is unconfirmed. */
async function get(ctx: Ctx, path: string, signal: AbortSignal, primary = false): Promise<unknown> {
    const sent = await send(ctx, path, signal);
    if (sent.kind === 'ok') return sent.json;
    if (sent.kind === 'absent')
        throw fail(failed(path, HTTP_NOT_FOUND).message, primary ? READ_NOT_FOUND : READ_TRANSPORT);
    throw failed(path, sent.kind === 'denied' ? HTTP_FORBIDDEN : sent.status);
}

/** The body of a 2xx, or null for a 404 or 403: a read the assessment can do without. A 5xx or no answer still throws. */
async function optional(ctx: Ctx, path: string, signal: AbortSignal): Promise<unknown> {
    const sent = await send(ctx, path, signal);
    if (sent.kind === 'ok') return sent.json;
    if (sent.kind === 'refused') throw failed(path, sent.status);
    return null;
}

/** Every entry of a listing, page by page: a page that is not a clean list, an entry that does not parse or a listing past the cap rejects. */
async function listed<T>(
    ctx: Ctx,
    path: string,
    parse: (entry: unknown) => T | null,
    signal: AbortSignal
): Promise<T[]> {
    const out: T[] = [];
    const joiner = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const answer = await get(ctx, `${path}${joiner}per_page=${PAGE_SIZE}&page=${page}`, signal);
        if (!Array.isArray(answer)) throw unclean(path);
        const entries = answer.map(parse);
        if (entries.some((entry) => entry === null)) throw unclean(path);
        out.push(...(entries as T[]));
        if (answer.length < PAGE_SIZE) return out;
    }
    throw fail(`${path}: past the ${MAX_PAGES} page cap`);
}

interface Entry {
    id: number;
    item: CheckItem;
}

const entryOf = (entry: unknown, own: (entry: Json) => Omit<GitlabCheck, 'name' | 'status'>): Entry | null => {
    if (!isObject(entry) || !Number.isInteger(entry.id) || !text(entry.name) || !text(entry.status)) return null;
    const check = { name: entry.name, status: entry.status, ...own(entry) };
    return { id: entry.id as number, item: gitlabCheckItem(check) };
};
const jobOf = (entry: unknown) =>
    entryOf(entry, (job) => ({
        allowFailure: job.allow_failure === true,
        url: textOrNull(job.web_url),
        stage: textOrNull(job.stage),
        failureReason: textOrNull(job.failure_reason),
    }));
const statusOf = (entry: unknown) =>
    entryOf(entry, (status) => ({
        allowFailure: status.allow_failure === true,
        url: textOrNull(status.target_url),
        failureReason: textOrNull(status.description),
    }));

/** The pipeline's own status as one check (a bridge job is no entry of its jobs) and one item per job. */
async function pipelineChecks(
    ctx: Ctx,
    pipeline: { id: number; status: string; url: string | null },
    signal: AbortSignal
): Promise<CheckItem[]> {
    const jobs = await listed(ctx, `${ctx.project}/pipelines/${pipeline.id}/jobs`, jobOf, signal);
    const state = gitlabCheckState(pipeline.status, false);
    return [
        { name: PIPELINE_CHECK, state, url: pipeline.url, detail: pipeline.status },
        ...jobs.map((job) => job.item),
    ];
}

/** The commit's external statuses: of one name the newest, and a job's name is the job's. */
async function statusChecks(
    ctx: Ctx,
    sha: string,
    own: readonly CheckItem[],
    signal: AbortSignal
): Promise<CheckItem[]> {
    const statuses = await listed(ctx, `${ctx.project}/repository/commits/${sha}/statuses`, statusOf, signal);
    const newest = new Map<string, Entry>();
    for (const entry of statuses) {
        const seen = newest.get(entry.item.name);
        if (!seen || entry.id > seen.id) newest.set(entry.item.name, entry);
    }
    const jobNames = new Set(own.map((item) => item.name));
    return [...newest.values()].map((entry) => entry.item).filter((item) => !jobNames.has(item.name));
}

function headPipelineOf(mr: Json, base: string) {
    const head = mr.head_pipeline;
    if (head === null || head === undefined) return null;
    if (!isObject(head) || !Number.isInteger(head.id) || !text(head.status) || !text(head.sha)) throw unclean(base);
    return { id: head.id as number, status: head.status, sha: head.sha, url: textOrNull(head.web_url) };
}

async function checksOf(ctx: Ctx, mr: Json, base: string, signal: AbortSignal): Promise<CheckItem[]> {
    const sha = mr.sha as string;
    const head = headPipelineOf(mr, base);
    // GitLab can serve an older pipeline right after a push, before the new one exists: not a pass.
    if (head !== null && head.sha !== sha) {
        return [{ name: PIPELINE_CHECK, state: CHECKS_PENDING, url: head.url, detail: STALE_PIPELINE }];
    }
    const own = head === null ? [] : await pipelineChecks(ctx, head, signal);
    return [...own, ...(await statusChecks(ctx, sha, own, signal))];
}

function approvalsOf(body: unknown): { required: number | null; approvals: number | null } {
    const none = { required: null, approvals: null };
    if (!isObject(body)) return none;
    const { approvals_required: required, approvals_left: left } = body;
    if (typeof required !== 'number' || typeof left !== 'number') return none;
    if (!Number.isInteger(required) || !Number.isInteger(left)) return none;
    return { required, approvals: Math.max(required - left, 0) };
}

function mergeRequestOf(body: unknown, iid: number, base: string): Json {
    if (!isObject(body)) throw unclean(base);
    const { state, sha, target_branch: target, web_url: url } = body;
    const stateOk = state === OPENED || state === CLOSED || state === MERGED;
    const projectOk = Number.isInteger(body.project_id) && body.project_id === body.target_project_id;
    if (body.iid !== iid || !stateOk || !projectOk) throw unclean(base);
    if (!text(sha) || !SHA_PATTERN.test(sha) || !textOrNull(target) || !textOrNull(url)) throw unclean(base);
    return body;
}

/** The facts a merge request's own answer settles; a settled MR is judged by these alone. */
function settledFacts(ref: RepoRef, mr: Json, iid: number): PrFacts {
    const merged = mr.state === MERGED;
    return {
        repo: ref.path,
        number: iid,
        url: mr.web_url as string,
        state: mr.state === OPENED ? 'open' : 'closed',
        merged,
        mergedAt: merged ? textOrNull(mr.merged_at) : null,
        mergeCommitSha: merged ? (textOrNull(mr.merge_commit_sha) ?? textOrNull(mr.squash_commit_sha)) : null,
        updatedAt: textOrNull(mr.updated_at),
        baseBranch: mr.target_branch as string,
        headSha: mr.sha as string,
        targetSha: null,
        mergeable: null,
        requiredContexts: [],
        requiredApprovals: null,
        approvals: null,
        checks: [],
    };
}

async function readChangeRequest(ctx: Ctx, ref: RepoRef, iid: number, signal: AbortSignal): Promise<PrFacts> {
    const base = `${ctx.project}/merge_requests/${iid}`;
    const mr = mergeRequestOf(await get(ctx, base, signal, true), iid, base);
    const facts = settledFacts(ref, mr, iid);
    // A settled MR's pipeline may have expired, and none of the rest is consumed.
    if (mr.state !== OPENED) return facts;
    const [targetBody, approvalsBody, checks] = await Promise.all([
        optional(ctx, branchPath(ctx, facts.baseBranch), signal),
        optional(ctx, `${base}/approvals`, signal),
        checksOf(ctx, mr, base, signal),
    ]);
    const { required, approvals } = approvalsOf(approvalsBody);
    const status = text(mr.detailed_merge_status) ? mr.detailed_merge_status : '';
    return {
        ...facts,
        targetSha: isObject(targetBody) && isObject(targetBody.commit) ? textOrNull(targetBody.commit.id) : null,
        mergeable: gitlabMergeable(status, mr.has_conflicts === true),
        requiredApprovals: required,
        approvals,
        checks,
    };
}

function tipOf(ctx: Ctx, body: unknown, branch: string): string {
    const id = isObject(body) && isObject(body.commit) ? body.commit.id : undefined;
    if (!text(id) || id === '') throw fail(`GET ${branchPath(ctx, branch)} answered without a tip commit`);
    return id;
}

async function readBranchHead(ctx: Ctx, branch: string, signal: AbortSignal): Promise<string | null> {
    const sent = await send(ctx, branchPath(ctx, branch), signal);
    if (sent.kind === 'absent') return null;
    if (sent.kind !== 'ok') throw fail(`GET ${branchPath(ctx, branch)} failed`);
    return tipOf(ctx, sent.json, branch);
}

/** Whether `tip` holds `sha`: the merge base of the two is `sha`. A commit GitLab does not know is not held. */
async function holds(ctx: Ctx, sha: string, tip: string, signal: AbortSignal): Promise<boolean> {
    if (sha === tip) return true;
    const query = new URLSearchParams([
        ['refs[]', sha],
        ['refs[]', tip],
    ]);
    const path = `${ctx.project}/repository/merge_base?${query}`;
    const sent = await send(ctx, path, signal);
    if (sent.kind === 'absent' || (sent.kind === 'refused' && sent.status === HTTP_BAD_REQUEST)) return false;
    if (sent.kind !== 'ok') throw fail(`GET ${path.split('?')[0]} failed`);
    if (!isObject(sent.json) || !text(sent.json.id)) throw unclean(path.split('?')[0] as string);
    return sent.json.id === sha;
}

const pipelineEntryOf = (entry: unknown) =>
    isObject(entry) && Number.isInteger(entry.id) && text(entry.status) ? entry : null;

async function readBranchState(
    ctx: Ctx,
    branch: string,
    shas: readonly string[],
    signal: AbortSignal
): Promise<BranchState> {
    const headSha = tipOf(ctx, await get(ctx, branchPath(ctx, branch), signal, true), branch);
    const query = new URLSearchParams({ sha: headSha, ref: branch, order_by: 'id', sort: 'desc' });
    const [listing, held] = await Promise.all([
        listed(ctx, `${ctx.project}/pipelines?${query}`, pipelineEntryOf, signal),
        Promise.all(shas.map(async (sha) => [sha, await holds(ctx, sha, headSha, signal)] as const)),
    ]);
    const newest = listing.reduce<Json | null>(
        (a, b) => (a === null || (b.id as number) > (a.id as number) ? b : a),
        null
    );
    const pipeline = newest && {
        id: newest.id as number,
        status: newest.status as string,
        url: textOrNull(newest.web_url),
    };
    const own = pipeline === null ? [] : await pipelineChecks(ctx, pipeline, signal);
    const checks = [...own, ...(await statusChecks(ctx, headSha, own, signal))];
    return { headSha, contains: Object.fromEntries(held), requiredContexts: [], checks };
}

/**
 * The reads of one project. `deadline` is the caller's absolute signal; without one each read makes its own at entry,
 * covering every nested request.
 */
export function createGitLabReads(call: GitlabCall, ref: RepoRef, deadline: () => AbortSignal | undefined) {
    const ctx: Ctx = { call, project: `/api/v4/projects/${encodeURIComponent(ref.path)}` };
    const signalOf = () => deadline() ?? AbortSignal.timeout(FORGE_READ_DEADLINE_MS);
    return {
        readChangeRequest: (iid: number) => readChangeRequest(ctx, ref, iid, signalOf()),
        readBranchHead: (branch: string) => readBranchHead(ctx, branch, signalOf()),
        readBranchState: (branch: string, shas: readonly string[]) => readBranchState(ctx, branch, shas, signalOf()),
    };
}
