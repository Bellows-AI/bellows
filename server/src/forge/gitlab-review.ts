import { CHECKS_PENDING, type RepoRef } from '@factory-ai/core';
import { isSuccess, type GitlabCall } from './gitlab-call.js';
import { type Ctx, get, isObject, listed, readChangeRequest, text, unclean } from './gitlab-reads.js';
import {
    addressedKeys,
    addressedMarker,
    boundCollection,
    REVIEW_COLLECT_SCHEMA,
    REVIEW_REPLY_SCHEMA,
    type ReviewCollection,
    type ReviewCommentItem,
    type ReviewPlan,
    type ReviewPlanTarget,
    type ReviewRef,
    type ReviewThread,
} from './review-collection.js';

/**
 * What the board reads and writes of one GitLab merge request's discussions as the acting member (docs/workflows.md):
 * the `review-collect/v1` collection the review-reconcile block decides on, and the `review-reply/v1` results of a plan.
 * A read is the whole listing or a throw (`transport`, `not_found`, `rate_limited`): a failed, partial or malformed page,
 * an entry a consumer would use unvalidated, never a shorter list or "no comments". A write is looked up before it is
 * sent (the marker is the receipt), never re-sent in a call, and a lost answer is read back, never assumed.
 */

/** Each under the helper step's 300 s, with room for the script's own deadline above it (docs/jobs.md). */
export const REVIEW_READ_DEADLINE_MS = 50_000;
export const REVIEW_WRITE_DEADLINE_MS = 120_000;
/** One write's own wait, so a lost answer leaves the call's deadline for the read-back. */
export const REVIEW_WRITE_ATTEMPT_MS = 30_000;

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const DISCUSSION_NOT_FOUND = /^404 Discussion Not Found$/;
const SETTLED = new Set(['approved', 'reviewed']);
const CHANGES_REQUESTED = 'requested_changes';
const DECISION_CHANGES = 'CHANGES_REQUESTED';

interface Position {
    path: string;
    line: number | null;
    headSha: string | null;
}
interface Note {
    id: number;
    body: string;
    system: boolean;
    resolvable: boolean;
    resolved: boolean;
    author: string | null;
    createdAt: string | null;
    position: Position | null;
}
interface Discussion {
    id: string;
    individual: boolean;
    notes: Note[];
}

const optionalText = (value: unknown): boolean => value === undefined || value === null || text(value);
const optionalLine = (value: unknown): boolean => value === undefined || value === null || Number.isInteger(value);

/** The position of a diff note, null for none, `undefined` for one whose path or line is not what GitLab says. */
function positionOf(raw: unknown): Position | null | undefined {
    if (raw === undefined || raw === null) return null;
    if (!isObject(raw)) return undefined;
    const { new_path: newPath, old_path: oldPath, new_line: newLine, old_line: oldLine, head_sha: sha } = raw;
    if (!optionalText(newPath) || !optionalText(oldPath) || (!text(newPath) && !text(oldPath))) return undefined;
    if (!optionalLine(newLine) || !optionalLine(oldLine)) return undefined;
    const line = Number.isInteger(newLine)
        ? (newLine as number)
        : Number.isInteger(oldLine)
          ? (oldLine as number)
          : null;
    return { path: (text(newPath) ? newPath : oldPath) as string, line, headSha: text(sha) ? sha : null };
}

function noteOf(raw: unknown): Note | null {
    if (!isObject(raw)) return null;
    const { id, body, system, resolvable, resolved, author, created_at: createdAt } = raw;
    if (!Number.isInteger(id) || !text(body) || typeof system !== 'boolean' || typeof resolvable !== 'boolean')
        return null;
    if (resolvable && typeof resolved !== 'boolean') return null;
    const position = positionOf(raw.position);
    if (position === undefined) return null;
    return {
        id: id as number,
        body,
        system,
        resolvable,
        resolved: resolvable && resolved === true,
        author: isObject(author) && text(author.username) ? author.username : null,
        createdAt: text(createdAt) ? createdAt : null,
        position,
    };
}

function discussionOf(raw: unknown): Discussion | null {
    if (!isObject(raw) || !text(raw.id) || typeof raw.individual_note !== 'boolean') return null;
    if (!Array.isArray(raw.notes) || raw.notes.length === 0) return null;
    const notes = raw.notes.map(noteOf);
    if (notes.some((note) => note === null)) return null;
    return { id: raw.id, individual: raw.individual_note, notes: notes as Note[] };
}

const reviewerOf = (raw: unknown): { login: string; state: string } | null =>
    isObject(raw) && isObject(raw.user) && text(raw.user.username) && text(raw.state)
        ? { login: raw.user.username, state: raw.state }
        : null;

const ctxOf = (call: GitlabCall, ref: RepoRef): Ctx => ({
    call,
    project: `/api/v4/projects/${encodeURIComponent(ref.path)}`,
});
const baseOf = (ctx: Ctx, iid: number) => `${ctx.project}/merge_requests/${iid}`;
const readDiscussions = (ctx: Ctx, base: string, signal: AbortSignal) =>
    listed(ctx, `${base}/discussions`, discussionOf, signal);

/** The driver's `ReviewRef` of a merge request: its namespace, its project and its number. */
export function reviewRefOf(ref: RepoRef, iid: number): ReviewRef {
    const cut = ref.path.lastIndexOf('/');
    return { owner: ref.path.slice(0, cut), repo: ref.path.slice(cut + 1), number: iid };
}

const itemOf = (note: Note): ReviewCommentItem => ({
    id: note.id,
    author: note.author,
    body: note.body,
    createdAt: note.createdAt,
    path: null,
    line: null,
    diffHunk: null,
    inReplyToId: null,
    reviewId: null,
});

function threadOf(discussion: Discussion, headSha: string): ReviewThread | null {
    const comments = discussion.notes
        .filter((note) => !note.system)
        .sort((a, b) => a.id - b.id)
        .map((note) => ({
            id: String(note.id),
            databaseId: note.id,
            author: note.author,
            body: note.body,
            createdAt: note.createdAt,
        }));
    if (comments.length === 0) return null;
    const position = discussion.notes.find((note) => note.position)?.position ?? null;
    const sha = position?.headSha ?? null;
    return {
        id: discussion.id,
        isResolved: discussion.notes.filter((note) => note.resolvable).every((note) => note.resolved),
        isOutdated: sha !== null && SHA_PATTERN.test(sha) && sha.toLowerCase() !== headSha.toLowerCase(),
        path: position?.path ?? null,
        line: position?.line ?? null,
        comments,
    };
}

/** The review collection of merge request `iid`, as the token's holder reads it; any unconfirmed read throws. */
export async function readReviewCollection(
    call: GitlabCall,
    ref: RepoRef,
    iid: number,
    signal: AbortSignal
): Promise<ReviewCollection> {
    const ctx = ctxOf(call, ref);
    const base = baseOf(ctx, iid);
    const facts = await readChangeRequest(ctx, ref, iid, signal);
    const discussions = await readDiscussions(ctx, base, signal);
    const reviewers = await listed(ctx, `${base}/reviewers`, reviewerOf, signal);
    const threads = discussions
        .filter((discussion) => !discussion.individual)
        .map((discussion) => threadOf(discussion, facts.headSha))
        .filter((thread): thread is ReviewThread => thread !== null)
        .sort((a, b) => (a.comments[0]?.databaseId ?? 0) - (b.comments[0]?.databaseId ?? 0));
    const general = discussions
        .filter((discussion) => discussion.individual)
        .flatMap((discussion) => discussion.notes.filter((note) => !note.system).map(itemOf))
        .sort((a, b) => a.id - b.id);
    // A state this does not know counts as requested: a wait, never a clean review.
    const requested = reviewers.filter((r) => r.state !== CHANGES_REQUESTED && !SETTLED.has(r.state));
    return boundCollection({
        version: 1,
        schema: REVIEW_COLLECT_SCHEMA,
        ref: reviewRefOf(ref, iid),
        general,
        reviews: [],
        inline: [],
        threads,
        addressed: addressedKeys(discussions.flatMap((d) => d.notes.map((note) => note.body))),
        requestedReviewers: { users: requested.map((r) => r.login).sort(), teams: [] },
        decision: reviewers.some((r) => r.state === CHANGES_REQUESTED) ? DECISION_CHANGES : null,
        pendingChecks: facts.checks.filter((check) => check.state === CHECKS_PENDING).length,
        truncated: { sections: [], bodies: 0, diffHunks: 0, threads: 0, total: false },
        error: null,
    });
}

export interface ReviewReplyResult {
    id: string;
    kind: string;
    status: 'done' | 'noop' | 'refused';
    reason: string | null;
}
export interface ReviewReply {
    version: 1;
    schema: typeof REVIEW_REPLY_SCHEMA;
    ref: ReviewRef;
    results: ReviewReplyResult[];
    error: null;
}

type Outcome = Pick<ReviewReplyResult, 'status' | 'reason'>;
const DONE: Outcome = { status: 'done', reason: null };
const noop = (reason: string): Outcome => ({ status: 'noop', reason });
const refused = (reason: string): Outcome => ({ status: 'refused', reason });
const resolvedOf = (discussion: Discussion) =>
    discussion.notes.filter((note) => note.resolvable).every((note) => note.resolved);

/** What one write's answer settles, or null when it left the outcome unknown (no answer, a 5xx, a malformed 2xx). */
async function written(attempt: Promise<Awaited<ReturnType<GitlabCall>>>): Promise<Outcome | null> {
    const answer = await attempt;
    if (!answer.ok) return answer.sent ? null : refused('not_sent');
    const { status, json } = answer;
    if (isSuccess(status)) return DONE;
    if (status === HTTP_UNAUTHORIZED) return refused('auth');
    if (status === HTTP_FORBIDDEN) return refused('permission');
    if (status === HTTP_TOO_MANY_REQUESTS) return refused('rate');
    if (status >= HTTP_SERVER_ERROR) return null;
    const named =
        status === HTTP_NOT_FOUND && isObject(json) && text(json.message) && DISCUSSION_NOT_FOUND.test(json.message);
    return named ? noop('not_found') : refused(`http_${status}`);
}

/** One write, once: its own wait inside the call's deadline, then a read-back of what an unknown answer left. */
async function write(
    ctx: Ctx,
    request: { method: 'POST' | 'PUT'; path: string; body?: object },
    readBack: () => Promise<boolean>,
    limits: { signal: AbortSignal; attemptMs: number; live: (() => Promise<boolean>) | undefined }
): Promise<Outcome> {
    // Nothing is sent for a call that has no time left, or for an attempt that is no longer the one acting.
    if (limits.signal.aborted || (limits.live && !(await limits.live()))) return refused('not_sent');
    const attempt = AbortSignal.any([limits.signal, AbortSignal.timeout(limits.attemptMs)]);
    const settled = await written(ctx.call(request.method, request.path, attempt, request.body));
    if (settled) return settled;
    try {
        return (await readBack()) ? DONE : refused('unconfirmed');
    } catch {
        return refused('unconfirmed');
    }
}

interface Replier {
    ctx: Ctx;
    base: string;
    byId: Map<string, Discussion>;
    marked: Set<string>;
    signal: AbortSignal;
    attemptMs: number;
    live: (() => Promise<boolean>) | undefined;
}

const discussionPath = (env: Replier, id: string) => `${env.base}/discussions/${encodeURIComponent(id)}`;

async function resolveTarget(env: Replier, target: ReviewPlanTarget): Promise<Outcome> {
    const discussion = env.byId.get(target.id);
    if (!discussion) return noop('not_found');
    if (resolvedOf(discussion)) return noop('already_resolved');
    const path = discussionPath(env, target.id);
    const resolvedNow = async () => {
        const read = discussionOf(await get(env.ctx, path, env.signal));
        if (!read) throw unclean(path);
        return resolvedOf(read);
    };
    return write(env.ctx, { method: 'PUT', path: `${path}?resolved=true` }, resolvedNow, env);
}

async function replyTarget(env: Replier, target: ReviewPlanTarget): Promise<Outcome> {
    const key = target.kind === 'thread' ? `thread:${target.id}` : target.id;
    const marker = addressedMarker(key);
    if (!target.reply?.endsWith(marker)) return refused('unmarked');
    if (env.marked.has(key)) return noop('already_replied');
    if (target.kind === 'thread' && !env.byId.has(target.id)) return noop('not_found');
    const path = target.kind === 'thread' ? `${discussionPath(env, target.id)}/notes` : `${env.base}/notes`;
    const landed = async () =>
        (await readDiscussions(env.ctx, env.base, env.signal)).some((d) =>
            d.notes.some((note) => note.body.includes(marker))
        );
    const outcome = await write(env.ctx, { method: 'POST', path, body: { body: target.reply } }, landed, env);
    if (outcome.status === 'done') env.marked.add(key);
    return outcome;
}

function executeTarget(env: Replier, target: ReviewPlanTarget): Promise<Outcome> {
    if (target.status === 'refused') return Promise.resolve(refused(target.reason ?? 'refused by plan'));
    if (target.kind === 'inline') return Promise.resolve(refused('unsupported'));
    return target.kind === 'resolve' ? resolveTarget(env, target) : replyTarget(env, target);
}

/**
 * Executes `plan` against merge request `iid` as the token's holder; the initial discussion read throws when unconfirmed.
 * `limits.attemptMs` is each write's own wait inside the call's `signal`; `limits.live` is asked before every write.
 */
export async function replyReview(
    call: GitlabCall,
    { ref, iid }: { ref: RepoRef; iid: number },
    plan: ReviewPlan,
    limits: { signal: AbortSignal; attemptMs?: number; live?: () => Promise<boolean> }
): Promise<ReviewReply> {
    const ctx = ctxOf(call, ref);
    const base = baseOf(ctx, iid);
    const discussions = await readDiscussions(ctx, base, limits.signal);
    const env: Replier = {
        ctx,
        base,
        byId: new Map(discussions.map((discussion) => [discussion.id, discussion])),
        marked: new Set(addressedKeys(discussions.flatMap((d) => d.notes.map((note) => note.body)))),
        signal: limits.signal,
        attemptMs: limits.attemptMs ?? REVIEW_WRITE_ATTEMPT_MS,
        live: limits.live,
    };
    const results: ReviewReplyResult[] = [];
    for (const target of plan.targets) {
        results.push({ id: target.id, kind: target.kind, ...(await executeTarget(env, target)) });
    }
    return { version: 1, schema: REVIEW_REPLY_SCHEMA, ref: reviewRefOf(ref, iid), results, error: null };
}
