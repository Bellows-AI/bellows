import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerOf } from '../../auth/plugin.js';
import { BINDABLE_PROVIDERS } from '../../db/connection-bindings.js';
import type { JobActionStore } from '../../db/jobs/job-store-actions.js';
import type { JobWorkerStore } from '../../db/jobs/job-store-worker.js';
import { UUID } from '../../identifiers.js';
import type { OrgRegistry } from '../../orgs.js';
import { bad, body, guard } from '../helpers.js';
import { resolveJobRoute } from '../route-guards.js';
import { HTTP_CONFLICT, HTTP_OK, leaseLost, notFoundJob } from './job-limits.js';

/** The runtime connection requirement: the runner's ask and the owner's dismissal. */

// The running attempt asks for a connection its task needs: lease-fenced like every worker write. The
// answer is the store's verdict; `waiting` is what makes the driver end the run and hand it back.
export async function handleRequirement(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobWorkerStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const { leaseToken, provider } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    if (typeof provider !== 'string' || !BINDABLE_PROVIDERS.includes(provider)) {
        return bad(reply, ERROR_CODES.BAD_CONNECTION, `provider must be one of: ${BINDABLE_PROVIDERS.join(', ')}`);
    }

    const asked = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job connection requirement failed'),
        () => store.requireConnection(id, leaseToken, provider)
    );
    if (!asked.ok) return reply;
    if (asked.value.result !== 'ok') return asked.value.result === 'missing' ? notFoundJob(reply) : leaseLost(reply);
    return reply.code(HTTP_OK).send({ answer: asked.value.answer });
}

// the owner declines a provider the thread asked for. The store decides who owns the thread (anyone else is
// a 404) and whether a requirement is still open (409).
export async function handleDismissRequirement(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobActionStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;
    const userId = callerOf(request)?.user.id ?? null;
    if (userId === null) return notFoundJob(reply);

    const { provider } = request.params as { provider: string };
    if (!BINDABLE_PROVIDERS.includes(provider)) {
        return bad(reply, ERROR_CODES.BAD_CONNECTION, `provider must be one of: ${BINDABLE_PROVIDERS.join(', ')}`);
    }

    const dismissed = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job requirement dismiss failed'),
        () => store.dismissRequirement(id, provider, userId)
    );
    if (!dismissed.ok) return reply;
    if (dismissed.value.ok) return reply.code(HTTP_OK).send({});
    if (dismissed.value.reason === 'missing') return notFoundJob(reply);
    return reply
        .code(HTTP_CONFLICT)
        .send({ error: 'No requirement is open for that provider', code: ERROR_CODES.NO_OPEN_REQUIREMENT });
}
