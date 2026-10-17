import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { exists } from './job-store-rows.js';

/**
 * Durable settle receipts (issue #821; `072_job_settle_receipts.sql`): an attempt's conclusion
 * records the answer it gave, keyed by its lease token, in the settle's own transaction. A settle
 * whose lease-guarded update missed asks `missedSettle` before answering `lost`: the identical request
 * replays the stored answer, a different one under a concluded lease is still refused.
 */

export type SettleOperation = 'complete' | 'suspend' | 'requeue' | 'interrupt';

/** Stable JSON: object keys sorted at every depth, so key order never changes a fingerprint. */
export function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

export function fingerprintOf(input: unknown): string {
    return createHash('sha256').update(canonical(input)).digest('hex');
}

/** One attempt's conclusion: the attempt (its lease token), the settle, and the request's fingerprint. */
export interface SettleKey {
    orgId: string;
    jobId: string;
    leaseToken: string;
    operation: SettleOperation;
    fingerprint: string;
}

export async function recordReceipt(tx: TransactionSql, key: SettleKey, result: object): Promise<void> {
    await tx`
        insert into job_settle_receipt (org_id, job_id, lease_token, operation, fingerprint, result)
        values (${key.orgId}, ${key.jobId}, ${key.leaseToken}, ${key.operation}, ${key.fingerprint},
                ${tx.json(result as never)})
        on conflict do nothing
    `;
}

/**
 * The stored answer when this attempt was concluded by the identical request; `lost` when it was
 * concluded by a different one; null when no conclusion was recorded under the token.
 */
export async function settleReplayOf<T>(
    sql: Sql | TransactionSql,
    key: SettleKey
): Promise<T | { result: 'lost' } | null> {
    const [receipt] = await sql<{ operation: string; fingerprint: string; result: T }[]>`
        select operation, fingerprint, result from job_settle_receipt
        where org_id = ${key.orgId} and job_id = ${key.jobId} and lease_token = ${key.leaseToken}
    `;
    if (!receipt) return null;
    return receipt.operation === key.operation && receipt.fingerprint === key.fingerprint
        ? receipt.result
        : { result: 'lost' };
}

/**
 * A lease-guarded settle that missed: the identical request replayed under a concluded lease
 * answers its receipt; anything else is a lost lease, or a job that is gone.
 */
export async function missedSettle<T>(
    tx: TransactionSql,
    key: SettleKey
): Promise<T | { result: 'lost' } | { result: 'missing' }> {
    const replayed = await settleReplayOf<T>(tx, key);
    if (replayed) return replayed;
    return (await exists(tx, key.orgId, key.jobId)) ? { result: 'lost' } : { result: 'missing' };
}
