import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply } from 'fastify';
import { bad } from '../helpers.js';
import { parseConnectionIds } from '../connections.js';
import { validateAttachmentsField } from './job-field-validation.js';

/**
 * What a create or follow-up references by id: the `connections` and the uploaded `attachments`. Both are only
 * shape-checked here; whose they are is the store's. Null once the 400 has landed on `reply`.
 */
export function taskRefsOf(
    reply: FastifyReply,
    fields: { connections?: unknown; attachments?: unknown }
): { connectionIds: string[]; attachmentIds: string[] } | null {
    const connectionIds = parseConnectionIds(fields.connections);
    if (typeof connectionIds === 'string') {
        bad(reply, ERROR_CODES.BAD_CONNECTION, connectionIds);
        return null;
    }
    const attachments = validateAttachmentsField(fields.attachments);
    if (!attachments.ok) {
        bad(reply, ERROR_CODES.BAD_ATTACHMENT, attachments.message);
        return null;
    }
    return { connectionIds, attachmentIds: attachments.value };
}
