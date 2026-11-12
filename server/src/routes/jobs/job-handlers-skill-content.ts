import { CONTENT_TYPE_HEADER, ERROR_CODES, OCTET_STREAM_CONTENT_TYPE } from '@factory-ai/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SkillGoneError, SkillIntegrityError } from '../../db/skill-store.js';
import { UUID } from '../../identifiers.js';
import type { JobReadStore } from '../../db/jobs/job-store-reads.js';
import type { OrgRegistry } from '../../orgs.js';
import { orgOf } from '../../auth/plugin.js';
import { bad, body, guard } from '../helpers.js';
import { resolveJobRoute } from '../route-guards.js';
import { CONTROL_BODY_LIMIT, HTTP_NOT_FOUND, HTTP_OK, HTTP_UNAVAILABLE, leaseLost, notFoundJob } from './job-limits.js';

/**
 * The runner's read of a pinned org or workspace skill bundle: a POST authorized by the job's live lease
 * (`leaseToken` in the body, like the attachment content route), answered only for a version in the pin that row holds
 * now. Nothing is cached from the claim: the lease and the pin are read on every call. Not being in the pin is a 404;
 * a pinned version the store cannot produce is never a 404, so it cannot read as "not pinned": `410` when the version
 * or its object is definitively absent, `422` when the bytes fail the recorded sha256, `503` when the read did not
 * confirm. A lost object is not a retention case: the sweep keeps every version any job row pins.
 */

const HTTP_GONE = 410;
const HTTP_UNPROCESSABLE = 422;
const SHA256_HEADER = 'x-content-sha256';

const notFound = (reply: FastifyReply) =>
    bad(reply, ERROR_CODES.SKILL_NOT_FOUND, 'No such pinned skill', HTTP_NOT_FOUND);

const gone = (reply: FastifyReply) => bad(reply, ERROR_CODES.SKILL_GONE, 'The pinned skill version is gone', HTTP_GONE);

async function handleSkillContent(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobReadStore>(orgs, request, reply);
    if (!route) return reply;
    const { versionId } = request.params as { versionId: string };
    const { leaseToken } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    if (!UUID.test(versionId)) return notFound(reply);
    const held = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'skill pin read failed'),
        () => route.store.skillPin(route.id, leaseToken)
    );
    if (!held.ok) return reply;
    if (held.value.result === 'missing') return notFoundJob(reply);
    if (held.value.result === 'lost') return leaseLost(reply);
    if (!held.value.pin.some((entry) => entry.versionId === versionId)) return notFound(reply);
    const skills = (await orgs.for(orgOf(request)))?.skills;
    if (!skills) {
        return bad(reply, ERROR_CODES.UNAVAILABLE, 'No skill storage is configured', HTTP_UNAVAILABLE);
    }
    const read = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'skill content read failed'),
        async () => {
            try {
                return await skills.readVersion(versionId, 'any');
            } catch (e) {
                if (e instanceof SkillGoneError || e instanceof SkillIntegrityError) return e;
                throw e;
            }
        }
    );
    if (!read.ok) return reply;
    const found = read.value;
    if (found instanceof SkillIntegrityError) {
        return bad(
            reply,
            ERROR_CODES.ARTIFACT_CORRUPT,
            'The stored bundle fails its recorded sha256',
            HTTP_UNPROCESSABLE
        );
    }
    if (found instanceof SkillGoneError || found === null) return gone(reply);
    return reply
        .code(HTTP_OK)
        .header(CONTENT_TYPE_HEADER, OCTET_STREAM_CONTENT_TYPE)
        .header(SHA256_HEADER, found.sha256)
        .send(Buffer.from(found.body));
}

/** Registers the worker skill content route; `jobRoutes` calls it once. */
export function registerSkillContentRoute(app: FastifyInstance, orgs: OrgRegistry) {
    app.post('/api/jobs/:id/skills/:versionId/content', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
        handleSkillContent(orgs, request, reply)
    );
}
