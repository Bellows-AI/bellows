import {
    ATTACHMENT_FORMATS,
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
import type { UploadCapabilityStore } from '../attachments/upload-capability-store.js';
import type { OrgRegistry } from '../orgs.js';
import { gate, receiveFile, storing, unavailable } from './attachment-ingest.js';
import { registerUploadRoutes } from './attachment-uploads.js';
import { bad } from './helpers.js';
import { IDEMPOTENCY_REPLAYED_HEADER, idempotencyOf } from './jobs/job-idempotency.js';

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_BODY_LIMIT = 4096;
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

const notFound = (reply: FastifyReply) =>
    bad(reply, ERROR_CODES.ATTACHMENT_NOT_FOUND, 'No such attachment', HTTP_NOT_FOUND);

const idOf = (request: FastifyRequest): string | null => {
    const { id } = request.params as { id?: string };
    return typeof id === 'string' && UUID.test(id) ? id : null;
};

async function handleUpload(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await gate(orgs, request, reply);
    if (!ctx) return reply;
    const file = await receiveFile(request, reply);
    if (!file) return reply;
    // The key's alphabet and length are checked here; the store's own fingerprint (sha256, size, name) decides a replay.
    const keyed = idempotencyOf(request, reply, 'attachment-upload', {});
    if (!keyed.ok) return reply;
    const stored = await storing(request.log, reply, () =>
        ctx.store.upload({
            uploaderId: ctx.uploaderId,
            name: file.name,
            mediaType: file.mediaType,
            bytes: file.bytes,
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
    const found = await storing(request.log, reply, () => ctx.store.meta(id, ctx.uploaderId));
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
    const found = await storing(request.log, reply, () => ctx.store.read(id, ctx.uploaderId));
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
    const outcome = await storing(request.log, reply, () => ctx.store.remove(id, ctx.uploaderId));
    if (outcome === undefined) return reply;
    return outcome === 'deleted' ? reply.code(HTTP_NO_CONTENT).send() : notFound(reply);
}

export const attachmentRoutes =
    ({
        orgs,
        maxInFlight = DEFAULT_MAX_IN_FLIGHT_UPLOADS,
        uploads,
        origin = null,
        requireBinding = true,
    }: {
        orgs: OrgRegistry;
        maxInFlight?: number | undefined;
        /** The upload capabilities (BEL-248); with it the upload-request routes and the capability PUT exist. */
        uploads?: UploadCapabilityStore | undefined;
        /** The board's public origin, which an upload URL handed to a client is rooted at; null where it has none. */
        origin?: string | null | undefined;
        /** Refuse a mint whose caller carries no credential to bind; false only for AUTH_MODE=none. */
        requireBinding?: boolean | undefined;
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
            if (uploads) registerUploadRoutes(scope, { orgs, uploads, origin, requireBinding, admit, log: app.log });
        });
    };
