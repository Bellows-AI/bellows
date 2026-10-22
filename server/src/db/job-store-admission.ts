/**
 * Shared admission budgets (issue #831): how many rows may run at once across every org, per org and
 * per repo, enforced by the claim for every board replica and driver alike. Occupancy is the running
 * non-review rows themselves (081), so a row that ends — verdict, stop, retirement, handover, remove —
 * frees its slots by leaving the unique indexes' predicate, and no counter can leak when its owner
 * crashes. See docs/jobs.md.
 */

import type { Fragment, Sql, TransactionSql } from 'postgres';

/** Each limit a positive integer; an absent one is unlimited. */
export interface AdmissionBudgets {
    readonly global?: number;
    readonly org?: number;
    readonly repo?: number;
}

export type AdmissionScope = 'global' | 'org' | 'repo';

/** The slot a queued row is admitted into, per scope; null where the scope is unbudgeted. */
export type AdmissionSlots = Readonly<Record<AdmissionScope, number | null>>;

/** The budget a refused candidate found full. */
export interface AdmissionRefusal {
    readonly full: AdmissionScope;
}

/** The advisory key a claimer try-locks while it takes slot `slot` of one budget. */
export const admissionLockKey = (scope: AdmissionScope, key: string, slot: number): string =>
    `admission:${scope}:${key}:${slot}`;

const COLUMNS = {
    global: 'admission_slot_global',
    org: 'admission_slot_org',
    repo: 'admission_slot_repo',
} as const satisfies Record<AdmissionScope, string>;

interface Budget {
    scope: AdmissionScope;
    limit: number;
    /** The scope's rows, unqualified: the claim's statements read `job` alone. */
    where: Fragment;
    key: string;
}

const occupying = (sql: Sql | TransactionSql): Fragment => sql`(status = 'running' and review_of is null)`;

/** The budgets that bind a row of `orgId` and `repo`; a repo-less row has no repo budget. */
function budgetsFor(
    sql: Sql | TransactionSql,
    budgets: AdmissionBudgets,
    orgId: string,
    repo: string | null
): Budget[] {
    const out: Budget[] = [];
    if (budgets.global !== undefined) out.push({ scope: 'global', limit: budgets.global, where: sql`true`, key: '' });
    if (budgets.org !== undefined) {
        out.push({ scope: 'org', limit: budgets.org, where: sql`org_id = ${orgId}`, key: orgId });
    }
    if (budgets.repo !== undefined && repo !== null) {
        out.push({
            scope: 'repo',
            limit: budgets.repo,
            where: sql`org_id = ${orgId} and repo = ${repo}`,
            key: `${orgId}:${repo}`,
        });
    }
    return out;
}

/**
 * Whether new work of `orgId` has room in the global and org budgets, read without a lock. Advisory:
 * it only spares the claim a reservation it would refuse; `admitInTx` decides.
 */
export async function roomForNew(sql: Sql, budgets: AdmissionBudgets, orgId: string): Promise<boolean> {
    for (const budget of budgetsFor(sql, budgets, orgId, null)) {
        const [row] = await sql<{ n: number }[]>`
            select count(*)::int as n from job where ${occupying(sql)} and ${budget.where}
        `;
        if (row!.n >= budget.limit) return false;
    }
    return true;
}

/** The reservation's repo filter for candidate alias `j`, advisory like `roomForNew`. */
export function repoRoom(sql: Sql, budgets: AdmissionBudgets): Fragment {
    if (budgets.repo === undefined) return sql`true`;
    return sql`(j.repo is null or (
        select count(*) from job o
        where o.org_id = j.org_id and o.repo = j.repo and o.status = 'running' and o.review_of is null
    ) < ${budgets.repo})`;
}

/**
 * Admits a queued row of `orgId`/`repo` into every budget that binds it, inside the claim's
 * acquisition transaction, or names the budget that is full.
 *
 * Per budget: full when its occupying rows already reach the limit. Otherwise every occupying row
 * holds a distinct slot in 1..limit once the rows that hold none — claimed before the budget existed,
 * or above a lowered limit — are moved into free slots first, so the unique slots bound the count
 * for every concurrent claimer. A slot is taken with a try-lock and re-read after it, so a claimer
 * that committed it meanwhile is seen and one that holds it is skipped: no claimer waits on another.
 * A row that cannot be moved (its row lock is held, or it just ended) refuses this claim
 * conservatively; the next poll reads fresh.
 */
export async function admitInTx(
    tx: TransactionSql,
    budgets: AdmissionBudgets,
    orgId: string,
    repo: string | null
): Promise<AdmissionSlots | AdmissionRefusal> {
    const slots: Record<AdmissionScope, number | null> = { global: null, org: null, repo: null };
    for (const budget of budgetsFor(tx, budgets, orgId, repo)) {
        const slot = await admitInBudget(tx, budget);
        if (slot === null) return { full: budget.scope };
        slots[budget.scope] = slot;
    }
    return slots;
}

async function admitInBudget(tx: TransactionSql, budget: Budget): Promise<number | null> {
    const { limit, where, scope, key } = budget;
    const column = tx(COLUMNS[scope]);
    const rows = await tx<{ id: string; slot: number | null }[]>`
        select id, ${column} as slot from job where ${occupying(tx)} and ${where}
    `;
    if (rows.length >= limit) return null;
    const tried = new Set(rows.flatMap((row) => (row.slot !== null && row.slot <= limit ? [row.slot] : [])));
    const take = async (): Promise<number | null> => {
        for (let slot = 1; slot <= limit; slot++) {
            if (tried.has(slot)) continue;
            tried.add(slot);
            const [lock] = await tx<{ locked: boolean }[]>`
                select pg_try_advisory_xact_lock(hashtextextended(${admissionLockKey(scope, key, slot)}, 0)) as locked
            `;
            if (!lock!.locked) continue;
            const [held] =
                await tx`select 1 from job where ${occupying(tx)} and ${where} and ${column} = ${slot} limit 1`;
            if (!held) return slot;
        }
        return null;
    };
    for (const row of rows) {
        if (row.slot !== null && row.slot <= limit) continue;
        const slot = await take();
        if (slot === null) return null;
        const moved = await tx`
            update job set ${column} = ${slot}
            where id = (
                select id from job
                where id = ${row.id} and ${occupying(tx)} and (${column} is null or ${column} > ${limit})
                for update skip locked
            )
            returning id
        `;
        if (moved.length === 0) return null;
    }
    return take();
}
