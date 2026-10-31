import { createHash, randomUUID } from 'node:crypto';
import type { AttachmentMeta } from '@factory-ai/core';
import type { ObjectStore } from '../artifacts/object-store.js';
import type { AttachmentRow, AttachmentRows } from './attachment-rows.js';

/**
 * The attachment index over the object store: the row arbitrates what the store holds. An upload
 * writes the `pending` row first, then the create-only object, then confirms its size, then moves
 * the row to `ready` — so a `ready` row always has its whole object, and a failure anywhere leaves
 * a `pending` row for the sweep and never a visible partial file. A read that cannot be confirmed
 * is inconclusive: it never marks a row ready and never deletes one.
 */

/** The object store (or its answer) could not be confirmed; the row stays as it was. */
export class AttachmentUnavailableError extends Error {
    constructor(what: string, cause?: unknown) {
        super(`attachment storage unavailable: ${what}`, { cause });
        this.name = 'AttachmentUnavailableError';
    }
}

/** The object at a row's key is not the body the row recorded. */
export class AttachmentIntegrityError extends Error {
    constructor(what: string) {
        super(`attachment integrity: ${what}`);
        this.name = 'AttachmentIntegrityError';
    }
}

/** `<prefix>_attachments/<org>/<id>`: the leading `_` fails the artifact key segment rule, so no artifact key can collide. */
export const attachmentKey = (prefix: string, orgId: string, id: string): string =>
    `${prefix}_attachments/${orgId}/${id}`;

export interface AttachmentUpload {
    uploaderId: string;
    name: string;
    mediaType: string;
    bytes: Uint8Array;
    idempotencyKey?: string | undefined;
}

export interface AttachmentStore {
    upload(input: AttachmentUpload): Promise<{ meta: AttachmentMeta; replayed: boolean }>;
    meta(id: string, uploaderId: string): Promise<AttachmentMeta | null>;
    read(id: string, uploaderId: string): Promise<{ meta: AttachmentMeta; body: Uint8Array } | null>;
    remove(id: string, uploaderId: string): Promise<'deleted' | 'not-found'>;
}

const metaOf = (row: AttachmentRow): AttachmentMeta => ({
    id: row.id,
    name: row.name,
    mediaType: row.mediaType,
    size: row.sizeBytes,
    sha256: row.sha256,
    state: row.state,
});

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** An object-store call whose failure is an unconfirmed answer, never a verdict about the object. */
async function confirmed<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        throw new AttachmentUnavailableError(what, error);
    }
}

export function createAttachmentStore({
    rows,
    objects,
    orgId,
    prefix,
}: {
    rows: AttachmentRows;
    objects: ObjectStore;
    orgId: string;
    /** Normalized: empty or one trailing slash (`ArtifactBackend.prefix`). */
    prefix: string;
}): AttachmentStore {
    /** Brings a `pending` row to `ready`: the create-only put, the exists arbitration, the size check. */
    async function finish(row: AttachmentRow, bytes: Uint8Array): Promise<AttachmentRow> {
        const put = await confirmed('put', () => objects.put(row.objectKey, bytes));
        if (put === 'exists') {
            const held = await confirmed('get', () => objects.get(row.objectKey));
            if (held === null) throw new AttachmentUnavailableError('the stored object could not be read back');
            if (sha256Of(held) !== row.sha256)
                throw new AttachmentIntegrityError('the stored body differs from the recorded sha256');
        }
        const head = await confirmed('head', () => objects.head(row.objectKey));
        if (head === null) throw new AttachmentUnavailableError('the stored object is not visible yet');
        if (head.size !== row.sizeBytes)
            throw new AttachmentIntegrityError('the stored size differs from the recorded size');
        const marked = await rows.markReady(row.id);
        if (!marked) throw new AttachmentUnavailableError('the row left the pending state');
        return marked;
    }

    return {
        async upload(input) {
            const sha256 = sha256Of(input.bytes);
            const id = randomUUID();
            const fingerprint = createHash('sha256')
                .update(JSON.stringify(['attachment-upload', sha256, input.bytes.length, input.name]))
                .digest('hex');
            const { row, replayed } = await rows.insertPending({
                id,
                uploaderId: input.uploaderId,
                name: input.name,
                mediaType: input.mediaType,
                sizeBytes: input.bytes.length,
                sha256,
                objectKey: attachmentKey(prefix, orgId, id),
                ...(input.idempotencyKey ? { idempotency: { key: input.idempotencyKey, fingerprint } } : {}),
            });
            if (row.state !== 'pending') return { meta: metaOf(row), replayed };
            return { meta: metaOf(await finish(row, input.bytes)), replayed };
        },

        async meta(id, uploaderId) {
            const row = await rows.find(id, uploaderId);
            return row ? metaOf(row) : null;
        },

        async read(id, uploaderId) {
            const row = await rows.find(id, uploaderId);
            if (!row) return null;
            const body = await confirmed('get', () => objects.get(row.objectKey));
            if (body === null) throw new AttachmentUnavailableError('the stored object could not be read');
            return { meta: metaOf(row), body };
        },

        async remove(id, uploaderId) {
            const row = await rows.beginDelete(id, uploaderId);
            if (!row) return 'not-found';
            if (row.state === 'deleting') {
                await confirmed('delete', () => objects.delete(row.objectKey));
                await rows.markDeleted(id);
            }
            return 'deleted';
        },
    };
}
