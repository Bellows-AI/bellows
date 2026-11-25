import { ERROR_CODES, formatRepoRef, gitlabHostOf } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { JOB_ID_HEADER, LEASE_TOKEN_HEADER } from '../auth/plugin.js';
import type { AttemptCheck, AttemptOfLease, LiveAttempt } from '../db/attempt-of-lease.js';
import { forgeConnectPath, forgeLabel, forgeOfRepo } from '../forge/forges.js';
import { UUID } from '../identifiers.js';
import type { MemberForgeGrants, MemberTokenResult } from '../integrations/member-forge-grant.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, leasePending } from './helpers.js';

/**
 * `POST /api/jobs/:id/credentials/gitlab` (docs/gitlab.md): a running attempt's request for the credential of its thread
 * STARTER's GitLab grant. The attempt pair is the only credential the route accepts (`CONNECTOR_ROUTES` in
 * auth/plugin.ts), and the attempt must be live on a GitLab repository, the thread root's own. The board reads the
 * starter's grant, refreshing it through the lineage (GitLab rotates the refresh token on every use), and answers:
 *
 * - `200 { forge, standing: 'live', token, expiresAt }` — the grant serves: the starter's current access token and its
 *   expiry (ISO, or null for one that carries none), `Cache-Control: no-store`. The attempt is checked before the token
 *   is read and again after, so a cancel, settle or takeover during the refresh withholds it. The token is in the
 *   answer and nowhere else: no log line, no error text.
 * - `409 FORGE_GRANT_REQUIRED { forge, standing: 'missing' | 'broken', waiting: true, connectUrl }` — the grant was
 *   revoked, needs reconnect or is gone. The thread now waits (the runtime requirement with provider `forge` and target
 *   `gitlab:<host>`): the heartbeat tells the attempt, and a takeover of it, to stop and hand the task back, and the
 *   claim holds it, session and checkout kept, until the member links again at `connectUrl`. Asking again is the same
 *   wait, not a new one.
 * - `503 UNAVAILABLE` (retryable) — the grant could not be confirmed (a 5xx or timeout at GitLab, the secret store, a
 *   lease read): no wait is opened and nothing is concluded.
 * - `503 LEASE_PENDING` / `403 CONNECTION_NOT_AUTHORIZED` — as every runner credential route.
 */

const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_OK = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;
/** The request carries nothing; the pair is in the headers. */
const BODY_LIMIT = 1024;
const DEADLINE_MS = 20_000;

const ATTEMPT_REFUSED =
    'This attempt may not have a GitLab credential: it is no longer running, or its task is no longer authorized. Do not retry.';
const NOT_GITLAB = "This task's repository is not on GitLab, so it has no GitLab credential. Do not retry.";
const UNREADABLE = 'The GitLab connection could not be read just now. Retry shortly.';

export interface ForgeCredentialDeps {
    attemptOfLease: AttemptOfLease;
    memberGrants: MemberForgeGrants;
    orgs: OrgRegistry;
    /** The board's public origin: the wait's link. */
    publicUrl: string;
}

const unavailable = (reply: FastifyReply) =>
    reply
        .code(HTTP_SERVICE_UNAVAILABLE)
        .header('retry-after', '1')
        .send({ error: UNREADABLE, code: ERROR_CODES.UNAVAILABLE, retryable: true });

const refused = (reply: FastifyReply, message = ATTEMPT_REFUSED) =>
    bad(reply, ERROR_CODES.CONNECTION_NOT_AUTHORIZED, message, HTTP_FORBIDDEN);

/** The refusal of an attempt check that is not live: a takeover window is transient, anything else is terminal. */
const notLive = (reply: FastifyReply, check: Extract<AttemptCheck, { ok: false }>) =>
    check.pending ? leasePending(reply) : refused(reply);

/** The pair the headers name, or null for one that cannot be an attempt's (refused before the lease read). */
function pairOf(request: FastifyRequest): { jobId: string; leaseToken: string } | null {
    const jobId = (request.params as { id: string }).id;
    const leaseToken = request.headers[LEASE_TOKEN_HEADER];
    if (request.headers[JOB_ID_HEADER] !== jobId || typeof leaseToken !== 'string') return null;
    return UUID.test(jobId) && UUID.test(leaseToken) ? { jobId, leaseToken } : null;
}

/** The forge a live attempt works against, when it is a GitLab instance and the thread root's own repository. */
function gitlabForgeOfAttempt(attempt: LiveAttempt): string | null {
    const { ref, rootRef } = attempt;
    if (ref === null || rootRef === null || formatRepoRef(ref) !== formatRepoRef(rootRef)) return null;
    const forge = forgeOfRepo(ref);
    return forge !== null && gitlabHostOf(forge) !== null ? forge : null;
}

/** The starter's grant cannot serve: the thread waits (a runtime requirement) and the answer says so. */
async function waitAnswer(
    deps: ForgeCredentialDeps,
    reply: FastifyReply,
    asked: { attempt: LiveAttempt; leaseToken: string; forge: string; reason: 'missing' | 'reconnect' }
) {
    const { attempt, leaseToken, forge, reason } = asked;
    const store = (await deps.orgs.for(attempt.orgId))?.jobs;
    if (!store) return unavailable(reply);
    const held = await store.holdOnForgeGrant(attempt.jobId, leaseToken, { forge, reason });
    if (held.result === 'lost') return leasePending(reply);
    if (held.result === 'missing') return refused(reply);
    // Live again by the time the hold ran (a re-link): no wait, and the retry reads the token.
    if (held.result === 'serving') return unavailable(reply);
    const standing = reason === 'missing' ? 'missing' : 'broken';
    const path = forgeConnectPath(forge, { orgId: attempt.orgId, returnTo: `/tasks/${attempt.rootJobId}` });
    const connectUrl = `${deps.publicUrl}${path as string}`;
    const state = standing === 'broken' ? 'needs reconnecting' : 'is missing';
    return reply.code(HTTP_CONFLICT).send({
        error: `Your ${forgeLabel(forge)} connection ${state}; this task waits until you link again: ${connectUrl}`,
        code: ERROR_CODES.FORGE_GRANT_REQUIRED,
        forge,
        standing,
        waiting: true,
        connectUrl,
    });
}

/** The token, once the pair is still the live attempt's on the same claim: the refresh took time. */
async function serveToken(
    deps: ForgeCredentialDeps,
    reply: FastifyReply,
    served: {
        attempt: LiveAttempt;
        pair: { jobId: string; leaseToken: string };
        forge: string;
        token: Extract<MemberTokenResult, { ok: true }>;
    }
) {
    const { attempt, pair, forge, token } = served;
    const still = await deps.attemptOfLease(pair.jobId, pair.leaseToken);
    if (!still.ok) return notLive(reply, still);
    if (still.orgId !== attempt.orgId || still.claimSeq !== attempt.claimSeq) return refused(reply);
    const expiresAt = token.expiresAt === null ? null : new Date(token.expiresAt).toISOString();
    return reply.code(HTTP_OK).send({ forge, standing: 'live', token: token.accessToken, expiresAt });
}

const handler = (deps: ForgeCredentialDeps) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    const pair = pairOf(request);
    if (pair === null) return refused(reply);
    try {
        const attempt = await deps.attemptOfLease(pair.jobId, pair.leaseToken);
        if (!attempt.ok) return notLive(reply, attempt);
        const forge = gitlabForgeOfAttempt(attempt);
        if (forge === null) return refused(reply, NOT_GITLAB);
        const signal = AbortSignal.timeout(DEADLINE_MS);
        const token = await deps.memberGrants.accessToken(attempt.orgId, attempt.executionUserId, forge, { signal });
        if (token.ok) return await serveToken(deps, reply, { attempt, pair, forge, token });
        const { outcome } = token;
        if (outcome.outcome !== 'integration_required') return unavailable(reply);
        const reason = outcome.reason === 'missing' ? 'missing' : 'reconnect';
        return await waitAnswer(deps, reply, { attempt, leaseToken: pair.leaseToken, forge, reason });
    } catch (err) {
        // Not logged with its text: a remote body may be in it. A throw confirmed nothing; the runner asks again.
        request.log.warn({ jobId: pair.jobId, kind: (err as { name?: string }).name }, 'gitlab credential: no answer');
        return unavailable(reply);
    }
};

export const forgeCredentialRoutes =
    (deps: ForgeCredentialDeps): FastifyPluginAsync =>
    async (app) => {
        app.post('/api/jobs/:id/credentials/gitlab', { bodyLimit: BODY_LIMIT }, handler(deps));
    };
