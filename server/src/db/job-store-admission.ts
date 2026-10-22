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

/**
 * What one org's board asks of the cluster right now, read from its rows so every board replica
 * orders the cross-org claim scan the same way (issue #831, `fairBoardScan`): whether a lost
 * attempt waits for its takeover, how many rows run, and when its oldest waiting row queued.
 */
export interface OrgDemand {
    readonly takeover: boolean;
    readonly running: number;
    readonly oldestWaiting: Date | null;
}

/**
 * A row a lost or handed-over attempt left for its takeover, claimable now: running with its lease
 * expired, or released by a draining driver (queued, its newest interruption naming its own claim),
 * and not deferred by a failed preparation. The org that has one is scanned first and the row comes
 * first in its org's queue (issue #831); `table` qualifies the columns for an aliased read.
 */
export function awaitingTakeover(sql: Sql | TransactionSql, table: string | null = null): Fragment {
    const col = (name: string) => sql(table === null ? name : `${table}.${name}`);
    return sql`(${col('review_of')} is null
        and (${col('claim_deferred_until')} is null or ${col('claim_deferred_until')} <= now())
        and ((${col('status')} = 'running' and ${col('lease_expires_at')} <= now())
             or (${col('status')} = 'queued'
                 and coalesce((${col('interruptions')} -> -1 ->> 'claimSeq')::bigint = ${col('claim_seq')}, false))))`;
}

export async function orgDemand(sql: Sql, orgId: string): Promise<OrgDemand> {
    const [row] = await sql<{ takeover: boolean | null; running: number; oldest_waiting: Date | null }[]>`
        select bool_or(${awaitingTakeover(sql)}) as takeover,
               (count(*) filter (where ${occupying(sql)}))::int as running,
               min(coalesce(claim_deferred_until, created_at))
                   filter (where status = 'queued' and review_of is null) as oldest_waiting
        from job
        where org_id = ${orgId} and status in ('queued', 'running')
    `;
    return { takeover: row?.takeover ?? false, running: row?.running ?? 0, oldestWaiting: row?.oldest_waiting ?? null };
}

/** How much runs now, cluster-wide: the global count and the busiest org and repo (never which). */
export interface AdmissionOccupancy {
    readonly global: number;
    readonly orgMax: number;
    readonly repoMax: number;
}

/** A scrape never waits on a lock for longer than this; the read then fails and its samples are omitted. */
export const OCCUPANCY_TIMEOUT_MS = 2000;

/**
 * `signal` is the caller's deadline over the WHOLE read: `sql.begin` waits for a pool connection
 * without limit, so a read that was let go while it waited does nothing when its turn comes.
 */
export async function admissionOccupancy(
    sql: Sql,
    { signal, timeoutMs = OCCUPANCY_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<AdmissionOccupancy> {
    return sql.begin(async (tx) => {
        signal?.throwIfAborted();
        await tx`select set_config('statement_timeout', ${String(timeoutMs)}, true)`;
        const [row] = await tx<{ global: number; org_max: number; repo_max: number }[]>`
            with running as (
                select org_id, repo from job where ${occupying(tx)}
            )
            select (select count(*) from running)::int as global,
                   coalesce((select max(n) from (select count(*) n from running group by org_id) o), 0)::int as org_max,
                   coalesce((select max(n) from (select count(*) n from running where repo is not null
                                                 group by org_id, repo) r), 0)::int as repo_max
        `;
        return { global: row!.global, orgMax: row!.org_max, repoMax: row!.repo_max };
    });
}

/** What the claim reports about itself (issue #831): `metrics.ts` turns these into series. No method takes an id. */
/** A row waiting for its first claim (`new`) or for the takeover of an attempt that was lost (`takeover`). */
export type ClaimWaitKind = 'new' | 'takeover';

export interface ClaimObserver {
    /** A candidate a full budget refused, by the scope that was full. */
    refusal(scope: AdmissionScope): void;
    /** Queued to claimed, in seconds. */
    wait(kind: ClaimWaitKind, seconds: number): void;
    /** The acquisition's row lock and root advisory lock, round trips included. */
    lockWait(seconds: number): void;
    /** The whole acquisition transaction. */
    acquire(seconds: number): void;
    /** The settle passes a claim runs before it looks for a candidate. */
    sweep(seconds: number): void;
}
