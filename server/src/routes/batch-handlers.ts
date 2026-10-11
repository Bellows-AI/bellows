import { batchWaitResult, ERROR_CODES, type BatchWaitResult } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
    BATCH_CREATE,
    BATCH_DRAFT,
    BATCH_START,
    BATCH_STARTED,
    type BatchIdempotency,
    type BatchStore,
} from '../db/batch-store.js';
import type { OrgRegistry } from '../orgs.js';
import { launchChecks } from './batch-launch.js';
import {
    batchIdOf,
    contextOf,
    envelopeOf,
    loadBatch,
    notFoundBatch,
    PLAN_FIELD,
    planOf,
    refuseWrite,
    startedConflict,
    VERSION_FIELD,
    versionOf,
    type Context,
} from './batch-http.js';
import { bad, guard } from './helpers.js';
import { validateWaitQuery } from './job-field-validation.js';
import { guardKeyed, IDEMPOTENCY_REPLAYED_HEADER, idempotencyOf } from './job-idempotency.js';
import { HTTP_CONFLICT, HTTP_CREATED, HTTP_NOT_FOUND, HTTP_OK } from './job-limits.js';

/** One handler per batch route (docs/batches.md); `batches.ts` registers them. */

/** The wait's answer when the hold's deadline passed with the batch still moving. */
export const BATCH_WAIT_TIMEOUT = 'timeout';
/** How often a held wait reconciles and re-reads. */
export const BATCH_WAIT_POLL_MS = 1000;

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
    // The settle long-poll, shaped like the job's (`?waitFor=terminal&timeout=<s>`): the answer is
    // `{ result, batch }` — `terminal` (finished, or cancelled with nothing moving), `parked`
    // (nothing moves without an operator: a failed task, a gate not yet passed) or `timeout`.
    const wait = validateWaitQuery(request.query as { waitFor?: unknown; timeout?: unknown });
    if (!wait.ok) return bad(reply, wait.code, wait.message);
    if (!wait.value) return reply.code(HTTP_OK).send(record);
    if (record.status !== BATCH_STARTED) return notStartedConflict(reply);

    const held = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'batch wait failed'),
        () => holdUntilSettled(ctx.store, record.id, wait.value!.timeoutMs, () => reply.raw.destroyed)
    );
    if (!held.ok) return reply;
    const settled = await loadBatch(ctx, request, reply);
    if (!settled) return reply;
    return reply.code(HTTP_OK).send({ result: held.value, batch: settled });
}

/** Reconciles on every beat, so a batch settles for a waiter whether or not anything else is running. */
async function holdUntilSettled(
    store: BatchStore,
    id: string,
    timeoutMs: number,
    gone: () => boolean
): Promise<BatchWaitResult | typeof BATCH_WAIT_TIMEOUT> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const progress = await store.reconcile(id);
        const result = progress && batchWaitResult(progress);
        if (result) return result;
        const remaining = deadline - Date.now();
        if (remaining <= 0 || gone()) return BATCH_WAIT_TIMEOUT;
        await new Promise((resolve) => setTimeout(resolve, Math.min(BATCH_WAIT_POLL_MS, remaining)));
    }
}

/** A started batch's retry of one task: the task goes back to the scheduler, which launches it when a slot is free. */
export async function handleRetry(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    if (!envelopeOf(request, reply, [])) return reply;
    const id = batchIdOf(request, reply);
    if (id === null) return reply;
    const { key } = request.params as { key: string };

    const retried = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'batch task retry failed'),
        () => ctx.store.retry(id, key)
    );
    if (!retried.ok) return reply;
    const outcome = retried.value;
    if (outcome.result === 'missing') return notFoundBatch(reply);
    if (outcome.result === 'no_task') return notFoundTask(reply);
    if (outcome.result === 'not_started') return notStartedConflict(reply);
    if (outcome.result === 'cancelled') return cancelledConflict(reply);
    if (outcome.result === 'not_retryable') {
        return bad(
            reply,
            ERROR_CODES.BATCH_TASK_NOT_RETRYABLE,
            'Only a failed or stopped task, or one whose gate refused it, in the active stage can be retried',
            HTTP_CONFLICT
        );
    }
    return answerWithBatch(ctx, request, reply);
}

/** Fences the batch, then settles its moving tasks through the job store's stop. A repeat answers the same. */
export async function handleCancel(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    if (!envelopeOf(request, reply, [])) return reply;
    const id = batchIdOf(request, reply);
    if (id === null) return reply;

    const cancelled = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'batch cancel failed'),
        () => ctx.store.cancel(id, ctx.createdBy)
    );
    if (!cancelled.ok) return reply;
    const outcome = cancelled.value;
    if (outcome.result === 'missing') return notFoundBatch(reply);
    if (outcome.result === 'not_started') return notStartedConflict(reply);
    if (outcome.result === 'finished') {
        return bad(reply, ERROR_CODES.BATCH_FINISHED, 'This batch already finished', HTTP_CONFLICT);
    }
    return answerWithBatch(ctx, request, reply);
}

async function answerWithBatch(ctx: Context, request: FastifyRequest, reply: FastifyReply) {
    const record = await loadBatch(ctx, request, reply);
    if (!record) return reply;
    return reply.code(HTTP_OK).send(record);
}

const notFoundTask = (reply: FastifyReply) =>
    reply.code(HTTP_NOT_FOUND).send({ error: 'No such task', code: ERROR_CODES.NOT_FOUND });

const notStartedConflict = (reply: FastifyReply) =>
    bad(reply, ERROR_CODES.BATCH_NOT_STARTED, 'This batch is still a draft; start it first', HTTP_CONFLICT);

const cancelledConflict = (reply: FastifyReply) =>
    bad(reply, ERROR_CODES.BATCH_CANCELLED, 'This batch was cancelled', HTTP_CONFLICT);

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
    // Start queued nothing; dispatch is the first scheduling pass. A failure here is not the
    // start's: the batch is frozen and the periodic reconcile launches it.
    await ctx.store
        .reconcile(id)
        .catch((e: unknown) => request.log.error({ err: e }, 'batch dispatch after start failed'));
    const frozen = await loadBatch(ctx, request, reply);
    if (!frozen) return reply;
    if (started.value.replayed) reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    return reply.code(HTTP_OK).send(frozen);
}

const ACCEPT_REFUSALS = {
    not_acceptable:
        'Only a task whose plan completion is "accepted" is accepted by a person; a PR task passes on merge',
    not_ready: 'Only a task whose run succeeded can be accepted',
    settled: "The task's stage already advanced",
} as const;

/** A person's recorded acceptance of a finished `accepted`-completion task; its gate passes and the stage may advance. */
export async function handleAccept(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    if (!envelopeOf(request, reply, [])) return reply;
    const id = batchIdOf(request, reply);
    if (id === null) return reply;
    const { key } = request.params as { key: string };

    const accepted = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'batch task accept failed'),
        () => ctx.store.accept(id, key, ctx.createdBy)
    );
    if (!accepted.ok) return reply;
    const outcome = accepted.value;
    if (outcome.result === 'missing') return notFoundBatch(reply);
    if (outcome.result === 'no_task') return notFoundTask(reply);
    if (outcome.result === 'not_started') return notStartedConflict(reply);
    if (outcome.result === 'cancelled') return cancelledConflict(reply);
    if (outcome.result !== 'ok') {
        return bad(reply, ERROR_CODES.BATCH_TASK_NOT_ACCEPTABLE, ACCEPT_REFUSALS[outcome.result], HTTP_CONFLICT);
    }
    return answerWithBatch(ctx, request, reply);
}
