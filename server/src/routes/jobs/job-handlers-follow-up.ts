import { ADMIN_ROLE, ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerOf } from '../../auth/plugin.js';
import type { JobActionStore } from '../../db/jobs/job-store-actions.js';
import type { OrgRegistry } from '../../orgs.js';
import { bad, body } from '../helpers.js';
import { resolveJobRoute } from '../route-guards.js';
import { validateCommandField } from './job-field-validation.js';
import { guardKeyed, idempotencyOf, sendQueued } from './job-idempotency.js';
import { followUpRefusal } from './job-refusals.js';
import { taskRefsOf } from './job-task-refs.js';

/**
 * The role is the route's question, the org scoping the store's: an org admin may follow up, retry and control the wait
 * of a thread another member owns. A request with no caller is never an admin.
 */
export const adminOf = (request: FastifyRequest): boolean => callerOf(request)?.role === ADMIN_ROLE;

// A person's action on a finished task: queue an adjustment as a continuation of the run it just
// did. The store decides every refusal atomically with the insert, so a follow-up can never land
// on a parent that turns out to be running or done. No lease token — the task is finished, nobody
// holds it, and this is a person's action for exactly that reason. The executor is NOT taken from
// the body: the adjustment is bound to the executor that ran the task, copied from the parent at
// insert like the repo and the session.
export async function handleFollowUp(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobActionStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const fields = body(request.body);
    const commandResult = validateCommandField(fields.command);
    if (!commandResult.ok) return bad(reply, ERROR_CODES.BAD_COMMAND, commandResult.message);

    // Read off the authenticated request, never off the body — the create route's rule about
    // impersonation applies word for word here.
    const createdBy = callerOf(request)?.user.id ?? null;

    const refs = taskRefsOf(reply, fields);
    if (!refs) return reply;
    const { connectionIds, attachmentIds } = refs;

    const fingerprint = {
        id,
        command: commandResult.value,
        connections: fields.connections,
        attachments: fields.attachments,
    };
    const idempotency = idempotencyOf(request, reply, 'follow-up', fingerprint);
    if (!idempotency.ok) return reply;
    const admin = adminOf(request);

    const created = await guardKeyed(
        reply,
        (e) => request.log.error({ err: e }, 'job follow-up failed'),
        () =>
            store.createFollowUp(
                id,
                commandResult.value,
                createdBy,
                idempotency.value,
                connectionIds,
                admin,
                attachmentIds
            )
    );
    if (!created.ok) return reply;
    if (typeof created.value === 'string') return followUpRefusal(reply, created.value);
    return sendQueued(reply, created.value);
}
