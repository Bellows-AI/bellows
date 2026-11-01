import { CONTENT_TYPE_HEADER, ERROR_CODES, OCTET_STREAM_CONTENT_TYPE } from '@factory-ai/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AttachmentGoneError, AttachmentIntegrityError } from '../../attachments/attachment-store.js';
import { UUID } from '../../identifiers.js';
import type { JobReadStore } from '../../db/jobs/job-store-reads.js';
import type { OrgRegistry } from '../../orgs.js';
import { orgOf } from '../../auth/plugin.js';
import { bad, body, guard } from '../helpers.js';
import { resolveJobRoute } from '../route-guards.js';
import { CONTROL_BODY_LIMIT, HTTP_NOT_FOUND, HTTP_OK, HTTP_UNAVAILABLE, leaseLost, notFoundJob } from './job-limits.js';

/**
 * The runner's read of a task's input file: a POST authorized by the job's live lease (`leaseToken` in the body, like
 * the restore reads), answered only for a file in the set that job carries now. Nothing is cached from the claim: the
 * lease, the job's state and the set are read on every call, so a removed thread or a lost lease reads nothing. The
 * member-facing `GET /api/attachments/:id/content` is a different route with a different credential.
 */

const HTTP_GONE = 410;
const HTTP_UNPROCESSABLE = 422;
const SHA256_HEADER = 'x-content-sha256';

const notFound = (reply: FastifyReply) =>
    bad(reply, ERROR_CODES.ATTACHMENT_NOT_FOUND, 'No such attachment', HTTP_NOT_FOUND);

async function handleAttachmentContent(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobReadStore>(orgs, request, reply);
    if (!route) return reply;
    const { attachmentId } = request.params as { attachmentId: string };
    const { leaseToken } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    if (!UUID.test(attachmentId)) return notFound(reply);
    const set = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'attachment set read failed'),
        () => route.store.attachmentSet(route.id, leaseToken)
    );
    if (!set.ok) return reply;
    if (set.value.result === 'missing') return notFoundJob(reply);
    if (set.value.result === 'lost') return leaseLost(reply);
    if (!set.value.attachments.some((file) => file.id === attachmentId)) return notFound(reply);
    const attachments = (await orgs.for(orgOf(request)))?.attachments;
    if (!attachments) {
        return bad(reply, ERROR_CODES.ATTACHMENTS_UNAVAILABLE, 'No attachment storage is configured', HTTP_UNAVAILABLE);
    }
    const read = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'attachment content read failed'),
        async () => {
            try {
                return await attachments.readBound(attachmentId);
            } catch (e) {
                if (e instanceof AttachmentGoneError || e instanceof AttachmentIntegrityError) return e;
                throw e;
            }
        }
    );
    if (!read.ok) return reply;
    const found = read.value;
    if (found instanceof AttachmentGoneError) {
        return bad(reply, ERROR_CODES.ATTACHMENT_GONE, 'The stored file is gone', HTTP_GONE);
    }
    if (found instanceof AttachmentIntegrityError) {
        return bad(
            reply,
            ERROR_CODES.ARTIFACT_CORRUPT,
            'The stored file fails its recorded sha256',
            HTTP_UNPROCESSABLE
        );
    }
    if (!found) return notFound(reply);
    return reply
        .code(HTTP_OK)
        .header(CONTENT_TYPE_HEADER, OCTET_STREAM_CONTENT_TYPE)
        .header(SHA256_HEADER, found.meta.sha256)
        .send(Buffer.from(found.body));
}

/** Registers the worker content route; `jobRoutes` calls it once. */
export function registerAttachmentContentRoute(app: FastifyInstance, orgs: OrgRegistry) {
    app.post('/api/jobs/:id/attachments/:attachmentId/content', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
        handleAttachmentContent(orgs, request, reply)
    );
}
