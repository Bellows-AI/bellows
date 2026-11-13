import type { Sql, TransactionSql } from 'postgres';
import type { ObjectStore, PutResult } from '../artifacts/object-store.js';

/**
 * The fence between an org's object writers and its purge (`org-purge.ts`, docs/organizations.md). Every write to an
 * org's prefixes reads the fence (`openForWrites`: the org exists, no purge requested) immediately before its put,
 * under a deadline of `OBJECT_WRITE_BOUND_MS` taken before that read, so a write that passed the fence has landed or
 * been abandoned by `requested_at` plus the bound, and a writer resuming after the cascade finds the fence shut.
 * The purge lists the org's prefixes only after that bound and a margin (`OBJECT_WRITE_DRAIN_MS`): a write that slips
 * past the fence still lands before the list that confirms the prefix empty. The attachment upload fences in its
 * `beginAttempt` stamp under the same bound (`attachment-rows.ts`, `attachment-store.ts`).
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

/**
 * The one condition an org write passes the fence on: the organization row exists AND no purge is requested. Positive
 * on purpose — once the purge's cascade has removed the org (and its `org_purge` row with it) the fence stays shut.
 */
export const openForWrites = (sql: Sql | TransactionSql, orgId: string) =>
    sql`(exists (select 1 from organization where id = ${orgId})
         and not exists (select 1 from org_purge where org_id = ${orgId}))`;

/** One create-only put to the org's namespace, behind the fence and under the write bound. */
export async function fencedPut(
    writer: { sql: Sql | TransactionSql; orgId: string; objects: ObjectStore },
    key: string,
    body: Uint8Array
): Promise<PutResult> {
    const signal = AbortSignal.timeout(OBJECT_WRITE_BOUND_MS);
    const { sql, orgId, objects } = writer;
    const [open] = await sql<{ open_for_writes: boolean }[]>`select ${openForWrites(sql, orgId)} as open_for_writes`;
    if (open?.open_for_writes !== true) throw new OrgPurgingError();
    return objects.put(key, body, { signal });
}
