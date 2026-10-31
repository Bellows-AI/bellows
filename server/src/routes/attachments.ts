import {
    ATTACHMENT_FORMATS,
    ATTACHMENT_NAME_HEADER,
    CONTENT_TYPE_HEADER,
    type AttachmentLimits,
    ERROR_CODES,
    MAX_FILE_BYTES,
    MAX_FILES_PER_REQUEST,
    MAX_IMAGE_PIXELS,
    MAX_IMAGE_SIDE,
    MAX_REQUEST_BYTES,
    OCTET_STREAM_CONTENT_TYPE,
} from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import {
    AttachmentGoneError,
    AttachmentIntegrityError,
    AttachmentUnavailableError,
} from '../attachments/attachment-store.js';
import { normalizeAttachmentName } from '../attachments/name.js';
import { sniffAttachment } from '../attachments/sniff.js';
import { IdempotencyKeyReusedError } from '../db/jobs/job-store-idempotency.js';
import type { OrgRegistry } from '../orgs.js';
import { bad } from './helpers.js';
import { IDEMPOTENCY_REPLAYED_HEADER, idempotencyOf } from './jobs/job-idempotency.js';

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;
const HTTP_UNAVAILABLE = 503;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_BODY_LIMIT = 4096;
const MEDIA_TYPE_HEADER = 'x-attachment-media-type';
const RETRY_AFTER_SECONDS = '5';
/** One process buffers at most this many uploads at once (N x MAX_FILE_BYTES of memory); the rest are shed with 503. */
export const DEFAULT_MAX_IN_FLIGHT_UPLOADS = 4;
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const LIMITS: AttachmentLimits = {
    maxFilesPerRequest: MAX_FILES_PER_REQUEST,
    maxFileBytes: MAX_FILE_BYTES,
    maxRequestBytes: MAX_REQUEST_BYTES,
    maxImageSide: MAX_IMAGE_SIDE,
    maxImagePixels: MAX_IMAGE_PIXELS,
    formats: ATTACHMENT_FORMATS,
};

const unavailable = (reply: FastifyReply, message: string) =>
    bad(reply, ERROR_CODES.ATTACHMENTS_UNAVAILABLE, message, HTTP_UNAVAILABLE);

const notFound = (reply: FastifyReply) =>
    bad(reply, ERROR_CODES.ATTACHMENT_NOT_FOUND, 'No such attachment', HTTP_NOT_FOUND);

/** The org's store and the signed-in member, or null once the refusal has been sent. */
async function gate(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = (await orgs.for(orgOf(request)))?.attachments;
    if (!store) {
        unavailable(reply, 'No attachment storage is configured for this organization');
        return null;
    }
    const caller = callerOf(request);
    if (!caller) {
        bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
        return null;
    }
    return { store, uploaderId: caller.user.id };
}

/** A storage failure is a 503 naming nothing about the object; the row stays for the sweep. */
async function storing<T>(request: FastifyRequest, reply: FastifyReply, run: () => Promise<T>): Promise<T | undefined> {
    try {
        return await run();
    } catch (error) {
        if (error instanceof IdempotencyKeyReusedError) {
            await bad(reply, ERROR_CODES.IDEMPOTENCY_KEY_REUSED, error.message, HTTP_CONFLICT);
            return undefined;
        }
        if (error instanceof AttachmentGoneError) {
            await bad(reply, ERROR_CODES.ATTACHMENT_GONE, 'The upload expired; upload the file again', HTTP_GONE);
            return undefined;
        }
        request.log.error({ err: error });
        const known = error instanceof AttachmentUnavailableError || error instanceof AttachmentIntegrityError;
        await unavailable(reply, known ? error.message : 'Attachment storage failed');
        return undefined;
    }
}

const idOf = (request: FastifyRequest): string | null => {
    const { id } = request.params as { id?: string };
    return typeof id === 'string' && UUID.test(id) ? id : null;
};

const REASON_STATUS = {
    unsupported: HTTP_UNSUPPORTED_MEDIA_TYPE,
    mismatch: HTTP_UNSUPPORTED_MEDIA_TYPE,
    malformed: HTTP_BAD_REQUEST,
    'image-too-large': HTTP_PAYLOAD_TOO_LARGE,
} as const;

const REASON_CODE = {
    unsupported: ERROR_CODES.ATTACHMENT_UNSUPPORTED,
    mismatch: ERROR_CODES.ATTACHMENT_UNSUPPORTED,
    malformed: ERROR_CODES.BAD_ATTACHMENT,
    'image-too-large': ERROR_CODES.ATTACHMENT_TOO_LARGE,
} as const;

const REASON_TEXT = {
    unsupported: 'This file type is not accepted. See GET /api/attachments/limits for the formats.',
    mismatch: 'The declared media type does not match the file',
    malformed: 'The file is empty or its header is unreadable',
    'image-too-large': 'The image dimensions exceed the limits. See GET /api/attachments/limits.',
} as const;

/** The display name from its percent-encoded header, or a reason it is unusable. */
function nameOf(request: FastifyRequest): { name: string } | { error: string } {
    const raw = request.headers[ATTACHMENT_NAME_HEADER];
    if (typeof raw !== 'string')
        return { error: `${ATTACHMENT_NAME_HEADER} (the percent-encoded file name) is required` };
    let decoded: string;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        return { error: `${ATTACHMENT_NAME_HEADER} is not valid percent-encoding` };
    }
    const normal = normalizeAttachmentName(decoded);
    return normal.ok ? { name: normal.name } : { error: 'The file name is empty, too long or has control characters' };
}

async function handleUpload(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await gate(orgs, request, reply);
    if (!ctx) return reply;
    const named = nameOf(request);
    if ('error' in named) return bad(reply, ERROR_CODES.BAD_ATTACHMENT, named.error);
    if (!Buffer.isBuffer(request.body)) {
        return bad(
            reply,
            ERROR_CODES.BAD_ATTACHMENT,
            `The body must be the raw file, sent as ${OCTET_STREAM_CONTENT_TYPE}`
        );
    }
    const bytes: Uint8Array = request.body;
    const declared = request.headers[MEDIA_TYPE_HEADER];
    const sniffed = sniffAttachment(bytes, {
        name: named.name,
        ...(typeof declared === 'string' ? { mediaType: declared } : {}),
    });
    if (!sniffed.ok) {
        return bad(reply, REASON_CODE[sniffed.reason], REASON_TEXT[sniffed.reason], REASON_STATUS[sniffed.reason]);
    }
    // The key's alphabet and length are checked here; the store's own fingerprint (sha256, size, name) decides a replay.
    const keyed = idempotencyOf(request, reply, 'attachment-upload', {});
    if (!keyed.ok) return reply;
    const stored = await storing(request, reply, () =>
        ctx.store.upload({
            uploaderId: ctx.uploaderId,
            name: named.name,
            mediaType: sniffed.mediaType,
            bytes,
            idempotencyKey: keyed.value?.key,
        })
    );
    if (!stored) return reply;
    if (stored.replayed) reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    return reply.code(HTTP_CREATED).send(stored.meta);
}

async function handleMeta(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await gate(orgs, request, reply);
    if (!ctx) return reply;
    const id = idOf(request);
    if (!id) return notFound(reply);
    const found = await storing(request, reply, () => ctx.store.meta(id, ctx.uploaderId));
    if (found === undefined) return reply;
    return found ? reply.code(HTTP_OK).send(found) : notFound(reply);
}

/** RFC 5987 `ext-value`: percent-encoding that also escapes the characters `attr-char` excludes. */
const HEX_RADIX = 16;
const rfc5987 = (name: string): string =>
    encodeURIComponent(name).replace(/['()*]/gu, (c) => `%${c.charCodeAt(0).toString(HEX_RADIX).toUpperCase()}`);

async function handleContent(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await gate(orgs, request, reply);
    if (!ctx) return reply;
    const id = idOf(request);
    if (!id) return notFound(reply);
    const found = await storing(request, reply, () => ctx.store.read(id, ctx.uploaderId));
    if (found === undefined) return reply;
    if (!found) return notFound(reply);
    const { disposition } = request.query as { disposition?: string };
    const inline = disposition === 'inline' && INLINE_TYPES.has(found.meta.mediaType);
    return reply
        .code(HTTP_OK)
        .header(CONTENT_TYPE_HEADER, found.meta.mediaType)
        .header(
            'content-disposition',
            `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${rfc5987(found.meta.name)}`
        )
        .send(Buffer.from(found.body));
}

/** User bytes are never rendered by the board: no script, no frame, no network, whatever the type. */
const sandbox = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('content-security-policy', "sandbox; default-src 'none'");
};

async function handleDelete(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await gate(orgs, request, reply);
    if (!ctx) return reply;
    const id = idOf(request);
    if (!id) return notFound(reply);
    const outcome = await storing(request, reply, () => ctx.store.remove(id, ctx.uploaderId));
    if (outcome === undefined) return reply;
    return outcome === 'deleted' ? reply.code(HTTP_NO_CONTENT).send() : notFound(reply);
}

export const attachmentRoutes =
    ({
        orgs,
        maxInFlight = DEFAULT_MAX_IN_FLIGHT_UPLOADS,
    }: {
        orgs: OrgRegistry;
        maxInFlight?: number | undefined;
    }): FastifyPluginAsync =>
    async (app) => {
        // A child scope, so the raw-bytes parser reaches only these routes.
        await app.register(async (scope) => {
            scope.addContentTypeParser(OCTET_STREAM_CONTENT_TYPE, { parseAs: 'buffer' }, (_request, raw, done) =>
                done(null, raw)
            );
            let inFlight = 0;
            // Counted before the body is read, so N slow uploads cannot hold N x MAX_FILE_BYTES in memory.
            const admit = async (_request: FastifyRequest, reply: FastifyReply) => {
                if (inFlight >= maxInFlight) {
                    reply.header('retry-after', RETRY_AFTER_SECONDS);
                    return unavailable(reply, 'Too many uploads in progress; retry shortly');
                }
                inFlight += 1;
                let released = false;
                const release = () => {
                    if (!released) inFlight -= 1;
                    released = true;
                };
                reply.raw.once('finish', release);
                reply.raw.once('close', release);
            };
            scope.post('/api/attachments', { bodyLimit: MAX_FILE_BYTES, onRequest: admit }, (request, reply) =>
                handleUpload(orgs, request, reply)
            );
            scope.get('/api/attachments/limits', { bodyLimit: CONTROL_BODY_LIMIT }, (_request, reply) =>
                reply.code(HTTP_OK).send(LIMITS)
            );
            scope.get('/api/attachments/:id', (request, reply) => handleMeta(orgs, request, reply));
            // The app's own onSend hook stamps the dashboard's policy on every reply; a route hook runs after it.
            scope.get('/api/attachments/:id/content', { onSend: sandbox }, (request, reply) =>
                handleContent(orgs, request, reply)
            );
            scope.delete('/api/attachments/:id', (request, reply) => handleDelete(orgs, request, reply));
        });
    };
