import { createHash } from 'node:crypto';
import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ConnectionRefusedError } from '../../db/connection-bindings.js';
import { AttachmentRefusedError } from '../../db/jobs/job-store-attachments.js';
import { canonical, IdempotencyKeyReusedError } from '../../db/jobs/job-store-idempotency.js';
import type { IdempotentOperation } from '../../db/jobs/job-store-idempotency.js';
import { bad, guard } from '../helpers.js';
import { HTTP_CONFLICT, HTTP_CREATED, HTTP_FORBIDDEN, HTTP_PAYLOAD_TOO_LARGE } from './job-limits.js';

/**
 * The request side of durable mutation idempotency (issue #589; docs/jobs.md): the key header,
 * its validation, the canonical request fingerprint, and the answer a replay gets. The store owns
 * the scope (org, caller, operation) and the retention.
 */

/** The request header a client names its logical attempt with. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Set on the answer to a repeated request: the row already existed, nothing new was made. */
export const IDEMPOTENCY_REPLAYED_HEADER = 'idempotency-replayed';

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * The request's idempotency input, or undefined when it carries no key (the mutation is then not
 * replayable, exactly as before). `request` is what the mutation asks for — everything the route
 * would act on, the target id included — never anything about the caller, which is scope.
 * `ok: false` once a malformed key has been refused on `reply`.
 */
export function idempotencyOf<Operation extends string = IdempotentOperation>(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: Operation,
    asked: unknown
): { ok: true; value: { operation: Operation; key: string; fingerprint: string } | undefined } | { ok: false } {
    const raw = request.headers[IDEMPOTENCY_KEY_HEADER];
    if (raw === undefined) return { ok: true, value: undefined };
    if (typeof raw !== 'string' || !KEY_PATTERN.test(raw)) {
        bad(
            reply,
            ERROR_CODES.BAD_IDEMPOTENCY_KEY,
            'Idempotency-Key must be 8 to 128 characters of letters, digits, ".", "_", ":" or "-"'
        );
        return { ok: false };
    }
    const fingerprint = createHash('sha256')
        .update(canonical([operation, asked]))
        .digest('hex');
    return { ok: true, value: { operation, key: raw, fingerprint } };
}

/** The create's idempotency input: every body field the create acts on, as the client spelled it. */
export function createIdempotencyOf(request: FastifyRequest, reply: FastifyReply, fields: Record<string, unknown>) {
    const { command, repo, executor, executorScope, skills, workflow, workflowParams, connections, attachments } =
        fields;
    return idempotencyOf(request, reply, 'create', {
        command,
        repo,
        executor,
        executorScope,
        skills,
        workflow,
        workflowParams,
        connections,
        attachments,
    });
}

/**
 * `guard` for a keyed mutation: a store failure answers 503 as usual, and a key already used for
 * a different request answers 409 here — either way `ok: false` means the reply has been sent.
 */
export async function guardKeyed<T>(
    reply: FastifyReply,
    log: (e: Error) => void,
    run: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false }> {
    const result = await guard(reply, log, async () => {
        try {
            return { value: await run() };
        } catch (error) {
            if (error instanceof IdempotencyKeyReusedError) return null;
            if (error instanceof ConnectionRefusedError || error instanceof AttachmentRefusedError) return error;
            throw error;
        }
    });
    if (!result.ok) return { ok: false };
    if (result.value instanceof ConnectionRefusedError) {
        await refuseConnections(reply, result.value);
        return { ok: false };
    }
    if (result.value instanceof AttachmentRefusedError) {
        await refuseAttachments(reply, result.value);
        return { ok: false };
    }
    if (result.value === null) {
        await reply.code(HTTP_CONFLICT).send({
            error: 'This Idempotency-Key was already used for a different request',
            code: ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
        });
        return { ok: false };
    }
    return { ok: true, value: result.value.value };
}

/** The store refused the `connections` a create or follow-up named: the reply is sent. */
async function refuseConnections(reply: FastifyReply, refusal: ConnectionRefusedError) {
    if (refusal.reason === 'duplicate') {
        return bad(reply, ERROR_CODES.BAD_CONNECTION, 'connections must not repeat an id');
    }
    return bad(
        reply,
        ERROR_CODES.CONNECTION_NOT_AUTHORIZED,
        'A connection does not exist or is not available to you. Pick one from GET /api/connections.',
        HTTP_FORBIDDEN
    );
}

/** The store refused the `attachments` a create or follow-up named: the reply is sent. */
async function refuseAttachments(reply: FastifyReply, refusal: AttachmentRefusedError) {
    switch (refusal.reason) {
        case 'not-authorized':
            return bad(
                reply,
                ERROR_CODES.ATTACHMENT_NOT_AUTHORIZED,
                'An attachment does not exist, is not yours or is no longer available. Upload it again.',
                HTTP_FORBIDDEN
            );
        case 'too-large':
            return bad(
                reply,
                ERROR_CODES.ATTACHMENT_TOO_LARGE,
                'The attachments together exceed the request limit',
                HTTP_PAYLOAD_TOO_LARGE
            );
        case 'too-many':
        case 'duplicate':
            return bad(reply, ERROR_CODES.BAD_ATTACHMENT, `attachments refused: ${refusal.reason}`);
    }
}

/** The 201 a create-shaped mutation answers; a replay is the same body, marked. */
export function sendQueued(reply: FastifyReply, created: { id: string; replayed?: boolean }) {
    if (created.replayed) reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    return reply.code(HTTP_CREATED).send({ id: created.id, status: 'queued' });
}
