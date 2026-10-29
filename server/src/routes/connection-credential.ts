import { ERROR_CODES, type IntegrationOutcome } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { JOB_ID_HEADER, LEASE_TOKEN_HEADER } from '../auth/plugin.js';
import type { AttemptCheck, AttemptOfLease, LiveAttempt } from '../db/attempt-of-lease.js';
import { UUID } from '../identifiers.js';
import type { ResolveResult } from '../integrations/credential-resolver.js';
import type { IntegrationRuntime } from '../integrations/integration-recovery.js';
import { contextOfExecution } from '../integrations/trusted-context.js';

/**
 * `POST /api/jobs/:id/credentials/connections/:connectionId` (docs/connections.md): a running attempt's
 * short-lived token for one managed connection its thread root is bound to. The attempt pair is the only
 * credential the route accepts (`CONNECTOR_ROUTES` in auth/plugin.ts); the resolver is asked as the root's
 * stable execution user, for the root's own binding of the named connection. Nothing in the request chooses a
 * scope, a resource or a destination. The attempt is checked before the resolve and again after it, so a stop,
 * settle, reclaim or disconnect during a refresh withholds the token. The token is in the answer and nowhere
 * else: no log line, no error text, `Cache-Control: no-store`. Every refusal is a closed outcome, never a
 * provider's words.
 */

export interface ConnectionCredentialDeps {
    attemptOfLease: AttemptOfLease;
    integrations: Pick<IntegrationRuntime, 'resolverOf'>;
    /** The one absolute bound over the lease check, the resolve and the recheck. */
    deadlineMs?: number;
}

export const BROKER_DEADLINE_MS = 20_000;

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVICE_UNAVAILABLE = 503;
const MS_PER_SECOND = 1000;
/** The request carries nothing; the pair is in the headers. */
const BODY_LIMIT = 1024;

/** One sentence for every refusal of the attempt: which check failed is not the caller's to learn. */
const ATTEMPT_REFUSED =
    'This attempt may not use this connection: it is no longer running, or its task is no longer authorized. Do not retry.';
const NOT_PERMITTED = 'This connection may not be used by this task. Do not retry.';
const REQUIRED = 'This task needs this connection connected or reconnected by its owner. Do not retry.';
const UNREADABLE = 'The connection could not be read just now. Retry shortly.';

interface Params {
    id: string;
    connectionId: string;
}

const unavailable = (reply: FastifyReply, extra: Record<string, unknown> = {}) =>
    reply
        .code(HTTP_SERVICE_UNAVAILABLE)
        .header('retry-after', '1')
        .send({ error: UNREADABLE, code: ERROR_CODES.UNAVAILABLE, retryable: true, ...extra });

const refused = (reply: FastifyReply, message: string, extra: Record<string, unknown> = {}) =>
    reply.code(HTTP_FORBIDDEN).send({ error: message, code: ERROR_CODES.CONNECTION_NOT_AUTHORIZED, ...extra });

/** The closed HTTP answer of a resolver outcome. */
function answerOutcome(reply: FastifyReply, outcome: IntegrationOutcome) {
    switch (outcome.outcome) {
        case 'integration_required':
            return reply.code(HTTP_CONFLICT).send({ error: REQUIRED, code: ERROR_CODES.INTEGRATION_REQUIRED, outcome });
        case 'forbidden':
            return refused(reply, NOT_PERMITTED, { outcome });
        case 'unavailable':
            return unavailable(reply, { outcome });
        case 'rate_limited': {
            const seconds = Math.max(1, Math.ceil((outcome.retryAfterMs ?? 0) / MS_PER_SECOND));
            return reply
                .code(HTTP_TOO_MANY_REQUESTS)
                .header('retry-after', String(seconds))
                .send({ error: UNREADABLE, code: ERROR_CODES.UNAVAILABLE, retryable: true, outcome });
        }
        default:
            // An outcome whose effect is unknown is no verdict: the caller may ask again.
            return unavailable(reply);
    }
}

interface Pair {
    jobId: string;
    leaseToken: string;
    connectionId: string;
}

/** The request's pair and named connection, or the reason it is no request for this route. */
function pairOf(request: FastifyRequest<{ Params: Params }>): Pair | 'unauthenticated' | 'malformed' {
    const { id: jobId, connectionId } = request.params;
    const leaseToken = request.headers[LEASE_TOKEN_HEADER];
    if (request.headers[JOB_ID_HEADER] !== jobId || typeof leaseToken !== 'string') return 'unauthenticated';
    // A malformed id is no attempt and no connection, refused before the database's uuid cast can throw.
    if (!UUID.test(jobId) || !UUID.test(leaseToken) || !UUID.test(connectionId)) return 'malformed';
    return { jobId, leaseToken, connectionId };
}

/** The same attempt the answer was resolved for: a rotated lease, a moved thread or a changed user is another. */
const sameAttempt = (before: LiveAttempt, after: AttemptCheck): boolean =>
    after.ok &&
    after.orgId === before.orgId &&
    after.rootJobId === before.rootJobId &&
    after.executionUserId === before.executionUserId;

/** A signal that aborts when the client goes away before the answer is written; `dispose` ends the listener. */
function untilClosed(reply: FastifyReply): { signal: AbortSignal; dispose: () => void } {
    const closed = new AbortController();
    const onClose = () => {
        if (!reply.raw.writableEnded) closed.abort();
    };
    reply.raw.once('close', onClose);
    return { signal: closed.signal, dispose: () => reply.raw.removeListener('close', onClose) };
}

export function connectionCredentialRoutes({
    attemptOfLease,
    integrations,
    deadlineMs = BROKER_DEADLINE_MS,
}: ConnectionCredentialDeps): FastifyPluginAsync {
    /** The lease check; a throw confirmed nothing and is `null`, never a refusal. */
    const check = async (pair: Pair): Promise<AttemptCheck | null> => {
        try {
            return await attemptOfLease(pair.jobId, pair.leaseToken);
        } catch {
            return null;
        }
    };

    /** Resolves as the attempt's execution user, bounded by `signal`; a throw is `null`, never quoted. */
    const resolve = async (attempt: LiveAttempt, pair: Pair, signal: AbortSignal): Promise<ResolveResult | null> => {
        const context = contextOfExecution({
            orgId: attempt.orgId,
            executionUserId: attempt.executionUserId,
            jobId: pair.jobId,
            attempt: attempt.claimSeq,
        });
        const request = { rootJobId: attempt.rootJobId, connectionId: pair.connectionId };
        try {
            return await integrations.resolverOf(attempt.orgId).resolveCredential(context, request, { signal });
        } catch {
            return null;
        }
    };

    /** The attempt resolves a token; it leaves only if the same attempt still stands afterwards. */
    const spend = async (
        request: FastifyRequest,
        reply: FastifyReply,
        attempt: LiveAttempt,
        call: { pair: Pair; signal: AbortSignal }
    ) => {
        const { pair, signal } = call;
        const resolved = await resolve(attempt, pair, signal);
        if (resolved === null) {
            // Not logged beyond the job id: the thrown text may carry a provider's or a store's words.
            request.log.warn({ jobId: pair.jobId }, 'connection credential resolve failed');
            return unavailable(reply);
        }
        if (!resolved.ok) return answerOutcome(reply, resolved.outcome);

        // The exchange took time: the attempt must still be the live one before the token leaves.
        const still = await check(pair);
        if (still === null) return unavailable(reply);
        if (!sameAttempt(attempt, still)) return refused(reply, ATTEMPT_REFUSED);
        const { credential, resource, lifecycle } = resolved;
        return reply.send({
            token: credential.accessToken,
            expiresAt: credential.expiresAt === null ? null : new Date(credential.expiresAt).toISOString(),
            scopes: [...credential.authority.scopes],
            resource,
            refreshable: lifecycle.refreshable,
            revocable: lifecycle.revocable,
        });
    };

    const handle = async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => {
        reply.header('cache-control', 'no-store');
        const pair = pairOf(request);
        if (pair === 'unauthenticated') {
            return reply
                .code(HTTP_UNAUTHORIZED)
                .send({ error: 'Job id and lease token required', code: ERROR_CODES.UNAUTHENTICATED });
        }
        if (pair === 'malformed') return refused(reply, ATTEMPT_REFUSED);

        const attempt = await check(pair);
        if (attempt === null) {
            request.log.warn({ jobId: pair.jobId }, 'connection credential lease check failed');
            return unavailable(reply);
        }
        if (!attempt.ok) return refused(reply, ATTEMPT_REFUSED);
        // The deadline bounds the resolve; a client that went away stops it too.
        const closed = untilClosed(reply);
        try {
            return await spend(request, reply, attempt, {
                pair,
                signal: AbortSignal.any([closed.signal, AbortSignal.timeout(deadlineMs)]),
            });
        } finally {
            closed.dispose();
        }
    };

    return async (app) => {
        app.post<{ Params: Params }>(
            '/api/jobs/:id/credentials/connections/:connectionId',
            { bodyLimit: BODY_LIMIT },
            handle
        );
    };
}
