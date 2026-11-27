import { ERROR_CODES, formatRepoRef } from '@factory-ai/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { FORGE_ACCESS_REASON, type ForgeRequirementReason } from '../../db/forge-requirement.js';
import type { ForgeClient } from '../../forge/forge-client.js';
import { forgeOfRepo } from '../../forge/forges.js';
import type { PrTokenSource } from '../../forge/pr-token.js';
import { GitHubWriteError, type PrCreate, type PrEdit, type PullRequestFacts } from '../../github/pr-write.js';
import type { JobStore } from '../../db/jobs/job-store-types.js';
import type { OrgRegistry } from '../../orgs.js';
import { bad } from '../helpers.js';
import { resolveLeasedRoute } from '../route-guards.js';
import { canWrite, type ForgeWriteDeps, sourceOf, writerFor } from './pull-request-forge.js';
import { isBranchField } from './job-field-validation.js';
import { BODY_LIMIT, HTTP_OK, leaseLost, notFoundJob } from './job-limits.js';

/**
 * `POST /api/jobs/:id/pull-request` (docs/connections.md): the board views, opens, retargets and edits the task's PR (a GitLab MR the same way) as
 * the thread's starter, with their user token (the installation token under `AUTH_MODE=none`). A worker route: the
 * driver asks under the attempt's lease, and the runner never holds the token. The answer is `pr` (the PR and whether
 * this ask `created` or `reused` it), `none` (a view-only ask found nothing), `waiting` (the starter's grant cannot
 * serve, or the member's token is refused a 403/404: the forge requirement is open), `denied` or `refused` (GitHub's
 * own word); anything unconfirmed is a 503. A member's refusal (not the installation's, whose denial is plain `denied`)
 * waits as `forge-access` and a later successful write closes it; a 401 is the authorization itself refused.
 * One absolute deadline covers the grant read, the refresh, the connection read and every forge call; no lock is held across them.
 */

/** The whole call's wall clock; shorter than the driver's ask deadline, so the driver sees this answer, not its own timeout. */
export const PR_WRITE_DEADLINE_MS = 30_000;
/** GitHub's own limits on a pull request's title and body. */
const TITLE_LIMIT = 256;
const BODY_TEXT_LIMIT = 65_536;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;
const NO_FORGE = "This board holds no credential for the repository's forge, so it opens no change request.";
const NOT_CONFIRMED = 'The change request could not be written just now. Retry shortly.';
const REFUSED_REPO = 'This attempt may not write a pull request: its task names no repository, or not its thread root.';

export interface PullRequestDeps extends ForgeWriteDeps {
    /** The token a write is made with: the starter's grant, or the installation's under `AUTH_MODE=none`. */
    tokens: PrTokenSource;
    /** The call's wall clock; a test shortens it. */
    deadlineMs?: number | undefined;
}

/** What a create carries: GitHub's fields, and the branch the new PR targets. */
type CreateAsk = PrCreate & { base: string };

/** `base` is the branch an EXISTING PR is retargeted to, null to leave it where it is; a create names its own. */
interface Ask {
    branch: string;
    base: string | null;
    create: CreateAsk | null;
    edit: PrEdit | null;
}

const text = (value: unknown, limit: number, required: boolean): value is string =>
    typeof value === 'string' && value.length <= limit && (!required || value.length > 0);

/** The create the body names, null when it names none; undefined when it is malformed. */
function createOf(create: unknown): CreateAsk | null | undefined {
    if (create === undefined || create === null) return null;
    const c = create as Record<string, unknown>;
    const wellFormed =
        typeof create === 'object' &&
        text(c.title, TITLE_LIMIT, true) &&
        text(c.body, BODY_TEXT_LIMIT, false) &&
        typeof c.draft === 'boolean' &&
        isBranchField(c.base);
    return wellFormed
        ? { title: c.title as string, body: c.body as string, draft: c.draft as boolean, base: c.base as string }
        : undefined;
}

/** The edit the body names, null when it names none; undefined when it is malformed. */
function editOf(edit: unknown): PrEdit | null | undefined {
    if (edit === undefined || edit === null) return null;
    const e = edit as Record<string, unknown>;
    const wellFormed =
        typeof edit === 'object' &&
        (e.title === undefined || text(e.title, TITLE_LIMIT, true)) &&
        (e.body === undefined || text(e.body, BODY_TEXT_LIMIT, false));
    if (!wellFormed) return undefined;
    return {
        ...(e.title === undefined ? {} : { title: e.title as string }),
        ...(e.body === undefined ? {} : { body: e.body as string }),
    };
}

/** The ask the body makes, or the reason it is refused. */
function validateAsk(fields: Record<string, unknown>): { ok: true; value: Ask } | { ok: false; message: string } {
    const { branch, base } = fields;
    if (!isBranchField(branch)) return { ok: false, message: 'branch must be a branch name' };
    if (base !== undefined && base !== null && !isBranchField(base)) {
        return { ok: false, message: 'base must be a branch name' };
    }
    const create = createOf(fields.create);
    if (create === undefined) {
        return {
            ok: false,
            message: `create needs a title (1..${TITLE_LIMIT}), a body (..${BODY_TEXT_LIMIT}), a draft flag and a base branch`,
        };
    }
    const edit = editOf(fields.edit);
    if (edit === undefined) {
        return { ok: false, message: `edit may carry a title (1..${TITLE_LIMIT}) and a body (..${BODY_TEXT_LIMIT})` };
    }
    return { ok: true, value: { branch, base: typeof base === 'string' ? base : null, create, edit } };
}

/** `wrote`: a create or a PATCH succeeded under the token. A view, or a reuse left as it was, proves no write access. */
type Outcome =
    | { answer: 'pr'; pr: PullRequestFacts; operation: 'created' | 'reused'; wrote: boolean }
    | { answer: 'none' };

/** The view, create, retarget and edit the ask names, under one token. A failure is the writer's classified error. */
async function carryOut(client: ForgeClient, ask: Ask, signal: AbortSignal): Promise<Outcome> {
    let pr: PullRequestFacts | null;
    let operation: 'created' | 'reused' = 'reused';
    if (ask.create) {
        // A create names its own base; the top-level `base` only retargets a PR that already exists.
        const { base, ...fields } = ask.create;
        const opened = await client.openChangeRequest({ branch: ask.branch, base, create: fields }, signal);
        ({ pr, operation } = opened);
    } else {
        pr = await client.findChangeRequest(ask.branch, signal);
    }
    if (!pr) return { answer: 'none' };
    let wrote = operation === 'created';
    if (operation === 'reused') {
        const moved = ask.base !== null && pr.base !== ask.base ? { base: ask.base } : {};
        const change = { ...moved, ...(ask.edit ?? {}) };
        if (ask.edit) pr = await client.editChangeRequest(pr.number, change, signal);
        else if (ask.base !== null && 'base' in moved)
            pr = await client.retargetChangeRequest(pr.number, ask.base, signal);
        wrote = ask.edit !== null || 'base' in moved;
    }
    return { answer: 'pr', pr, operation, wrote };
}

type Reply = FastifyReply;
type Written = Parameters<PrTokenSource>[0] & { rootJobId: string };

/** The attempt's task, or the refusal already sent. */
async function contextOf(
    store: Pick<JobStore, 'prWriteContext'>,
    reply: Reply,
    attempt: { id: string; leaseToken: string }
): Promise<Written | null> {
    const context = await store.prWriteContext(attempt.id, attempt.leaseToken);
    if (context.result !== 'ok') {
        void (context.result === 'missing' ? notFoundJob(reply) : leaseLost(reply));
        return null;
    }
    const { orgId, rootJobId, repo, rootRepo, executionUserId } = context;
    // The write is narrowed to the attempt's own repository, which must be the thread root's.
    if (repo === null || rootRepo === null || formatRepoRef(repo) !== formatRepoRef(rootRepo)) {
        void bad(reply, ERROR_CODES.CONNECTION_NOT_AUTHORIZED, REFUSED_REPO, HTTP_FORBIDDEN);
        return null;
    }
    return { orgId, rootJobId, repo, executionUserId };
}

/** What the writer's classified failure answers: GitHub's own word, or no verdict at all (a 503). */
function failureAnswer(e: unknown): { answer: 'denied' } | { answer: 'refused'; detail: string } | null {
    if (!(e instanceof GitHubWriteError)) return null;
    if (e.kind === 'denied') return { answer: 'denied' };
    return e.kind === 'refused' ? { answer: 'refused', detail: e.message } : null;
}

/** A member's own token refused a write or a view with a 403/404: they cannot write to the repository. */
const lacksWriteAccess = (e: unknown, as: 'user' | 'installation'): boolean =>
    as === 'user' &&
    e instanceof GitHubWriteError &&
    e.kind === 'denied' &&
    (e.status === HTTP_FORBIDDEN || e.status === HTTP_NOT_FOUND);

/** The wait the starter's grant opens, under the lease as it stands now. */
async function openWait(
    store: Pick<JobStore, 'openPrForgeWait'>,
    reply: Reply,
    attempt: { id: string; leaseToken: string },
    wait: { forge: string; reason: ForgeRequirementReason }
) {
    const opened = await store.openPrForgeWait(attempt.id, attempt.leaseToken, wait);
    if (opened.result === 'missing') return notFoundJob(reply);
    if (opened.result === 'lost') return leaseLost(reply);
    return reply.code(HTTP_OK).send({ answer: 'waiting', ...wait });
}

/**
 * The ask under the token: the outcome, or `no-access` when the member's own token is refused. Only a create or a PATCH
 * that succeeded under the member's token closes the thread's wait (a view proves read access, not write access); a
 * throw there is a 503, and the driver's retry reuses the PR by head and edits it, closing again.
 */
async function write(
    client: ForgeClient,
    run: {
        store: Pick<JobStore, 'closePrForgeWait'>;
        who: Written;
        token: Extract<Awaited<ReturnType<PrTokenSource>>, { ok: true }>;
        ask: Ask;
        signal: AbortSignal;
    }
): Promise<Outcome | { answer: 'no-access'; forge: string }> {
    const { store, who, token, ask, signal } = run;
    let outcome: Outcome;
    try {
        outcome = await carryOut(client, ask, signal);
    } catch (e) {
        const forge = forgeOfRepo(who.repo);
        if (forge !== null && lacksWriteAccess(e, token.as)) return { answer: 'no-access', forge };
        throw e;
    }
    if (token.as === 'user' && who.executionUserId !== null && outcome.answer === 'pr' && outcome.wrote) {
        await store.closePrForgeWait(who.rootJobId, who.executionUserId);
    }
    return outcome;
}

export async function handlePullRequest(
    orgs: OrgRegistry,
    deps: PullRequestDeps,
    request: FastifyRequest,
    reply: FastifyReply
) {
    reply.header('cache-control', 'no-store');
    const route = await resolveLeasedRoute<'prWriteContext' | 'openPrForgeWait' | 'closePrForgeWait'>(
        orgs,
        request,
        reply
    );
    if (!route) return reply;
    const { store, id, fields, leaseToken } = route;
    const attempt = { id, leaseToken };
    const asked = validateAsk(fields);
    if (!asked.ok) return bad(reply, ERROR_CODES.BAD_BODY, asked.message);
    // A throw below confirmed nothing, and is never a verdict: the caller asks again.
    try {
        const who = await contextOf(store, reply, attempt);
        if (!who) return reply;
        if (!canWrite(deps, who.repo)) return bad(reply, ERROR_CODES.GITHUB_UNAVAILABLE, NO_FORGE, HTTP_CONFLICT);
        const signal = AbortSignal.any([
            AbortSignal.timeout(deps.deadlineMs ?? PR_WRITE_DEADLINE_MS),
            request.closing,
            closedBy(reply),
        ]);
        const token = await deps.tokens(who, signal);
        if (!token.ok) {
            if (token.answer === 'no-forge') return bad(reply, ERROR_CODES.GITHUB_UNAVAILABLE, NO_FORGE, HTTP_CONFLICT);
            if (token.answer === 'unavailable') throw new Error('the member token is not confirmed');
            return await openWait(store, reply, attempt, { forge: token.forge, reason: token.reason });
        }
        const client = writerFor(await sourceOf(deps, who.orgId, who.repo, signal), who.repo, token.token);
        const done = await write(client, { store, who, token, ask: asked.value, signal });
        if (done.answer === 'no-access') {
            return await openWait(store, reply, attempt, { forge: done.forge, reason: FORGE_ACCESS_REASON });
        }
        if (done.answer === 'none') return reply.code(HTTP_OK).send(done);
        const { pr, operation } = done;
        return reply.code(HTTP_OK).send({ answer: 'pr', operation, url: pr.url, number: pr.number });
    } catch (e) {
        const answered = failureAnswer(e);
        if (answered) return reply.code(HTTP_OK).send(answered);
        // Logged without the error text: it may quote a remote body, and the answer is read by the driver.
        request.log.warn({ jobId: id, kind: (e as { kind?: string }).kind }, 'pull request: no answer to trust');
        return bad(reply, ERROR_CODES.UNAVAILABLE, NOT_CONFIRMED, HTTP_SERVICE_UNAVAILABLE);
    }
}

/** Aborts when the client hangs up before the answer is sent. */
export function closedBy(reply: FastifyReply): AbortSignal {
    const gone = new AbortController();
    reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) gone.abort();
    });
    return gone.signal;
}

/** The worker route, under the attempt's lease. */
export function pullRequestRoutes(app: FastifyInstance, orgs: OrgRegistry, deps: PullRequestDeps): void {
    app.post('/api/jobs/:id/pull-request', { bodyLimit: BODY_LIMIT }, (request, reply) =>
        handlePullRequest(orgs, deps, request, reply)
    );
}
