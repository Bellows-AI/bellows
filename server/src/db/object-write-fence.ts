import type { Sql, TransactionSql } from 'postgres';
import type { ObjectStore, PutResult } from '../artifacts/object-store.js';
import { UUID } from '../identifiers.js';

/**
 * The fence between an org's object writers and its purge (`org-purge.ts`, docs/organizations.md). Every write to an
 * org's prefixes reads the fence (`openForWrites`: the org exists, no purge requested) immediately before its put,
 * under a deadline of `OBJECT_WRITE_BOUND_MS` taken before that read, so a write that passed the fence has landed or
 * been abandoned by `requested_at` plus the bound, and a writer resuming after the cascade finds the fence shut.
 * The purge lists the org's prefixes only after that bound and a margin (`OBJECT_WRITE_DRAIN_MS`): a write that slips
 * past the fence still lands before the list that confirms the prefix empty. The attachment upload fences in its
 * `beginAttempt` stamp under the same bound (`attachment-rows.ts`, `attachment-store.ts`).
 *
 * The retention pass (`org-retention.ts`) fences one thread the same way: a write naming a thread root reads, in the
 * same statement, that no expiry stamp (`thread_expiry`) is on it, and the pass lists the thread's prefixes only
 * `OBJECT_WRITE_DRAIN_MS` after its stamp. The stamp outlives the thread's rows, so a late reader still finds it.
 */

/** The longest an object write may take, counted from before its fence read. */
export const OBJECT_WRITE_BOUND_MS = 600_000;
/** Covers a provider that commits a PUT whose client already gave up, as the attachment sweep's grace does. */
const DRAIN_MARGIN_MS = 120_000;
/** How long after a purge is requested before its object step may list the org's prefixes. */
export const OBJECT_WRITE_DRAIN_MS = OBJECT_WRITE_BOUND_MS + DRAIN_MARGIN_MS;

/** A write refused because the org's purge has been requested. */
export class OrgPurgingError extends Error {
    constructor() {
        super('the organization is being deleted');
        this.name = 'OrgPurgingError';
    }
}

/** A write refused because the thread it belongs to is being deleted by its org's retention window. */
export class ThreadExpiringError extends Error {
    constructor() {
        super('the task is being deleted by its retention window');
        this.name = 'ThreadExpiringError';
    }
}

/**
 * The one condition an org write passes the fence on: the organization row exists AND no purge is requested. Positive
 * on purpose — once the purge's cascade has removed the org (and its `org_purge` row with it) the fence stays shut.
 */
export const openForWrites = (sql: Sql | TransactionSql, orgId: string) =>
    sql`(exists (select 1 from organization where id = ${orgId})
         and not exists (select 1 from org_purge where org_id = ${orgId}))`;

/** No expiry stamp on the thread root; a root that is no job id cannot be stamped. */
const threadOpenForWrites = (sql: Sql | TransactionSql, orgId: string, root: string | undefined) =>
    root !== undefined && UUID.test(root)
        ? sql`not exists (select 1 from thread_expiry where org_id = ${orgId} and root_job_id = ${root}::uuid)`
        : sql`true`;

/** One create-only put to the org's namespace (and `root`'s thread, if named), behind the fence and the write bound. */
export async function fencedPut(
    writer: { sql: Sql | TransactionSql; orgId: string; objects: ObjectStore; root?: string | undefined },
    key: string,
    body: Uint8Array
): Promise<PutResult> {
    const signal = AbortSignal.timeout(OBJECT_WRITE_BOUND_MS);
    const { sql, orgId, objects, root } = writer;
    const [open] = await sql<{ open_for_writes: boolean; thread_open: boolean }[]>`
        select ${openForWrites(sql, orgId)} as open_for_writes, ${threadOpenForWrites(sql, orgId, root)} as thread_open
    `;
    if (open?.open_for_writes !== true) throw new OrgPurgingError();
    if (open.thread_open !== true) throw new ThreadExpiringError();
    return objects.put(key, body, { signal });
}
