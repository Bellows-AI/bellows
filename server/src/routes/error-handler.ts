import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { AttachmentUnavailableError } from '../attachments/attachment-store.js';
import { EnvSecretError } from '../db/env-secrets.js';
import { SkillUnavailableError } from '../db/skill-store.js';
import { DeadlineError } from '../secrets/secret-call.js';

const HTTP_INTERNAL = 500;
const HTTP_UNAVAILABLE = 503;
const HTTP_FIRST_SERVER_ERROR = 500;

/** What a caller sees. The thrown text never leaves the process: it names SQL, hosts and secrets. */
const UNAVAILABLE_MESSAGE = 'The service is temporarily unavailable. Try again shortly.';
const INTERNAL_MESSAGE = 'Internal error. Quote the request id when reporting it.';

const CONNECTION_ERRNOS = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'CONNECT_TIMEOUT',
]);
/** Connection exception (08), insufficient resources (53), operator intervention (57P01-03), and the two retryable aborts. */
const UNAVAILABLE_SQLSTATE = /^(08|53|57P0[1-3]$|40001$|40P01$)/;
const MAX_CAUSE_DEPTH = 4;

const codeOf = (e: unknown): string | undefined => {
    const code = (e as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
};

const causesOf = (e: unknown): unknown[] => {
    const found: unknown[] = [];
    let current: unknown = e;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === 'object'; depth++) {
        found.push(current);
        const { errors, cause } = current as { errors?: unknown; cause?: unknown };
        if (Array.isArray(errors)) found.push(...errors);
        current = cause;
    }
    return found;
};

/**
 * A dependency outage (the database or a store behind it cannot be reached) is `unavailable`; anything
 * else is a bug and `internal`. The list is deliberately narrow: a misclassified outage answers 500,
 * which the driver retries like a 503, so no task is lost either way (driver/src/board/board-retry.ts).
 */
export function classifyFailure(e: unknown): 'unavailable' | 'internal' {
    for (const cause of causesOf(e)) {
        const code = codeOf(cause);
        if (
            code &&
            (CONNECTION_ERRNOS.has(code) || code.startsWith('CONNECTION_') || UNAVAILABLE_SQLSTATE.test(code))
        ) {
            return 'unavailable';
        }
        if (
            cause instanceof AttachmentUnavailableError ||
            cause instanceof SkillUnavailableError ||
            cause instanceof EnvSecretError ||
            cause instanceof DeadlineError
        ) {
            return 'unavailable';
        }
    }
    return 'internal';
}

/** The generic body: 503 for an outage, 500 with the request id for the rest. The caller logs the full error. */
export function sendFailure(reply: FastifyReply, request: FastifyRequest, e: unknown) {
    if (classifyFailure(e) === 'unavailable') {
        return reply.code(HTTP_UNAVAILABLE).send({ error: UNAVAILABLE_MESSAGE, code: ERROR_CODES.UNAVAILABLE });
    }
    return reply
        .code(HTTP_INTERNAL)
        .send({ error: INTERNAL_MESSAGE, code: ERROR_CODES.INTERNAL, requestId: request.id });
}

/** The app-wide handler: Fastify's own client errors (validation, body limits) keep their shape; the rest go to `sendFailure`. */
export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
    const status = error.statusCode;
    if (status !== undefined && status < HTTP_FIRST_SERVER_ERROR) return reply.send(error);
    request.log.error({ err: error }, 'request failed');
    return sendFailure(reply, request, error);
}
