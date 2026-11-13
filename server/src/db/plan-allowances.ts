import type { Sql, TransactionSql } from 'postgres';
import { PlanLimitError, type PlanLimits, planLimits } from './plan-limits.js';

/**
 * The spend and storage allowances of an organization's plan (`plan-limits.ts`, docs/commerce.md).
 *
 * Tokens: the token points the org's runs reported this period, read from the `org_token_usage` rollup (149) the
 * ingest keeps in the transaction that stores the points, so a create reads one primary-key range and never
 * aggregates metric_point. The period is the pushed plan's (`period_start` while it covers now), otherwise the UTC
 * calendar month. Only delta token points with an org count; a cumulative point (no runner exports one) and a point
 * with no org are left out.
 *
 * Storage: the bytes of the org's live attachments (pending, ready, bound) and of its run-log chunks. Uploads take
 * turns on one transaction lock per org, so two at once never both take the last bytes.
 *
 * Every read here throws on failure: an unconfirmed usage is never "under the allowance" and never a refusal.
 */

const TOKEN_FIELDS = new Set(['tokens_input', 'tokens_output', 'tokens_cacheRead', 'tokens_cacheCreation']);

/** A metric point as the ingest inserted it (`returning`), with the org the row stores. */
export interface InsertedPoint {
    org_id: string | null;
    field: string | null;
    temporality: string;
    value: number;
}

/** Adds the delta token points the ingest just inserted to each org's tokens for today (UTC). */
export async function recordTokenUsage(tx: TransactionSql, points: readonly InsertedPoint[]): Promise<void> {
    const byOrg = new Map<string, number>();
    for (const point of points) {
        if (!point.org_id || point.temporality !== 'delta' || !point.field || !TOKEN_FIELDS.has(point.field)) continue;
        if (!(point.value > 0)) continue;
        byOrg.set(point.org_id, (byOrg.get(point.org_id) ?? 0) + point.value);
    }
    for (const [orgId, tokens] of byOrg) {
        await tx`
            insert into org_token_usage (org_id, day, tokens)
            values (${orgId}, (now() at time zone 'UTC')::date, ${Math.round(tokens)})
            on conflict (org_id, day) do update set tokens = org_token_usage.tokens + excluded.tokens
        `;
    }
}

/** The tokens the org's runs reported in its current period. */
export async function tokensUsed(sql: Sql | TransactionSql, orgId: string): Promise<number> {
    const [row] = await sql<{ used: string }[]>`
        select coalesce(sum(u.tokens), 0)::text as used
        from org_token_usage u
        where u.org_id = ${orgId}
          and u.day >= coalesce(
              (select (p.period_start at time zone 'UTC')::date from org_plan p
               where p.org_id = ${orgId} and p.period_start <= now()
                 and (p.period_end is null or p.period_end > now())),
              date_trunc('month', now() at time zone 'UTC')::date)
    `;
    return Number(row!.used);
}

/** Refuses a new task once the org's tokens this period reach `max`, naming `tokens`. */
export async function refuseOverTokens(tx: TransactionSql, orgId: string, max: number | undefined): Promise<void> {
    if (max === undefined) return;
    if ((await tokensUsed(tx, orgId)) >= max) throw new PlanLimitError('tokens', max);
}

/** The bytes the org holds: live attachments plus run-log chunks. */
export async function storageUsed(sql: Sql | TransactionSql, orgId: string): Promise<number> {
    const [row] = await sql<{ bytes: string }[]>`
        select ((select coalesce(sum(size_bytes), 0) from input_attachment
                 where org_id = ${orgId} and state in ('pending', 'ready', 'bound'))
              + (select coalesce(sum(length), 0) from artifact_chunk where org_id = ${orgId}))::text as bytes
    `;
    return Number(row!.bytes);
}

/**
 * Whether `size` more bytes take the org past its plan's storage allowance; false with no allowance. Unserialized: a
 * run-log chunk checks here, and the chunks in flight at once may each pass (each within the stream cap).
 */
export async function overStorageAllowance(
    sql: Sql,
    orgId: string,
    defaults: PlanLimits,
    size: number
): Promise<boolean> {
    const { storageBytes } = await planLimits(sql, orgId, defaults);
    return storageBytes !== undefined && (await storageUsed(sql, orgId)) + size > storageBytes;
}

/**
 * Refuses an upload of `size` bytes that would take the org past `max`, naming `storage`. The org's uploads take turns
 * on the transaction lock, so the check and the caller's insert in the same transaction are one step.
 */
export async function refuseOverStorage(
    tx: TransactionSql,
    orgId: string,
    max: number | undefined,
    size: number
): Promise<void> {
    if (max === undefined) return;
    await tx`select pg_advisory_xact_lock(hashtextextended(${`plan:storage:${orgId}`}, 0))`;
    if ((await storageUsed(tx, orgId)) + size > max) throw new PlanLimitError('storage', max);
}
