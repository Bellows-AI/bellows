import { ERROR_CODES, validateBatchPlan, type BatchPlan } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../../auth/plugin.js';
import { UUID } from '../../config.js';
import type { BatchRecord, BatchStore, BatchWriteRefusal } from '../../db/batches/batch-store.js';
import type { OrgRegistry, OrgRuntime } from '../../orgs.js';
import { bad, body, guard } from '../helpers.js';
import { HTTP_CONFLICT, HTTP_FORBIDDEN, HTTP_NOT_FOUND, HTTP_UNAVAILABLE } from '../jobs/job-limits.js';

/** What every batch handler shares: the caller's org, the request envelope, the 404 and the refusals. */

export const HTTP_BAD_REQUEST = 400;

export const VERSION_FIELD = 'version';
export const PLAN_FIELD = 'plan';

/** Body fields the board decides; naming one is refused by name rather than as an unknown field. */
const BOARD_DECIDED_FIELDS = ['org', 'orgId', 'org_id', 'status', 'outcome', 'outcomes'];

export interface Context {
    runtime: OrgRuntime;
    store: BatchStore;
    createdBy: string | null;
}

export const notFoundBatch = (reply: FastifyReply) =>
    reply.code(HTTP_NOT_FOUND).send({ error: 'No such batch', code: ERROR_CODES.NOT_FOUND });

export const startedConflict = (reply: FastifyReply) =>
    bad(reply, ERROR_CODES.BATCH_STARTED, 'This batch is started; its plan is frozen', HTTP_CONFLICT);

/** The caller's org's store, or null once a refusal has been sent. */
export async function contextOf(
    orgs: OrgRegistry,
    request: FastifyRequest,
    reply: FastifyReply
): Promise<Context | null> {
    // The hook already walls these paths; this is the route's own statement that no batch write
    // has a non-person behind it, for the day a path joins an allowlist by mistake.
    if (request.auth && request.auth.kind !== 'user') {
        await reply
            .code(HTTP_FORBIDDEN)
            .send({ error: 'Batches need a signed-in member', code: ERROR_CODES.FORBIDDEN });
        return null;
    }
    const runtime = await orgs.for(orgOf(request));
    if (!runtime?.batches) {
        await bad(reply, ERROR_CODES.BATCHES_UNAVAILABLE, 'Batches need the board database', HTTP_UNAVAILABLE);
        return null;
    }
    return { runtime, store: runtime.batches, createdBy: callerOf(request)?.user.id ?? null };
}

/** The body, with only `allowed` keys: the rest are refused 400, the board-decided ones by name. */
export function envelopeOf(request: FastifyRequest, reply: FastifyReply, allowed: readonly string[]) {
    const fields = body(request.body);
    for (const field of Object.keys(fields)) {
        if (allowed.includes(field)) continue;
        const message = BOARD_DECIDED_FIELDS.includes(field)
            ? `"${field}" is decided by the board, not the request`
            : `unknown field "${field}"`;
        bad(reply, ERROR_CODES.BAD_BODY, message);
        return null;
    }
    return fields;
}

/** A well-formed `version` field, or null once refused. */
export function versionOf(reply: FastifyReply, raw: unknown): number | null {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
        bad(reply, ERROR_CODES.BAD_BODY, `${VERSION_FIELD} must be the draft's version as last read`);
        return null;
    }
    return raw;
}

/** The validated plan, or null once `400 BAD_BATCH` with its path-addressed issues has been sent. */
export function planOf(reply: FastifyReply, raw: unknown): BatchPlan | null {
    const result = validateBatchPlan(raw);
    if (result.ok) return result.plan;
    reply.code(HTTP_BAD_REQUEST).send({
        error: 'The batch plan is not valid',
        code: ERROR_CODES.BAD_BATCH,
        issues: result.issues,
    });
    return null;
}

export function refuseWrite(reply: FastifyReply, refusal: BatchWriteRefusal) {
    if (refusal.result === 'missing') return notFoundBatch(reply);
    if (refusal.result === 'started') return startedConflict(reply);
    return reply.code(HTTP_CONFLICT).send({
        error: `The draft is at version ${refusal.version}; read it again before writing`,
        code: ERROR_CODES.BATCH_STALE,
        version: refusal.version,
    });
}

/** The id the route's URL names, or null (after a 404) when it cannot be a batch id. */
export function batchIdOf(request: FastifyRequest, reply: FastifyReply): string | null {
    const { id } = request.params as { id: string };
    if (UUID.test(id)) return id;
    notFoundBatch(reply);
    return null;
}

/** One batch of the caller's org, or null once a 404 (or a failed read) has been sent. */
export async function loadBatch(
    ctx: Context,
    request: FastifyRequest,
    reply: FastifyReply
): Promise<BatchRecord | null> {
    const id = batchIdOf(request, reply);
    if (id === null) return null;
    const found = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'batch read failed'),
        () => ctx.store.get(id)
    );
    if (!found.ok) return null;
    if (!found.value) {
        notFoundBatch(reply);
        return null;
    }
    return found.value;
}
