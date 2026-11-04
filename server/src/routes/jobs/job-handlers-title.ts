import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf } from '../../auth/plugin.js';
import type { OrgRegistry } from '../../orgs.js';
import { bad, body, guard } from '../helpers.js';
import { resolveJobRoute } from '../route-guards.js';
import type { JobTitleStore } from '../../db/jobs/job-store-title.js';
import { adminOf } from './job-handlers-follow-up.js';
import { validateTitleField } from './job-field-validation.js';
import { CONTROL_BODY_LIMIT, HTTP_CONFLICT, HTTP_FORBIDDEN, HTTP_OK, notFoundJob } from './job-limits.js';

/**
 * The user's rename of a task (BEL-252; `PUT /api/jobs/:id/title`): compare-and-set on the revision the
 * client rendered. The author or an org admin may rename; a stale revision answers the current title so the
 * dialog can show it.
 */
export async function handleRenameTask(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobTitleStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const fields = body(request.body);
    const raw = fields.title;
    const titleResult = raw === undefined || raw === null ? validateTitleField('') : validateTitleField(raw);
    if (!titleResult.ok || titleResult.value === null) {
        return bad(reply, ERROR_CODES.BAD_TITLE, titleResult.ok ? 'title must be a string' : titleResult.message);
    }
    const revision = fields.revision;
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
        return bad(reply, ERROR_CODES.BAD_BODY, 'revision must be a non-negative integer');
    }
    // Read off the authenticated request, never off the body.
    const caller = callerOf(request)?.user.id ?? null;

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'task rename failed'),
        () => store.renameTask(id, { title: titleResult.value!, revision, caller, admin: adminOf(request) })
    );
    if (!result.ok) return reply;
    const answer = result.value;
    if (answer.ok) {
        return reply.code(HTTP_OK).send({ title: answer.title, origin: answer.origin, revision: answer.revision });
    }
    if (answer.refusal === 'stale') {
        return reply.code(HTTP_CONFLICT).send({
            error: 'The title changed since it was loaded',
            code: ERROR_CODES.TITLE_STALE,
            title: answer.title,
            origin: answer.origin,
            revision: answer.revision,
        });
    }
    if (answer.refusal === 'missing') return notFoundJob(reply);
    return reply.code(HTTP_FORBIDDEN).send({
        error: 'Only the task author or an admin can rename it',
        code: ERROR_CODES.FORBIDDEN,
    });
}

/** `PUT /api/jobs/:id/title`: person-gated like done, a short body. */
export function registerTitleRoute(app: FastifyInstance, orgs: OrgRegistry): void {
    app.put('/api/jobs/:id/title', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
        handleRenameTask(orgs, request, reply)
    );
}
