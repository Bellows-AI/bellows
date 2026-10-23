import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { UUID } from '../config.js';
import type { PhaseCheckpointPhase } from '../db/job-store-phase-checkpoints.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, body, guard } from './helpers.js';
import {
    CONCLUSION_BODY_LIMIT,
    CONTROL_BODY_LIMIT,
    HTTP_CONFLICT,
    HTTP_OK,
    leaseLost,
    notFoundJob,
} from './job-limits.js';
import { resolveJobRoute } from './route-guards.js';

const PHASES: readonly string[] = ['setup', 'gates', 'post', 'publish'] satisfies PhaseCheckpointPhase[];

const runClaimSeqOf = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;

/**
 * Records a post-run phase's outcome under the attempt's lease (issue #829): the driver that adopts
 * or takes the run over resumes after the last phase checkpointed here. `lost` and `conflict` are
 * both a 409 the writer treats as "not recorded".
 */
export async function handlePhaseCheckpoint(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const fields = body(request.body);
    const { leaseToken, phase, tree, result } = fields;
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    const runClaimSeq = runClaimSeqOf(fields.runClaimSeq);
    if (runClaimSeq === null) return bad(reply, ERROR_CODES.BAD_BODY, 'runClaimSeq must be a positive integer');
    if (typeof phase !== 'string' || !PHASES.includes(phase)) {
        return bad(reply, ERROR_CODES.BAD_BODY, `phase must be one of ${PHASES.join(', ')}`);
    }
    if (tree !== null && typeof tree !== 'string')
        return bad(reply, ERROR_CODES.BAD_BODY, 'tree must be a string or null');
    if (typeof result !== 'object' || Array.isArray(result)) {
        return bad(reply, ERROR_CODES.BAD_BODY, 'result must be an object or null');
    }

    const written = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'phase checkpoint write failed'),
        () =>
            store.writePhaseCheckpoint(id, leaseToken, {
                runClaimSeq,
                phase: phase as PhaseCheckpointPhase,
                tree,
                result,
            })
    );
    if (!written.ok) return reply;
    if (written.value.result === 'missing') return notFoundJob(reply);
    if (written.value.result === 'lost') return leaseLost(reply);
    if (written.value.result === 'conflict') {
        return bad(
            reply,
            ERROR_CODES.PHASE_CHECKPOINT_CONFLICT,
            'runClaimSeq is not a claim of this job',
            HTTP_CONFLICT
        );
    }
    return reply.code(HTTP_OK).send({ id, phase });
}

/** The checkpoints of the run claim `runClaimSeq` started, under the caller's lease. */
export async function handlePhaseCheckpoints(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
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
        (e) => request.log.error({ err: e }, 'phase checkpoint read failed'),
        () => store.readPhaseCheckpoints(id, leaseToken, runClaimSeq)
    );
    if (!read.ok) return reply;
    if (read.value.result !== 'ok') return read.value.result === 'missing' ? notFoundJob(reply) : leaseLost(reply);
    return reply.code(HTTP_OK).send({ checkpoints: read.value.checkpoints });
}

/** The two worker routes (080, issue #829), under the attempt's lease. */
export function phaseCheckpointRoutes(app: FastifyInstance, orgs: OrgRegistry): void {
    app.post('/api/jobs/:id/phase-checkpoint', { bodyLimit: CONCLUSION_BODY_LIMIT }, (request, reply) =>
        handlePhaseCheckpoint(orgs, request, reply)
    );
    app.post('/api/jobs/:id/phase-checkpoints', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
        handlePhaseCheckpoints(orgs, request, reply)
    );
}
