import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { UUID } from '../../identifiers.js';
import {
    GATE_RUN_OUTCOMES,
    GATE_RUN_SOURCES,
    type GateRunOutcome,
    type GateRunSource,
    type GateRunStore,
    type GateRunWrite,
} from '../../db/jobs/job-store-gate-runs.js';
import type { OrgRegistry } from '../../orgs.js';
import { bad, body, guard } from '../helpers.js';
import { CONTROL_BODY_LIMIT, GATE_NAME_LIMIT, HTTP_CONFLICT, HTTP_OK, leaseLost, notFoundJob } from './job-limits.js';
import { resolveJobRoute } from '../route-guards.js';

/** HMAC-SHA256 hex: the driver's gate identity. Anything else is not a digest and is never stored. */
const IDENTITY = /^[0-9a-f]{64}$/;
/** A tree fingerprint is `<head sha>:<sha256>`; far under this. */
const TREE_LIMIT = 256;
const TIMESTAMP_LIMIT = 40;

const runClaimSeqOf = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;

const nullableString = (value: unknown, limit: number): value is string | null =>
    value === null || (typeof value === 'string' && value.length <= limit);

const nullableTimestamp = (value: unknown): value is string | null =>
    value === null ||
    (typeof value === 'string' && value.length <= TIMESTAMP_LIMIT && !Number.isNaN(Date.parse(value)));

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

/** Who a row is: its run, execution, gate, identity and scope. */
function validateIdentity(
    fields: Record<string, unknown>
): Checked<Pick<GateRunWrite, 'runClaimSeq' | 'executionId' | 'gate' | 'identity' | 'filtered' | 'source'>> {
    const runClaimSeq = runClaimSeqOf(fields.runClaimSeq);
    if (runClaimSeq === null) return { ok: false, message: 'runClaimSeq must be a positive integer' };
    const { executionId, gate, identity, filtered, source } = fields;
    if (typeof executionId !== 'string' || !UUID.test(executionId)) {
        return { ok: false, message: 'executionId must be a uuid' };
    }
    if (typeof gate !== 'string' || !gate.trim() || gate.length > GATE_NAME_LIMIT) {
        return { ok: false, message: `gate must be a name of at most ${GATE_NAME_LIMIT} characters` };
    }
    if (typeof identity !== 'string' || !IDENTITY.test(identity)) {
        return { ok: false, message: 'identity must be a 64-character hex digest' };
    }
    if (typeof filtered !== 'boolean') return { ok: false, message: 'filtered must be a boolean' };
    if (!GATE_RUN_SOURCES.includes(source as GateRunSource)) {
        return { ok: false, message: `source must be one of ${GATE_RUN_SOURCES.join(', ')}` };
    }
    return {
        ok: true,
        value: { runClaimSeq, executionId, gate: gate.trim(), identity, filtered, source: source as GateRunSource },
    };
}

/** What a row measured: its outcome and exit code, the trees around the run, the guard and the times. */
function validateMeasure(
    fields: Record<string, unknown>
): Checked<Omit<GateRunWrite, 'runClaimSeq' | 'executionId' | 'gate' | 'identity' | 'filtered' | 'source'>> {
    const { outcome, exitCode, treeBefore, treeAfter, mutatedSince, startedAt, finishedAt } = fields;
    if (!GATE_RUN_OUTCOMES.includes(outcome as GateRunOutcome)) {
        return { ok: false, message: `outcome must be one of ${GATE_RUN_OUTCOMES.join(', ')}` };
    }
    if (exitCode !== null && !Number.isSafeInteger(exitCode)) {
        return { ok: false, message: 'exitCode must be an integer or null' };
    }
    if (!nullableString(treeBefore, TREE_LIMIT) || !nullableString(treeAfter, TREE_LIMIT)) {
        return {
            ok: false,
            message: `treeBefore and treeAfter must be strings of at most ${TREE_LIMIT} characters or null`,
        };
    }
    if (mutatedSince !== null && typeof mutatedSince !== 'boolean') {
        return { ok: false, message: 'mutatedSince must be a boolean or null' };
    }
    if (!nullableTimestamp(startedAt) || !nullableTimestamp(finishedAt)) {
        return { ok: false, message: 'startedAt and finishedAt must be timestamps or null' };
    }
    return {
        ok: true,
        value: {
            outcome: outcome as GateRunOutcome,
            exitCode: exitCode as number | null,
            treeBefore,
            treeAfter,
            mutatedSince,
            startedAt,
            finishedAt,
        },
    };
}

/** The row a gate-run write names, field by field, or the reason it is refused. */
function validateWrite(fields: Record<string, unknown>): Checked<GateRunWrite> {
    const who = validateIdentity(fields);
    if (!who.ok) return who;
    const measured = validateMeasure(fields);
    if (!measured.ok) return measured;
    return { ok: true, value: { ...who.value, ...measured.value } };
}

/**
 * Records one gate execution under the attempt's lease (issue #983): the running row before the gate
 * starts and the terminal row after. `lost` and `conflict` are both a 409 the writer treats as "not
 * recorded" — and for the running row, as a refusal to start the gate.
 */
export async function handleGateRun(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof GateRunStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const fields = body(request.body);
    const { leaseToken } = fields;
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    const checked = validateWrite(fields);
    if (!checked.ok) return bad(reply, ERROR_CODES.BAD_BODY, checked.message);

    const written = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'gate run write failed'),
        () => store.writeGateRun(id, leaseToken, checked.value)
    );
    if (!written.ok) return reply;
    if (written.value.result === 'missing') return notFoundJob(reply);
    if (written.value.result === 'lost') return leaseLost(reply);
    if (written.value.result === 'conflict') {
        return bad(reply, ERROR_CODES.GATE_RUN_CONFLICT, 'runClaimSeq is not a claim of this job', HTTP_CONFLICT);
    }
    return reply.code(HTTP_OK).send({ id, executionId: checked.value.executionId });
}

/** The latest row per gate of the run claim `runClaimSeq` started, under the caller's lease. */
export async function handleGateRuns(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof GateRunStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const fields = body(request.body);
    const { leaseToken } = fields;
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    const runClaimSeq = runClaimSeqOf(fields.runClaimSeq);
    if (runClaimSeq === null) return bad(reply, ERROR_CODES.BAD_BODY, 'runClaimSeq must be a positive integer');

    const read = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'gate run read failed'),
        () => store.readGateRuns(id, leaseToken, runClaimSeq)
    );
    if (!read.ok) return reply;
    if (read.value.result !== 'ok') return read.value.result === 'missing' ? notFoundJob(reply) : leaseLost(reply);
    return reply.code(HTTP_OK).send({ runs: read.value.runs });
}

/** The two worker routes (087, issue #983), under the attempt's lease. */
export function gateRunRoutes(app: FastifyInstance, orgs: OrgRegistry): void {
    app.post('/api/jobs/:id/gate-run', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
        handleGateRun(orgs, request, reply)
    );
    app.post('/api/jobs/:id/gate-runs', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
        handleGateRuns(orgs, request, reply)
    );
}
