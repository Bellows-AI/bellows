import { ATTACHMENT_NAME_HEADER, ERROR_CODES, OCTET_STREAM_CONTENT_TYPE } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
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

/**
 * What every route that takes an uploaded file shares: the refusals, the name and media-type headers, the size and
 * type checks over the bytes, and the mapping of a store failure. `POST /api/attachments` and the capability PUT
 * (`attachment-uploads.ts`) both end in `receiveFile` and `storing`, so there is one validation, not two.
 */

export const HTTP_BAD_REQUEST = 400;
export const HTTP_CONFLICT = 409;
export const HTTP_GONE = 410;
export const HTTP_PAYLOAD_TOO_LARGE = 413;
export const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;
export const HTTP_UNAVAILABLE = 503;
const HTTP_UNAUTHORIZED = 401;

const MEDIA_TYPE_HEADER = 'x-attachment-media-type';

export const unavailable = (reply: FastifyReply, message: string) =>
    bad(reply, ERROR_CODES.ATTACHMENTS_UNAVAILABLE, message, HTTP_UNAVAILABLE);

/** The org's store and the signed-in member, or null once the refusal has been sent. */
export async function gate(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
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
    return { store, uploaderId: caller.user.id, caller };
}

/** What a reused idempotency key means to the caller: the generic key conflict, or a spent upload capability. */
export interface ReusedKeyRefusal {
    code: string;
    message?: string;
}

/** A storage failure is a 503 naming nothing about the object; the row stays for the sweep. */
export async function storing<T>(
    log: { error(fields: object): void },
    reply: FastifyReply,
    run: () => Promise<T>,
    reused?: ReusedKeyRefusal
): Promise<T | undefined> {
    try {
        return await run();
    } catch (error) {
        if (error instanceof IdempotencyKeyReusedError) {
            await bad(
                reply,
                reused?.code ?? ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
                reused?.message ?? error.message,
                HTTP_CONFLICT
            );
            return undefined;
        }
        if (error instanceof AttachmentGoneError) {
            await bad(reply, ERROR_CODES.ATTACHMENT_GONE, 'The upload expired; upload the file again', HTTP_GONE);
            return undefined;
        }
        log.error({ err: error });
        const known = error instanceof AttachmentUnavailableError || error instanceof AttachmentIntegrityError;
        await unavailable(reply, known ? error.message : 'Attachment storage failed');
        return undefined;
    }
}

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

/** A tighter bound than the board's own, for a capability that was minted with one. */
export interface FileBounds {
    maxBytes?: number | undefined;
    mediaTypes?: readonly string[] | undefined;
}

export interface ReceivedFile {
    name: string;
    bytes: Uint8Array;
    mediaType: string;
}

/**
 * The raw body as a named, sniffed file within `bounds`, or null once the refusal has been sent. The type is decided
 * from the bytes, never from a declaration.
 */
export async function receiveFile(
    request: FastifyRequest,
    reply: FastifyReply,
    bounds: FileBounds = {}
): Promise<ReceivedFile | null> {
    const named = nameOf(request);
    if ('error' in named) {
        await bad(reply, ERROR_CODES.BAD_ATTACHMENT, named.error);
        return null;
    }
    if (!Buffer.isBuffer(request.body)) {
        await bad(
            reply,
            ERROR_CODES.BAD_ATTACHMENT,
            `The body must be the raw file, sent as ${OCTET_STREAM_CONTENT_TYPE}`
        );
        return null;
    }
    const bytes: Uint8Array = request.body;
    if (bounds.maxBytes !== undefined && bytes.length > bounds.maxBytes) {
        await bad(
            reply,
            ERROR_CODES.ATTACHMENT_TOO_LARGE,
            `The file is larger than the ${bounds.maxBytes} bytes this upload allows`,
            HTTP_PAYLOAD_TOO_LARGE
        );
        return null;
    }
    const declared = request.headers[MEDIA_TYPE_HEADER];
    const sniffed = sniffAttachment(bytes, {
        name: named.name,
        ...(typeof declared === 'string' ? { mediaType: declared } : {}),
    });
    if (!sniffed.ok) {
        await bad(reply, REASON_CODE[sniffed.reason], REASON_TEXT[sniffed.reason], REASON_STATUS[sniffed.reason]);
        return null;
    }
    if (bounds.mediaTypes && !bounds.mediaTypes.includes(sniffed.mediaType)) {
        await bad(
            reply,
            ERROR_CODES.ATTACHMENT_UNSUPPORTED,
            `This upload accepts only ${bounds.mediaTypes.join(', ')}`,
            HTTP_UNSUPPORTED_MEDIA_TYPE
        );
        return null;
    }
    return { name: named.name, bytes, mediaType: sniffed.mediaType };
}
