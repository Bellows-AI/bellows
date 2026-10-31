import type { AttachmentState } from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';
import { IdempotencyKeyReusedError } from '../db/jobs/job-store-idempotency.js';

/**
 * The `input_attachment` rows (114) behind the attachment store. Every org-scoped query carries
 * `org_id` from the runtime, never from a request. Every state change is a conditional UPDATE
 * naming the state it expects, so a racing sweep, bind or retry loses cleanly.
 */

export interface AttachmentRow {
    id: string;
    uploaderId: string | null;
    name: string;
    mediaType: string;
    sizeBytes: number;
    sha256: string;
    objectKey: string;
    state: AttachmentState;
}

export interface PendingAttachment {
    id: string;
    uploaderId: string;
    name: string;
    mediaType: string;
    sizeBytes: number;
    sha256: string;
    objectKey: string;
    idempotency?: { key: string; fingerprint: string } | undefined;
}

export interface AttachmentRows {
    /** Inserts the `pending` row, or answers the live row recorded under the same key (`replayed`). */
    insertPending(input: PendingAttachment): Promise<{ row: AttachmentRow; replayed: boolean }>;
    /** `pending` to `ready`; null when the row is no longer pending. */
    markReady(id: string): Promise<AttachmentRow | null>;
    /** A readable row: a `ready` draft of this uploader, or any `bound` file of the org. */
    find(id: string, uploaderId: string): Promise<AttachmentRow | null>;
    /** A `bound` file of the org, whoever uploaded it: the worker route's read, after the job's set named it. */
    findBound(id: string): Promise<AttachmentRow | null>;
    /** The uploader's draft moved to `deleting` (or already `deleting`/`deleted`); null for any other row. */
    beginDelete(id: string, uploaderId: string): Promise<AttachmentRow | null>;
    /** Stamps `last_attempt_at` on a still-`pending` row before its object is written; null when the row has left `pending`. */
    beginAttempt(id: string): Promise<AttachmentRow | null>;
}

/** How long a recorded upload key keeps replaying; past it the key is cleared and may be reused. */
const IDEMPOTENCY_RETENTION_HOURS = 24;

interface DbRow {
    id: string;
    uploader_id: string | null;
    name: string;
    media_type: string;
    size_bytes: number;
    sha256: string;
    object_key: string;
    state: AttachmentState;
    idempotency_fingerprint?: string | null;
}

const rowOf = (row: DbRow): AttachmentRow => ({
    id: row.id,
    uploaderId: row.uploader_id,
    name: row.name,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    objectKey: row.object_key,
    state: row.state,
});

/**
 * Serializes every upload under one key for the rest of the transaction, so two concurrent duplicates
 * run one after the other and the second finds the first's row. Clears an expired record of the key,
 * then answers the live row when the fingerprint matches; a different fingerprint throws.
 */
async function replayOf(
    tx: TransactionSql,
    orgId: string,
    uploaderId: string,
    idem: { key: string; fingerprint: string }
): Promise<AttachmentRow | null> {
    // The unit separator cannot appear in a key (the route's alphabet) nor in an org or user id.
    const scope = [orgId, uploaderId, 'attachment-upload', idem.key].join('\u001f');
    await tx`select pg_advisory_xact_lock(hashtextextended(${scope}::text, 0))`;
    await tx`
        update input_attachment
        set idempotency_key = null, idempotency_fingerprint = null, idempotency_at = null
        where org_id = ${orgId} and uploader_id = ${uploaderId} and idempotency_key = ${idem.key}
          and idempotency_at < now() - make_interval(hours => ${IDEMPOTENCY_RETENTION_HOURS})
    `;
    const [held] = await tx<DbRow[]>`
        select id, uploader_id, name, media_type, size_bytes::int as size_bytes, sha256, object_key,
               state, idempotency_fingerprint
        from input_attachment
        where org_id = ${orgId} and uploader_id = ${uploaderId} and idempotency_key = ${idem.key}
    `;
    if (!held) return null;
    if (held.idempotency_fingerprint !== idem.fingerprint) throw new IdempotencyKeyReusedError();
    return rowOf(held);
}

export function createAttachmentRows({
    sql,
    orgId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    ready: Promise<unknown>;
}): AttachmentRows {
    return {
        async insertPending(input) {
            await ready;
            return sql.begin(async (tx) => {
                const held = input.idempotency ? await replayOf(tx, orgId, input.uploaderId, input.idempotency) : null;
                if (held) return { row: held, replayed: true };
                const [inserted] = await tx<DbRow[]>`
                    insert into input_attachment
                        (org_id, id, uploader_id, name, media_type, size_bytes, sha256, object_key, state,
                         idempotency_key, idempotency_fingerprint, idempotency_at)
                    values (${orgId}, ${input.id}, ${input.uploaderId}, ${input.name}, ${input.mediaType},
                            ${input.sizeBytes}, ${input.sha256}, ${input.objectKey}, 'pending',
                            ${input.idempotency?.key ?? null}, ${input.idempotency?.fingerprint ?? null},
                            ${input.idempotency ? sql`now()` : null})
                    returning id, uploader_id, name, media_type, size_bytes::int as size_bytes, sha256, object_key, state
                `;
                return { row: rowOf(inserted!), replayed: false };
            });
        },

        async markReady(id) {
            await ready;
            const [row] = await sql<DbRow[]>`
                update input_attachment set state = 'ready', ready_at = now()
                where org_id = ${orgId} and id = ${id} and state = 'pending'
                returning id, uploader_id, name, media_type, size_bytes::int as size_bytes, sha256, object_key, state
            `;
            return row ? rowOf(row) : null;
        },

        async find(id, uploaderId) {
            await ready;
            const [row] = await sql<DbRow[]>`
                select id, uploader_id, name, media_type, size_bytes::int as size_bytes, sha256, object_key, state
                from input_attachment
                where org_id = ${orgId} and id = ${id}
                  and ((state = 'bound' and exists (
                           select 1 from job j where j.org_id = input_attachment.org_id and j.id = input_attachment.bound_job_id))
                       or (state = 'ready' and uploader_id = ${uploaderId}))
            `;
            return row ? rowOf(row) : null;
        },

        async findBound(id) {
            await ready;
            const [row] = await sql<DbRow[]>`
                select id, uploader_id, name, media_type, size_bytes::int as size_bytes, sha256, object_key, state
                from input_attachment where org_id = ${orgId} and id = ${id} and state = 'bound'
            `;
            return row ? rowOf(row) : null;
        },

        async beginDelete(id, uploaderId) {
            await ready;
            const [moved] = await sql<DbRow[]>`
                update input_attachment set state = 'deleting', deleting_at = coalesce(deleting_at, now())
                where org_id = ${orgId} and id = ${id} and uploader_id = ${uploaderId}
                  and state in ('pending', 'ready', 'deleting')
                returning id, uploader_id, name, media_type, size_bytes::int as size_bytes, sha256, object_key, state
            `;
            if (moved) return rowOf(moved);
            const [settled] = await sql<DbRow[]>`
                select id, uploader_id, name, media_type, size_bytes::int as size_bytes, sha256, object_key, state
                from input_attachment
                where org_id = ${orgId} and id = ${id} and uploader_id = ${uploaderId} and state = 'deleted'
            `;
            return settled ? rowOf(settled) : null;
        },

        async beginAttempt(id) {
            await ready;
            const [row] = await sql<DbRow[]>`
                update input_attachment set last_attempt_at = now()
                where org_id = ${orgId} and id = ${id} and state = 'pending'
                returning id, uploader_id, name, media_type, size_bytes::int as size_bytes, sha256, object_key, state
            `;
            return row ? rowOf(row) : null;
        },
    };
}
