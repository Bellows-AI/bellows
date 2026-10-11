import type { Sql, TransactionSql } from 'postgres';
import type { BatchIdempotency } from './batch-store-types.js';
import { IDEMPOTENCY_RETENTION_HOURS, IdempotencyKeyReusedError } from './job-store-idempotency.js';

/**
 * Idempotency-Key records for create and start (059's `batch_idempotency`), scoped like the job
 * board's: org, caller, operation, key. The request side — header, fingerprint — is
 * `routes/job-idempotency.ts`.
 */

export interface IdempotencyScope {
    orgId: string;
    /** The caller; null (the no-auth stand-in) collapses to the empty string so it is unique too. */
    createdBy: string | null;
    idempotency: BatchIdempotency | undefined;
}

const callerOf = (scope: IdempotencyScope): string => scope.createdBy ?? '';

/** The batch a live record of the key names, or null when the key is free; a different request throws. */
export async function recordedBatch(exec: Sql | TransactionSql, scope: IdempotencyScope): Promise<string | null> {
    const { orgId, idempotency } = scope;
    if (!idempotency) return null;
    const [row] = await exec<{ batch_id: string; fingerprint: string }[]>`
        select batch_id, fingerprint from batch_idempotency
        where org_id = ${orgId} and caller = ${callerOf(scope)}
          and operation = ${idempotency.operation} and key = ${idempotency.key}
          and recorded_at >= now() - make_interval(hours => ${IDEMPOTENCY_RETENTION_HOURS})
    `;
    if (!row) return null;
    if (row.fingerprint !== idempotency.fingerprint) throw new IdempotencyKeyReusedError();
    return row.batch_id;
}

/**
 * Serializes every request under one key for the rest of the transaction, so two concurrent
 * duplicates run one after the other and the second finds the first's record. Then clears an
 * expired record and looks for a live one.
 */
export async function replayInTx(tx: TransactionSql, scope: IdempotencyScope): Promise<string | null> {
    const { orgId, idempotency } = scope;
    if (!idempotency) return null;
    const lock = [orgId, callerOf(scope), idempotency.operation, idempotency.key].join('\u001f');
    await tx`select pg_advisory_xact_lock(hashtextextended(${lock}::text, 0))`;
    await tx`
        delete from batch_idempotency
        where org_id = ${orgId} and caller = ${callerOf(scope)}
          and operation = ${idempotency.operation} and key = ${idempotency.key}
          and recorded_at < now() - make_interval(hours => ${IDEMPOTENCY_RETENTION_HOURS})
    `;
    return recordedBatch(tx, scope);
}

/** Records the key, if the request carried one, against the batch this transaction wrote. */
export async function stampKey(tx: TransactionSql, scope: IdempotencyScope, batchId: string): Promise<void> {
    const { orgId, idempotency } = scope;
    if (!idempotency) return;
    await tx`
        insert into batch_idempotency (org_id, caller, operation, key, fingerprint, batch_id)
        values (${orgId}, ${callerOf(scope)}, ${idempotency.operation}, ${idempotency.key},
                ${idempotency.fingerprint}, ${batchId})
        on conflict (org_id, caller, operation, key)
        do update set fingerprint = excluded.fingerprint, batch_id = excluded.batch_id, recorded_at = now()
    `;
}
