import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { JOB_ID_HEADER, LEASE_TOKEN_HEADER } from '../auth/plugin.js';
import type { AttemptOfLease, PairMatches } from '../db/attempt-of-lease.js';
import {
    type OperationReceipts,
    RECEIPT_STATUSES,
    type ReceiptResult,
    type ReceiptStatus,
} from '../db/operation-receipts.js';
import { UUID } from '../identifiers.js';
import { bad, body as jsonBody } from './helpers.js';

/**
 * `POST /api/jobs/:id/operations` and `PUT /api/jobs/:id/operations/:receiptId` (docs/connections.md): the
 * durable receipt of a runner-side write. The attempt pair is the only credential (`CONNECTOR_ROUTES` in
 * auth/plugin.ts). Beginning needs the LIVE attempt and a live binding of the named connection on its root; a
 * move needs only a pair that names the attempt row, so a 201 seen just after a Stop is still recorded. A
 * throwing check is 503, never a refusal. Nothing here carries a credential or a provider's words.
 */

export interface OperationReceiptRoutesDeps {
    attemptOfLease: AttemptOfLease;
    pairMatches: PairMatches;
    receipts: OperationReceipts;
}

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;
const BODY_LIMIT = 4096;
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const COMMENT_ID = /^\d{1,20}$/;
const BEGIN_KEYS = ['connectionId', 'provider', 'operation', 'key', 'fingerprint'] as const;
const MOVE_KEYS = ['from', 'to', 'result'] as const;

const ATTEMPT_REFUSED =
    'This attempt may not record this operation: it is no longer running, or its task is no longer authorized. Do not retry.';
const NOT_PERMITTED = 'This connection may not be used by this task. Do not retry.';
const UNREADABLE = 'The operation could not be read just now. Retry shortly.';
const KEY_REUSED = 'This operation key was already used for a different operation. Choose another key.';

interface BeginBody {
    connectionId: string;
    provider: string;
    operation: string;
    key: string;
    fingerprint: string;
}

interface MoveBody {
    from: ReceiptStatus[];
    to: ReceiptStatus;
    result?: ReceiptResult;
}

const onlyKeys = (fields: Record<string, unknown>, allowed: readonly string[]) =>
    Object.keys(fields).every((key) => allowed.includes(key));

const isString = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);

const isStatus = (value: unknown): value is ReceiptStatus => RECEIPT_STATUSES.includes(value as ReceiptStatus);

function parseBegin(raw: unknown): BeginBody | null {
    const f = jsonBody(raw);
    if (!onlyKeys(f, BEGIN_KEYS)) return null;
    const { connectionId, provider, operation, key, fingerprint } = f;
    if (
        !isString(connectionId, UUID) ||
        !isString(provider, NAME) ||
        !isString(operation, NAME) ||
        !isString(key, KEY) ||
        !isString(fingerprint, FINGERPRINT)
    ) {
        return null;
    }
    return { connectionId, provider, operation, key, fingerprint };
}

function parseMove(raw: unknown): MoveBody | null {
    const f = jsonBody(raw);
    if (!onlyKeys(f, MOVE_KEYS)) return null;
    const { from, to, result } = f;
    if (!Array.isArray(from) || from.length === 0 || !from.every(isStatus) || !isStatus(to)) return null;
    if (result === undefined) return { from, to };
    const r = jsonBody(result);
    if (!onlyKeys(r, ['commentId']) || !isString(r.commentId, COMMENT_ID)) return null;
    return { from, to, result: { commentId: r.commentId } };
}

const unavailable = (reply: FastifyReply) =>
    reply
        .code(HTTP_SERVICE_UNAVAILABLE)
        .header('retry-after', '1')
        .send({ error: UNREADABLE, code: ERROR_CODES.UNAVAILABLE, retryable: true });

const refused = (reply: FastifyReply, message: string) =>
    bad(reply, ERROR_CODES.CONNECTION_NOT_AUTHORIZED, message, HTTP_FORBIDDEN);

/** The request's pair, or why it is no request for this route. */
function pairOf(request: FastifyRequest): { jobId: string; leaseToken: string } | 'unauthenticated' | 'malformed' {
    const { id: jobId } = request.params as { id: string };
    const leaseToken = request.headers[LEASE_TOKEN_HEADER];
    if (request.headers[JOB_ID_HEADER] !== jobId || typeof leaseToken !== 'string') return 'unauthenticated';
    if (!UUID.test(jobId) || !UUID.test(leaseToken)) return 'malformed';
    return { jobId, leaseToken };
}

/** The request's pair, or the reply that refused it (already sent). */
function pairOrRefuse(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const pair = pairOf(request);
    if (pair === 'unauthenticated') {
        return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Job id and lease token required', HTTP_UNAUTHORIZED);
    }
    if (pair === 'malformed') return refused(reply, ATTEMPT_REFUSED);
    return pair;
}

export function operationReceiptRoutes({
    attemptOfLease,
    pairMatches,
    receipts,
}: OperationReceiptRoutesDeps): FastifyPluginAsync {
    const begin = async (request: FastifyRequest, reply: FastifyReply) => {
        const pair = pairOrRefuse(request, reply);
        if ('statusCode' in pair) return pair;
        const parsed = parseBegin(request.body);
        if (!parsed) return bad(reply, ERROR_CODES.BAD_BODY, 'The operation request is not valid');
        try {
            const attempt = await attemptOfLease(pair.jobId, pair.leaseToken);
            if (!attempt.ok) return refused(reply, ATTEMPT_REFUSED);
            if (!(await receipts.isBound(attempt.orgId, attempt.rootJobId, parsed.connectionId))) {
                return refused(reply, NOT_PERMITTED);
            }
            const made = await receipts.begin({
                orgId: attempt.orgId,
                rootJobId: attempt.rootJobId,
                jobId: pair.jobId,
                ...parsed,
            });
            if (made === 'key-reused') return bad(reply, ERROR_CODES.OPERATION_KEY_REUSED, KEY_REUSED, HTTP_CONFLICT);
            return reply.send(made);
        } catch {
            // Not logged beyond the job id: the thrown text may carry a store's words.
            request.log.warn({ jobId: pair.jobId }, 'operation receipt begin failed');
            return unavailable(reply);
        }
    };

    const move = async (request: FastifyRequest, reply: FastifyReply) => {
        const pair = pairOrRefuse(request, reply);
        if ('statusCode' in pair) return pair;
        const { receiptId } = request.params as { receiptId: string };
        if (!UUID.test(receiptId)) return bad(reply, ERROR_CODES.BAD_BODY, 'The receipt id is not valid');
        const parsed = parseMove(request.body);
        if (!parsed) return bad(reply, ERROR_CODES.BAD_BODY, 'The operation move is not valid');
        try {
            // No liveness: a Stop or a settle must not stop the runner recording a write that already happened.
            const matched = await pairMatches(pair.jobId, pair.leaseToken);
            if (!matched.ok) return refused(reply, ATTEMPT_REFUSED);
            const moved = await receipts.transition({
                orgId: matched.orgId,
                jobId: pair.jobId,
                receiptId,
                from: parsed.from,
                to: parsed.to,
                ...(parsed.result ? { result: parsed.result } : {}),
            });
            if (moved) return reply.send({ receipt: moved });
            const current = await receipts.read(matched.orgId, pair.jobId, receiptId);
            return reply.code(HTTP_CONFLICT).send({
                error: 'The operation is not in the expected state',
                code: ERROR_CODES.OPERATION_CONFLICT,
                receipt: current,
            });
        } catch {
            request.log.warn({ jobId: pair.jobId }, 'operation receipt move failed');
            return unavailable(reply);
        }
    };

    return async (app) => {
        app.post('/api/jobs/:id/operations', { bodyLimit: BODY_LIMIT }, begin);
        app.put('/api/jobs/:id/operations/:receiptId', { bodyLimit: BODY_LIMIT }, move);
    };
}
