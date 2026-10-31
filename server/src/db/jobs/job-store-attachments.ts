import { MAX_FILES_PER_REQUEST, MAX_REQUEST_BYTES, type AttachmentMeta } from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';

/**
 * The files a task carries (115): bound to a job in the transaction that inserts it, read back per thread, revoked
 * with the thread. Who may bind a file is the uploader's alone, and only while it is `ready`.
 */

export type AttachmentRefusal = 'not-authorized' | 'duplicate' | 'too-many' | 'too-large';

export class AttachmentRefusedError extends Error {
    constructor(readonly reason: AttachmentRefusal) {
        super(`attachments refused: ${reason}`);
        this.name = 'AttachmentRefusedError';
    }
}

/**
 * Binds `ids` (the order is each file's position) to `jobId` of thread `rootJobId`. One conditional UPDATE names
 * every precondition, so a file another request bound first, a foreign or pending one, or an unknown id returns
 * fewer rows than asked and the whole request is refused; the throw rolls the job insert back with it.
 */
export async function bindAttachmentsInTx(
    tx: TransactionSql,
    args: { orgId: string; jobId: string; rootJobId: string; createdBy: string | null; ids: readonly string[] }
): Promise<void> {
    const { orgId, jobId, rootJobId, createdBy, ids } = args;
    if (ids.length === 0) return;
    if (ids.length > MAX_FILES_PER_REQUEST) throw new AttachmentRefusedError('too-many');
    if (new Set(ids).size !== ids.length) throw new AttachmentRefusedError('duplicate');
    if (createdBy === null) throw new AttachmentRefusedError('not-authorized');
    const bound = await tx<{ size_bytes: number }[]>`
        update input_attachment a
        set state = 'bound', bound_job_id = ${jobId}, root_job_id = ${rootJobId}, bound_at = now(),
            position = n.position::int - 1
        from unnest(${tx.array([...ids])}::uuid[]) with ordinality as n(id, position)
        where a.org_id = ${orgId} and a.id = n.id and a.uploader_id = ${createdBy} and a.state = 'ready'
        returning a.size_bytes::float8 as size_bytes
    `;
    if (bound.length !== ids.length) throw new AttachmentRefusedError('not-authorized');
    if (bound.reduce((sum, row) => sum + row.size_bytes, 0) > MAX_REQUEST_BYTES) {
        throw new AttachmentRefusedError('too-large');
    }
}

/**
 * The bound files of a thread, keyed by the job that carried them, in the order named. A file whose job row is gone is
 * not returned: the join is the access check, whatever state the file row was left in.
 */
export async function attachmentsOfThread(
    sql: Sql,
    orgId: string,
    rootJobId: string
): Promise<Map<string, AttachmentMeta[]>> {
    const rows = await sql<
        { bound_job_id: string; id: string; name: string; media_type: string; size: number; sha256: string }[]
    >`
        select a.bound_job_id, a.id, a.name, a.media_type, a.size_bytes::float8 as size, a.sha256
        from input_attachment a
        join job j on j.org_id = a.org_id and j.id = a.bound_job_id
        where a.org_id = ${orgId} and a.root_job_id = ${rootJobId} and a.state = 'bound'
        order by a.position
    `;
    const byJob = new Map<string, AttachmentMeta[]>();
    for (const row of rows) {
        const list = byJob.get(row.bound_job_id) ?? [];
        list.push({
            id: row.id,
            name: row.name,
            mediaType: row.media_type,
            size: row.size,
            sha256: row.sha256,
            state: 'bound',
        });
        byJob.set(row.bound_job_id, list);
    }
    return byJob;
}

/** A removed thread's bound files move to `deleting`, in the removal's transaction; the sweep owns the rest. */
export async function revokeThreadAttachmentsInTx(tx: TransactionSql, orgId: string, rootJobId: string): Promise<void> {
    await tx`
        update input_attachment set state = 'deleting', deleting_at = now()
        where org_id = ${orgId} and root_job_id = ${rootJobId} and state = 'bound'
    `;
}

/** One file of a run's manifest: what the runner fetches and verifies, and the task that carried it. */
export interface ClaimAttachment {
    id: string;
    name: string;
    mediaType: string;
    size: number;
    sha256: string;
    originJobId: string;
}

/**
 * Whose files a job carries: the thread root and the `created_at` cutoff, read in one statement. An ordinary row is
 * its own thread's root at its own creation; a review is a thread of its own that binds nothing, so it takes the row it
 * reviews. An unknown job, or a review whose reviewed row is gone, throws: an unconfirmed read never becomes "no files".
 * The cutoff stays text, and is cast through text, because the driver serializes a timestamptz parameter at millisecond precision.
 */
export async function effectiveAttachmentScope(
    sql: Sql | TransactionSql,
    orgId: string,
    jobId: string
): Promise<{ scopeRoot: string; cutoff: string }> {
    const [row] = await sql<{ scope_root: string | null; cutoff: string | null; reviewed_missing: boolean }[]>`
        select coalesce(r.root_job_id, j.root_job_id)::text as scope_root,
               coalesce(r.created_at, j.created_at)::text as cutoff,
               (j.review_of is not null and r.id is null) as reviewed_missing
        from job j
        left join job r on r.org_id = j.org_id and r.id = j.review_of
        where j.org_id = ${orgId} and j.id = ${jobId}
    `;
    if (!row) throw new Error(`attachment scope: no such job ${jobId}`);
    if (row.reviewed_missing) throw new Error(`attachment scope: the job ${jobId} reviews a row that is gone`);
    return { scopeRoot: row.scope_root!, cutoff: row.cutoff! };
}

/** The files the job's run carries, computed at read: the oldest carrier first, each file in the order named. */
export async function effectiveAttachments(
    sql: Sql | TransactionSql,
    orgId: string,
    jobId: string
): Promise<ClaimAttachment[]> {
    const { scopeRoot, cutoff } = await effectiveAttachmentScope(sql, orgId, jobId);
    const rows = await sql<
        { bound_job_id: string; id: string; name: string; media_type: string; size: number; sha256: string }[]
    >`
        select a.bound_job_id, a.id, a.name, a.media_type, a.size_bytes::float8 as size, a.sha256
        from input_attachment a
        join job b on b.org_id = a.org_id and b.id = a.bound_job_id
        where a.org_id = ${orgId} and a.root_job_id = ${scopeRoot} and a.state = 'bound'
          and b.created_at <= (${cutoff}::text)::timestamptz
        order by b.created_at, a.position
    `;
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        mediaType: row.media_type,
        size: row.size,
        sha256: row.sha256,
        originJobId: row.bound_job_id,
    }));
}
