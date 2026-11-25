import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JobConclusionStore } from '../../db/jobs/job-store-conclusions.js';
import type { OrgRegistry } from '../../orgs.js';
import { bad, guard } from '../helpers.js';
import { resolveLeasedRoute } from '../route-guards.js';
import { refuseOffTaskPublication } from './change-request-check.js';
import { validateVerdictBody } from './job-field-validation.js';
import { conclusionConflict, HTTP_OK, LEASE_SECONDS_MAX, leaseLost, leaseSeconds, notFoundJob } from './job-limits.js';

// The attempt's final envelope, staged under its lease before its verdict and its teardown (issue
// #821): the very body complete takes, parsed by the same validation so the staged fingerprint is
// the receipt's, with the lease renewed by `leaseSeconds`. The board commits it should the lease
// expire before the complete lands; a different one under the lease is a 409 of its own.
export async function handleConclusion(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveLeasedRoute<keyof JobConclusionStore | 'prWriteContext'>(orgs, request, reply);
    if (!route) return reply;
    const { store, id, fields, leaseToken } = route;
    const lease = leaseSeconds(fields.leaseSeconds);
    if (lease === null) {
        return bad(reply, ERROR_CODES.BAD_LEASE, `leaseSeconds must be an integer 1..${LEASE_SECONDS_MAX}`);
    }
    const parsed = validateVerdictBody(fields);
    if (!parsed.ok) return bad(reply, parsed.code, parsed.message);
    if (
        await refuseOffTaskPublication({ request, reply, store, id, leaseToken, publication: parsed.value.publication })
    ) {
        return reply;
    }

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job conclusion failed'),
        () => store.stageConclusion(id, leaseToken, parsed.value, lease)
    );
    if (!result.ok) return reply;
    if (result.value.result === 'missing') return notFoundJob(reply);
    if (result.value.result === 'lost') return leaseLost(reply);
    if (result.value.result === 'conflict') return conclusionConflict(reply);
    return reply.code(HTTP_OK).send({ id, status: parsed.value.status });
}
