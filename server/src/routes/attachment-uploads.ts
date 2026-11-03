import { ATTACHMENT_FORMATS, ERROR_CODES, MAX_FILE_BYTES } from '@factory-ai/core';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UploadCapabilityStore, UploadGrant } from '../attachments/upload-capability-store.js';
import type { OrgRegistry } from '../orgs.js';
import { HTTP_GONE, HTTP_PAYLOAD_TOO_LARGE, gate, receiveFile, storing, unavailable } from './attachment-ingest.js';
import { bad } from './helpers.js';
import { IDEMPOTENCY_REPLAYED_HEADER } from './jobs/job-idempotency.js';

/**
 * Upload capabilities (BEL-248): a client that cannot send file bytes through MCP asks for a single-use, short-lived
 * URL, then PUTs the file there. The PUT is an OPEN route: the capability in its path is the credential, so the route
 * resolves it itself and acts as the account that minted it. The bytes then take the same path as `POST
 * /api/attachments` (`attachment-ingest.ts`), and the file is spent exactly once by the store's own idempotency key
 * `upload-<id>`: a retry of the same bytes returns the same file, other bytes are refused.
 */

const HTTP_CREATED = 201;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const CONTROL_BODY_LIMIT = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCEPTED_TYPES: readonly string[] = ATTACHMENT_FORMATS.map((format) => format.mediaType);

/** The SPA page that takes a file with a mouse (`web/src/pages/AttachmentUploadPage.tsx`); the capability rides the fragment. */
export const UPLOAD_PAGE_PATH = '/attachments/upload';
export const UPLOAD_PATH = '/api/attachments/uploads';

const MintBody = z
    .object({
        maxBytes: z.number().int().min(1).max(MAX_FILE_BYTES).optional(),
        mediaTypes: z
            .array(z.string())
            .min(1)
            .max(ACCEPTED_TYPES.length)
            .refine((types) => types.every((type) => ACCEPTED_TYPES.includes(type)), 'an unaccepted media type')
            .optional(),
    })
    .strict();

export interface UploadRouteDeps {
    orgs: OrgRegistry;
    uploads: UploadCapabilityStore;
    origin: string | null;
    /** The in-flight cap the buffered PUT shares with `POST /api/attachments`. */
    admit: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    /** The app's own logger: the PUT route is silenced, because its URL is the credential. */
    log: FastifyBaseLogger;
}

const capabilityOf = (request: FastifyRequest): string => (request.params as { capability: string }).capability;

/** The grant for a presented capability, or null once the refusal has been sent. */
async function liveGrant(deps: UploadRouteDeps, request: FastifyRequest, reply: FastifyReply) {
    let resolution: Awaited<ReturnType<UploadCapabilityStore['resolve']>>;
    try {
        resolution = await deps.uploads.resolve(capabilityOf(request));
    } catch (error) {
        deps.log.error({ err: error }, 'upload capability lookup failed');
        await unavailable(reply, 'Upload capabilities cannot be read right now; retry shortly');
        return null;
    }
    if (resolution.kind === 'expired') {
        await bad(reply, ERROR_CODES.UPLOAD_CAPABILITY_EXPIRED, 'This upload link has expired', HTTP_GONE);
        return null;
    }
    if (resolution.kind === 'unknown') {
        await bad(reply, ERROR_CODES.UPLOAD_CAPABILITY_INVALID, 'This upload link is not valid', HTTP_NOT_FOUND);
        return null;
    }
    return resolution.grant;
}

async function handleMint(deps: UploadRouteDeps, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await gate(deps.orgs, request, reply);
    if (!ctx) return reply;
    if (deps.origin === null) return unavailable(reply, 'This board has no public address to hand an upload link to');
    const body = MintBody.safeParse(request.body ?? {});
    if (!body.success) {
        return bad(reply, ERROR_CODES.BAD_ATTACHMENT, `Invalid upload request: ${body.error.issues[0]?.message ?? ''}`);
    }
    const maxBytes = body.data.maxBytes ?? MAX_FILE_BYTES;
    const mediaTypes = body.data.mediaTypes ?? ACCEPTED_TYPES;
    const minted = await storing(request.log, reply, () =>
        deps.uploads.mint({
            orgId: ctx.caller.org.id,
            userId: ctx.uploaderId,
            familyId: ctx.caller.grantFamilyId ?? null,
            maxBytes,
            mediaTypes,
        })
    );
    if (!minted) return reply;
    return reply.code(HTTP_CREATED).send({
        id: minted.id,
        state: 'open',
        expiresAt: minted.expiresAt.toISOString(),
        maxBytes,
        mediaTypes,
        attachmentId: null,
        uploadUrl: `${deps.origin}${UPLOAD_PATH}/${minted.capability}`,
        pageUrl: `${deps.origin}${UPLOAD_PAGE_PATH}#${minted.capability}`,
    });
}

async function handleStatus(deps: UploadRouteDeps, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await gate(deps.orgs, request, reply);
    if (!ctx) return reply;
    const { id } = request.params as { id?: string };
    if (typeof id !== 'string' || !UUID.test(id)) {
        return bad(reply, ERROR_CODES.ATTACHMENT_NOT_FOUND, 'No such upload request', HTTP_NOT_FOUND);
    }
    // A failed read is a 503, never a 404: only an answered query that found no row says there is none.
    const found = await storing(request.log, reply, async () => {
        const view = await deps.uploads.view(id, ctx.caller.org.id, ctx.uploaderId);
        if (!view) return null;
        const attachment = view.attachmentId ? await ctx.store.meta(view.attachmentId, ctx.uploaderId) : null;
        return { view, attachment };
    });
    if (found === undefined) return reply;
    if (found === null) return bad(reply, ERROR_CODES.ATTACHMENT_NOT_FOUND, 'No such upload request', HTTP_NOT_FOUND);
    const { view, attachment } = found;
    return reply.code(HTTP_OK).send({
        ...view,
        state: view.state === 'completed' && !attachment ? 'removed' : view.state,
        attachment,
    });
}

async function handlePut(deps: UploadRouteDeps, request: FastifyRequest, reply: FastifyReply, hold: Hold) {
    const grant = hold.get(request);
    if (!grant) return unavailable(reply, 'The upload link was not resolved');
    const file = await receiveFile(request, reply, { maxBytes: grant.maxBytes, mediaTypes: grant.mediaTypes });
    if (!file) return reply;
    // The body can take minutes: the grant is asked again so a revoke or an expiry during the transfer still counts.
    const still = await liveGrant(deps, request, reply);
    if (!still) return reply;
    const store = (await deps.orgs.for(still.orgId))?.attachments;
    if (!store) return unavailable(reply, 'No attachment storage is configured for this organization');
    const stored = await storing(
        deps.log,
        reply,
        async () => {
            const result = await store.upload({
                uploaderId: still.userId,
                name: file.name,
                mediaType: file.mediaType,
                bytes: file.bytes,
                idempotencyKey: `upload-${still.id}`,
            });
            await deps.uploads.complete(still.id, result.meta.id);
            return result;
        },
        { code: ERROR_CODES.UPLOAD_CAPABILITY_SPENT, message: 'This upload link was already used for a different file' }
    );
    if (!stored) return reply;
    if (stored.replayed) reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    return reply.code(HTTP_CREATED).send(stored.meta);
}

type Hold = WeakMap<FastifyRequest, UploadGrant>;

/** The mint, status and capability-PUT routes, in the attachment scope that owns the raw-bytes parser. */
export function registerUploadRoutes(scope: FastifyInstance, deps: UploadRouteDeps): void {
    const hold: Hold = new WeakMap();
    scope.post('/api/attachments/upload-requests', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
        handleMint(deps, request, reply)
    );
    scope.get('/api/attachments/upload-requests/:id', (request, reply) => handleStatus(deps, request, reply));
    scope.put(
        `${UPLOAD_PATH}/:capability`,
        {
            bodyLimit: MAX_FILE_BYTES,
            // The URL is the credential, so no request line, error or completion for this route reaches the log.
            logLevel: 'silent',
            onRequest: [
                deps.admit,
                // Before the body is read: an unknown, expired or revoked link and an over-long declared body cost nothing.
                async (request, reply) => {
                    const grant = await liveGrant(deps, request, reply);
                    if (!grant) return reply;
                    const declared = Number(request.headers['content-length']);
                    if (Number.isFinite(declared) && declared > grant.maxBytes) {
                        return bad(
                            reply,
                            ERROR_CODES.ATTACHMENT_TOO_LARGE,
                            `The file is larger than the ${grant.maxBytes} bytes this upload allows`,
                            HTTP_PAYLOAD_TOO_LARGE
                        );
                    }
                    hold.set(request, grant);
                },
            ],
        },
        (request, reply) => handlePut(deps, request, reply, hold)
    );
}
