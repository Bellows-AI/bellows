import { ERROR_CODES, formatRepoRef, type RepoRef } from '@factory-ai/core';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { LiveAttempt } from '../../db/attempt-of-lease.js';
import type { ChangeRequestContext } from '../../db/jobs/job-store-change-request.js';
import {
    ChangeRequestReadUnsupportedError,
    isChangeRequestPart,
    type ChangeRequestPart,
} from '../../forge/change-request-read.js';
import type { GitlabAccess } from '../../forge/forge-gate.js';
import { isGitlabRepo } from '../../forge/forges.js';
import { memberTokenOf } from '../../forge/pr-token.js';
import type { MemberForgeGrants } from '../../integrations/member-forge-grant.js';
import type { OrgRegistry } from '../../orgs.js';
import {
    type ForgeCredentialDeps,
    grantRequiredBody,
    notLive,
    pairOf,
    refused,
    unavailable,
    waitAnswer,
} from '../forge-credential.js';
import { bad } from '../helpers.js';
import { resolveJobRoute } from '../route-guards.js';
import { closedBy } from './job-handlers-pull-request.js';
import { notFoundJob } from './job-limits.js';
import { sourceOf } from '../../forge/forge-reads.js';
import { writerFor } from './pull-request-forge.js';

/**
 * `GET /api/jobs/:id/change-request?part=diff|notes|pipeline` (a person, MCP) and
 * `GET /api/jobs/:id/agent-change-request?part=…` (a running attempt, by its pair): the merge request a GitLab task's
 * thread recorded, read as the thread's STARTER with their own token (docs/gitlab.md). Only that recorded request is
 * ever read, never a number a caller names, so the starter's access is no way to browse other merge requests.
 *
 * - `200 { part, number, url, … }` — the whole part: `files`, `notes` or `sha`, `pipeline` and `statuses`.
 * - `404 NO_CHANGE_REQUEST` — the thread recorded none (a confirmed read of the row).
 * - `409 CHANGE_REQUEST_READ_UNSUPPORTED` — a GitHub task: its agent keeps `gh`; no request is made.
 * - `409 FORGE_GRANT_REQUIRED { forge, standing, waiting, connectUrl }` — the starter's grant cannot serve. The attempt's
 *   route holds the thread on it (`waiting: true`, as the credential route does); a person's read opens no wait.
 * - `503 UNAVAILABLE` — anything unconfirmed (a 5xx, timeout, malformed or refused answer, a part past its page or byte
 *   cap): never a shorter list, an empty diff or a denial.
 * - The attempt's route: `403` with no pair, `503 LEASE_PENDING` for a superseded one.
 * One absolute deadline covers the grant read, the connection read and every page.
 */

/** Under MCP's 55 s tool deadline, so a person's tool sees this answer and not its own timeout. */
export const CHANGE_REQUEST_READ_DEADLINE_MS = 50_000;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_OK = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;
const NOT_CONFIRMED = 'The merge request could not be read just now. Retry shortly.';
const UNSUPPORTED = 'The board reads merge requests of GitLab tasks only; read a GitHub pull request with gh.';
const NONE_RECORDED = "This task's thread has recorded no change request yet.";
const BAD_PART = `part must be one of diff, notes, pipeline`;

export interface ChangeRequestReadDeps {
    /** Absent without member sign-in (`AUTH_MODE=none`): there is no starter's grant to read with. */
    memberGrants: MemberForgeGrants | undefined;
    gitlab: GitlabAccess;
    /** The board's public origin: the grant's link. */
    publicUrl: string;
    /** The call's wall clock; a test shortens it. */
    deadlineMs?: number | undefined;
}

type Read =
    | { kind: 'ok'; body: object }
    | { kind: 'unsupported' }
    | { kind: 'none' }
    | { kind: 'grant'; forge: string; reason: 'missing' | 'reconnect' };

/** The part the ask names, or the refusal already sent. */
function partOf(request: FastifyRequest, reply: FastifyReply): ChangeRequestPart | null {
    const { part } = request.query as { part?: unknown };
    if (isChangeRequestPart(part)) return part;
    void bad(reply, ERROR_CODES.BAD_QUERY, BAD_PART);
    return null;
}

/** The starter's token for the recorded request, or why there is none (a refusal the route answers). */
export type StarterToken =
    | { kind: 'token'; token: string; ref: RepoRef; number: number }
    | { kind: 'unsupported' }
    | { kind: 'none' }
    | { kind: 'grant'; forge: string; reason: 'missing' | 'reconnect' };

/** The thread starter's own GitLab token for the thread's recorded request. A throw confirmed nothing (a 503). */
export async function starterToken(
    deps: { memberGrants: MemberForgeGrants | undefined },
    who: ChangeRequestContext,
    signal: AbortSignal
): Promise<StarterToken> {
    const { ref, publication, executionUserId, orgId } = who;
    if (!ref || !isGitlabRepo(ref) || !deps.memberGrants) return { kind: 'unsupported' };
    if (!publication) return { kind: 'none' };
    if (executionUserId === null) throw new Error('the thread has no starter to read as');
    const forge = `${ref.forge}:${ref.host}`;
    const token = await memberTokenOf(deps.memberGrants, { orgId, userId: executionUserId, forge }, signal);
    if (!token.ok) {
        if (token.answer === 'waiting') return { kind: 'grant', forge: token.forge, reason: token.reason };
        throw new Error('the starter token is not confirmed');
    }
    return { kind: 'token', token: token.token, ref, number: publication.number };
}

/** The read itself: the recorded request's part under the starter's token. A throw confirmed nothing (a 503). */
async function readRecorded(
    deps: ChangeRequestReadDeps,
    who: ChangeRequestContext,
    part: ChangeRequestPart,
    signal: AbortSignal
): Promise<Read> {
    const starter = await starterToken(deps, who, signal);
    if (starter.kind !== 'token') return starter;
    const { ref, token, number } = starter;
    const source = await sourceOf({ forge: {}, gitlab: deps.gitlab }, who.orgId, ref, signal);
    try {
        const read = await writerFor(source, ref, token).readChangeRequestPart(number, part, signal);
        return { kind: 'ok', body: { ...read, number, url: who.publication?.url } };
    } catch (e) {
        if (e instanceof ChangeRequestReadUnsupportedError) return { kind: 'unsupported' };
        throw e;
    }
}

export const unconfirmed = (request: FastifyRequest, reply: FastifyReply, id: string, e: unknown) => {
    // Logged without the error text: it may quote a remote body.
    request.log.warn({ jobId: id, kind: (e as { name?: string }).name }, 'change request read: no answer to trust');
    return bad(reply, ERROR_CODES.UNAVAILABLE, NOT_CONFIRMED, HTTP_SERVICE_UNAVAILABLE);
};

const deadlineOf = (deps: ChangeRequestReadDeps, request: FastifyRequest, reply: FastifyReply) =>
    AbortSignal.any([
        AbortSignal.timeout(deps.deadlineMs ?? CHANGE_REQUEST_READ_DEADLINE_MS),
        request.closing,
        closedBy(reply),
    ]);

/** The answers both routes share, once the read has one. */
function answer(reply: FastifyReply, read: Exclude<Read, { kind: 'grant' }>) {
    if (read.kind === 'ok') return reply.code(HTTP_OK).send(read.body);
    if (read.kind === 'none') return bad(reply, ERROR_CODES.NO_CHANGE_REQUEST, NONE_RECORDED, HTTP_NOT_FOUND);
    return bad(reply, ERROR_CODES.CHANGE_REQUEST_READ_UNSUPPORTED, UNSUPPORTED, HTTP_CONFLICT);
}

/** The person's route: a member reads their task's recorded request through the starter's access. */
async function handleUserRead(
    orgs: OrgRegistry,
    deps: ChangeRequestReadDeps,
    request: FastifyRequest,
    reply: FastifyReply
) {
    reply.header('cache-control', 'no-store');
    const route = await resolveJobRoute<'changeRequestContext'>(orgs, request, reply);
    if (!route) return reply;
    const part = partOf(request, reply);
    if (!part) return reply;
    try {
        const who = await route.store.changeRequestContext(route.id);
        if (who.result === 'missing') return notFoundJob(reply);
        const read = await readRecorded(deps, who, part, deadlineOf(deps, request, reply));
        if (read.kind !== 'grant') return answer(reply, read);
        const { forge, reason } = read;
        const body = grantRequiredBody(deps.publicUrl, {
            orgId: who.orgId,
            rootJobId: who.rootJobId,
            forge,
            reason,
            waiting: false,
        });
        return reply.code(HTTP_CONFLICT).send(body);
    } catch (e) {
        return unconfirmed(request, reply, route.id, e);
    }
}

/** The thread root's repository is the attempt's own, as for every runner credential. */
const ownRepo = (attempt: LiveAttempt): boolean =>
    attempt.ref !== null && attempt.rootRef !== null && formatRepoRef(attempt.ref) === formatRepoRef(attempt.rootRef);

export interface AgentChangeRequestDeps extends ForgeCredentialDeps {
    gitlab: GitlabAccess;
    deadlineMs?: number | undefined;
}

/** The live attempt on its own repository and the thread's recorded request, or the refusal already sent. */
export async function attemptContext(
    deps: AgentChangeRequestDeps,
    reply: FastifyReply,
    pair: { jobId: string; leaseToken: string }
): Promise<{ attempt: LiveAttempt; who: ChangeRequestContext } | null> {
    const attempt = await deps.attemptOfLease(pair.jobId, pair.leaseToken);
    if (!attempt.ok) {
        void notLive(reply, attempt);
        return null;
    }
    if (!ownRepo(attempt)) {
        void refused(reply);
        return null;
    }
    const store = (await deps.orgs.for(attempt.orgId))?.jobs;
    if (!store) {
        void unavailable(reply);
        return null;
    }
    const who = await store.changeRequestContext(attempt.jobId);
    if (who.result !== 'ok') {
        void refused(reply);
        return null;
    }
    return { attempt, who };
}

/** The attempt's route: the same read under its pair, and the same hold on a broken grant as the credential route. */
const agentHandler = (deps: AgentChangeRequestDeps) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    const pair = pairOf(request);
    if (pair === null) return refused(reply);
    const part = partOf(request, reply);
    if (!part) return reply;
    try {
        const found = await attemptContext(deps, reply, pair);
        if (!found) return reply;
        const { attempt, who } = found;
        const read = await readRecorded(deps, who, part, deadlineOf(deps, request, reply));
        // The read took time: a cancel, settle or takeover during it withholds the answer, as the credential's does.
        const still = await deps.attemptOfLease(pair.jobId, pair.leaseToken);
        if (!still.ok) return notLive(reply, still);
        if (still.orgId !== attempt.orgId || still.claimSeq !== attempt.claimSeq) return refused(reply);
        if (read.kind !== 'grant') return answer(reply, read);
        const { forge, reason } = read;
        return await waitAnswer(deps, reply, { attempt, leaseToken: pair.leaseToken, forge, reason });
    } catch (e) {
        return unconfirmed(request, reply, pair.jobId, e);
    }
};

export const changeRequestRoutes = (app: FastifyInstance, orgs: OrgRegistry, deps: ChangeRequestReadDeps): void => {
    app.get('/api/jobs/:id/change-request', (request, reply) => handleUserRead(orgs, deps, request, reply));
};

export const agentChangeRequestRoutes =
    (deps: AgentChangeRequestDeps): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/jobs/:id/agent-change-request', agentHandler(deps));
    };
