import type { Sql } from 'postgres';

/**
 * The inbound plan push (095; docs/commerce.md). It takes the org per call, like `createAuthStore`: deciding
 * whether the org exists is its job, and `orgs.for()` answers null on a database failure too, so a null
 * runtime must never be read as "unknown org". One guarded upsert, then a classifying re-read in the same
 * transaction; two replicas taking the same or different versions converge on the newest, decided once.
 */

export const PLANS = ['free', 'pro', 'enterprise'] as const;
export type PlanName = (typeof PLANS)[number];

export interface PlanPush {
    plan: PlanName;
    includedMinutes: number | null;
    usedMinutes: number | null;
    periodStart: Date | null;
    periodEnd: Date | null;
    version: number;
}

export type PlanVerdict =
    | { verdict: 'stored' }
    | { verdict: 'replayed' }
    | { verdict: 'unknown_org' }
    | { verdict: 'stale'; currentVersion: number };

export interface CommercePlanWriter {
    put(orgId: string, push: PlanPush): Promise<PlanVerdict>;
}

interface StoredPlan {
    plan: string;
    included_minutes: string | null;
    used_minutes: string | null;
    period_start: Date | null;
    period_end: Date | null;
    version: string;
}

const numberOrNull = (value: string | null): number | null => (value === null ? null : Number(value));
const timeOrNull = (value: Date | null): number | null => (value === null ? null : value.getTime());

/** The stored row holds exactly what was pushed: the same version with the same fields is a retry. */
const identical = (row: StoredPlan, push: PlanPush): boolean =>
    row.plan === push.plan &&
    numberOrNull(row.included_minutes) === push.includedMinutes &&
    numberOrNull(row.used_minutes) === push.usedMinutes &&
    timeOrNull(row.period_start) === timeOrNull(push.periodStart) &&
    timeOrNull(row.period_end) === timeOrNull(push.periodEnd);

export function createCommercePlanWriter({ sql, ready }: { sql: Sql; ready: Promise<unknown> }): CommercePlanWriter {
    return {
        async put(orgId, push) {
            await ready;
            return sql.begin(async (tx): Promise<PlanVerdict> => {
                const written = await tx`
                    insert into org_plan (org_id, plan, included_minutes, used_minutes, period_start, period_end, version)
                    select ${orgId}, ${push.plan}, ${push.includedMinutes}, ${push.usedMinutes},
                           ${push.periodStart}, ${push.periodEnd}, ${push.version}
                    where exists (select 1 from organization where id = ${orgId})
                    on conflict (org_id) do update set
                        plan = excluded.plan,
                        included_minutes = excluded.included_minutes,
                        used_minutes = excluded.used_minutes,
                        period_start = excluded.period_start,
                        period_end = excluded.period_end,
                        version = excluded.version,
                        updated_at = now()
                    where org_plan.version < excluded.version
                    returning 1
                `;
                if (written.length > 0) return { verdict: 'stored' };
                const [row] = await tx<StoredPlan[]>`
                    select plan, included_minutes, used_minutes, period_start, period_end, version
                    from org_plan where org_id = ${orgId}
                `;
                if (!row) return { verdict: 'unknown_org' };
                const currentVersion = Number(row.version);
                return currentVersion === push.version && identical(row, push)
                    ? { verdict: 'replayed' }
                    : { verdict: 'stale', currentVersion };
            });
        },
    };
}
