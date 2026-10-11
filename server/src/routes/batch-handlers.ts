import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BATCH_CREATE, BATCH_DRAFT, BATCH_START, type BatchIdempotency } from '../db/batch-store.js';
import type { OrgRegistry } from '../orgs.js';
import { launchChecks } from './batch-launch.js';
import {
    batchIdOf,
    contextOf,
    envelopeOf,
    loadBatch,
    PLAN_FIELD,
    planOf,
    refuseWrite,
    startedConflict,
    VERSION_FIELD,
    versionOf,
    type Context,
} from './batch-http.js';
import { guard } from './helpers.js';
import { guardKeyed, IDEMPOTENCY_REPLAYED_HEADER, idempotencyOf } from './job-idempotency.js';
import { HTTP_CONFLICT, HTTP_CREATED, HTTP_NOT_FOUND, HTTP_OK } from './job-limits.js';

/** One handler per batch route (docs/batches.md); `batches.ts` registers them. */

/** The operations a stub refuses, as `reason` — each replaced by the issue that implements it. */
export const BATCH_OPERATION_WAIT = 'wait';
export const BATCH_OPERATION_RETRY = 'retry';
export const BATCH_OPERATION_CANCEL = 'cancel';
export const BATCH_OPERATION_ACCEPT = 'accept';

const unsupported = (reply: FastifyReply, operation: string) =>
    reply.code(HTTP_CONFLICT).send({
        error: `Batch ${operation} is not available yet`,
        code: ERROR_CODES.BATCH_UNSUPPORTED,
        reason: operation,
    });

export async function handleCreate(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    const fields = envelopeOf(request, reply, [PLAN_FIELD]);
    if (!fields) return reply;
    const plan = planOf(reply, fields[PLAN_FIELD]);
    if (!plan) return reply;
    const idempotency = idempotencyOf(request, reply, BATCH_CREATE, { plan });
    if (!idempotency.ok) return reply;

    const created = await guardKeyed(
        reply,
        (e) => request.log.error({ err: e }, 'batch create failed'),
        () => ctx.store.create(plan, ctx.createdBy, idempotency.value)
    );
    if (!created.ok) return reply;
    if (created.value.replayed) reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    return reply.code(HTTP_CREATED).send({ id: created.value.id, status: BATCH_DRAFT, version: created.value.version });
}

export async function handleList(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    const batches = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'batch list failed'),
        () => ctx.store.list()
    );
    if (!batches.ok) return reply;
    return reply.code(HTTP_OK).send({ batches: batches.value });
}

export async function handleGet(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    const record = await loadBatch(ctx, request, reply);
    if (!record) return reply;
    // `waitFor` is the long-poll #579 implements; until then it is refused, not ignored.
    if ((request.query as { waitFor?: unknown }).waitFor !== undefined) {
        return unsupported(reply, BATCH_OPERATION_WAIT);
    }
    return reply.code(HTTP_OK).send(record);
}

export async function handleReplace(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    const fields = envelopeOf(request, reply, [VERSION_FIELD, PLAN_FIELD]);
    if (!fields) return reply;
    const version = versionOf(reply, fields[VERSION_FIELD]);
    if (version === null) return reply;
    const plan = planOf(reply, fields[PLAN_FIELD]);
    if (!plan) return reply;
    const id = batchIdOf(request, reply);
    if (id === null) return reply;

    const written = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'batch replace failed'),
        () => ctx.store.replace(id, version, plan)
    );
    if (!written.ok) return reply;
    if (written.value.result !== 'ok') return refuseWrite(reply, written.value);
    return reply.code(HTTP_OK).send({ id, status: BATCH_DRAFT, version: written.value.version });
}

export async function handleValidate(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    if (!envelopeOf(request, reply, [])) return reply;
    const record = await loadBatch(ctx, request, reply);
    if (!record) return reply;
    if (record.status !== BATCH_DRAFT) return startedConflict(reply);
    const resolved = await launchChecks(ctx, request, reply, record);
    if (!resolved) return reply;
    return reply.code(HTTP_OK).send({ valid: true, version: record.version, plan: resolved });
}

/**
 * A start the key already ran answers before any launch check — those read GitHub and the draft,
 * and the batch they would check is started. True once the replay has been answered (or refused).
 */
async function answeredAsReplay(
    ctx: Context,
    request: FastifyRequest,
    reply: FastifyReply,
    asked: { id: string; idempotency: BatchIdempotency }
): Promise<boolean> {
    const replayed = await guardKeyed(
        reply,
        (e) => request.log.error({ err: e }, 'batch start replay failed'),
        () => ctx.store.replayOfStart(ctx.createdBy, asked.idempotency)
    );
    if (!replayed.ok) return true;
    if (replayed.value !== asked.id) return false;
    const record = await loadBatch(ctx, request, reply);
    if (record) {
        reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
        reply.code(HTTP_OK).send(record);
    }
    return true;
}

export async function handleStart(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    const fields = envelopeOf(request, reply, [VERSION_FIELD]);
    if (!fields) return reply;
    const version = versionOf(reply, fields[VERSION_FIELD]);
    if (version === null) return reply;
    const id = batchIdOf(request, reply);
    if (id === null) return reply;
    const keyed = idempotencyOf(request, reply, BATCH_START, { id, version });
    if (!keyed.ok) return reply;
    const idempotency = keyed.value;
    if (idempotency && (await answeredAsReplay(ctx, request, reply, { id, idempotency }))) return reply;

    const record = await loadBatch(ctx, request, reply);
    if (!record) return reply;
    if (record.status !== BATCH_DRAFT) return startedConflict(reply);
    if (record.version !== version) return refuseWrite(reply, { result: 'stale', version: record.version });
    const resolved = await launchChecks(ctx, request, reply, record);
    if (!resolved) return reply;

    const started = await guardKeyed(
        reply,
        (e) => request.log.error({ err: e }, 'batch start failed'),
        () => ctx.store.start({ id, version, plan: resolved, startedBy: ctx.createdBy, idempotency })
    );
    if (!started.ok) return reply;
    if (started.value.result !== 'ok') return refuseWrite(reply, started.value);
    const frozen = await loadBatch(ctx, request, reply);
    if (!frozen) return reply;
    if (started.value.replayed) reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    return reply.code(HTTP_OK).send(frozen);
}

/** The routes whose behavior later issues own: auth, org and existence, then the one refusal. */
export function handleUnsupported(orgs: OrgRegistry, operation: string, task: boolean) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        const ctx = await contextOf(orgs, request, reply);
        if (!ctx) return reply;
        const record = await loadBatch(ctx, request, reply);
        if (!record) return reply;
        const { key } = request.params as { key?: string };
        if (task && !record.tasks.some((candidate) => candidate.key === key)) {
            return reply.code(HTTP_NOT_FOUND).send({ error: 'No such task', code: ERROR_CODES.NOT_FOUND });
        }
        return unsupported(reply, operation);
    };
}
