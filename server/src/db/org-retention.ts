import type { Fragment, Sql, TransactionSql } from 'postgres';
import type { ObjectStore } from '../artifacts/object-store.js';
import { startIntervalLoop } from '../interval-loop.js';
import { recordAudit } from './audit-log.js';
import { lockThreadInTx } from './connection-bindings.js';
import { terminalFragment } from './jobs/job-store-sql-fragments.js';
import { removeLockedThreadInTx } from './jobs/job-store-thread-actions.js';
import { OBJECT_WRITE_DRAIN_MS } from './object-write-fence.js';
import { REQUEST_ROLE } from './org-sql.js';
import { deleteObjectPage, type OrgPurgeDeps, ownerOrg, type PurgeError, retireSecrets } from './org-purge.js';
import { type PlanLimits, planChangeLockKey, planLimits } from './plan-limits.js';
import { waitAdvisoryXactLock } from './pool.js';

/**
 * Plan-based retention (docs/retention.md): an interval loop on every replica, on the cross-org pool, that deletes every
 * thread of an active org whose last run settled before the org's window. Per org, under its `org_retention` row
 * (`for update skip locked`):
 *
 * 1. window — the plan's `retentionDays` against the effective one: higher applies at once, lower after a 30-day
 *    notice with one `system` audit row; no row is unlimited, so an org's first window is a notice too.
 * 2. stamp — each eligible task root (and each of its reviews, or every thread of an eligible batch) gets a
 *    `thread_expiry` row under the thread's lock, re-checked there. From then on `lockThreadRootInTx` finds the
 *    thread gone (no follow-up, retry or reopen) and every object write to its prefixes is refused.
 * 3. expire — once `OBJECT_WRITE_DRAIN_MS` has passed since the stamp: secrets that name a member, then every object
 *    under the thread's prefixes until a list answers empty, then the rows in one transaction through the Remove path,
 *    eligibility re-checked under the locks. A thread the window no longer covers (an upgrade) loses its stamp.
 * 4. telemetry — the org's points and branch rows older than the window, in bounded batches.
 *
 * A step that cannot be confirmed records a closed error code on the stamp and retries next pass; nothing is reported
 * gone unconfirmed. Every step is safe to run again, so a pass cut off by a lost replica resumes. One log line per org
 * per pass carries counts and error codes only.
 */

export const RETENTION_INTERVAL_MS = 3_600_000;
/** How long one pass may run before it stops between items; the next pass resumes. */
export const RETENTION_PASS_MS = 120_000;
/** A lower window applies this long after the plan lowered it (decided). */
export const DOWNGRADE_NOTICE_DAYS = 30;
/** Threads (or batches) stamped, and stamped units expired, per org per pass. */
export const THREADS_PER_PASS = 100;
const POINT_BATCH_ROWS = 10_000;
const POINT_BATCHES = 10;
/** How long a stamp outlives its thread's rows, so a write that read the fence late still finds it shut. */
const STAMP_KEEP_HOURS = 24;
const MS_PER_SECOND = 1000;

/** Closed: what a unit's `last_error` and the pass line name, never tenant data. */
export type RetentionError = PurgeError | 'batch-unexpired' | 'thread-refused';

export interface OrgRetentionDeps {
    sql: Sql;
    secrets: OrgPurgeDeps['secrets'];
    objects: ObjectStore;
    /** The artifact backend's key prefix (`ArtifactBackend.prefix`). */
    prefix: string;
    planDefaults: PlanLimits;
    log?: ((line: string) => void) | undefined;
    passMs?: number | undefined;
    /** Tests only: how long after the stamp the object step waits for fenced writes (`OBJECT_WRITE_DRAIN_MS`). */
    writeDrainMs?: number | undefined;
    /** Tests only: the per-org bound (`THREADS_PER_PASS`). */
    threadsPerPass?: number | undefined;
}

interface Counts {
    days: number | null;
    stamped: number;
    expired: number;
    revived: number;
    pending: number;
    points: number;
    branches: number;
    errors: RetentionError[];
}

interface OrgPass {
    deps: OrgRetentionDeps;
    orgId: string;
    expired: () => boolean;
    signal: AbortSignal | undefined;
    counts: Counts;
}

const cutoffOf = (sql: Sql | TransactionSql, days: number) => sql`now() - make_interval(days => ${days})`;

/**
 * The thread `root` is settled before `cutoff`: every member and every review of one is terminal and finished before
 * it, and no workflow wait of the root is pending. Suspended-interrupted runs are queued again, never terminal.
 */
function settledBefore(sql: Sql | TransactionSql, orgId: string, root: Fragment, cutoff: Fragment): Fragment {
    return sql`(
        not exists (
            select 1 from job m where m.org_id = ${orgId} and m.root_job_id = ${root}
              and (not ${terminalFragment(sql, 'm.status')} or coalesce(m.finished_at, m.created_at) >= ${cutoff}))
        and not exists (
            select 1 from job m join job v on v.org_id = m.org_id and v.review_of = m.id
            where m.org_id = ${orgId} and m.root_job_id = ${root}
              and (not ${terminalFragment(sql, 'v.status')} or coalesce(v.finished_at, v.created_at) >= ${cutoff}))
        and not exists (
            select 1 from workflow_wait w where w.org_id = ${orgId} and w.root_job_id = ${root}
              and w.completed_at is null and w.cancelled_at is null)
    )`;
}

/** A batch every thread of which is settled, finished or never started, last changed before `cutoff`. */
function batchSettledBefore(sql: Sql | TransactionSql, orgId: string, batch: Fragment, cutoff: Fragment): Fragment {
    return sql`(
        exists (
            select 1 from batch b where b.org_id = ${orgId} and b.id = ${batch} and b.updated_at < ${cutoff}
              and (b.status = 'draft' or b.completed_at is not null or b.cancelled_at is not null))
        and not exists (
            select 1 from batch_task t where t.org_id = ${orgId} and t.batch_id = ${batch} and t.root_job_id is not null
              and not ${settledBefore(sql, orgId, sql`t.root_job_id`, cutoff)})
    )`;
}

/** Locks the given thread roots (ascending), then each thread's advisory lock; the ids that are still roots. */
async function lockStampedRoots(tx: TransactionSql, orgId: string, roots: readonly string[]): Promise<string[]> {
    const rows = await tx<{ id: string }[]>`
        select id from job where org_id = ${orgId} and id = any(${roots as string[]}::uuid[]) and root_job_id = id
        order by id for no key update
    `;
    for (const { id } of rows) await lockThreadInTx(tx, id);
    return rows.map((row) => row.id);
}

/** Stamps the roots and the reviews of their members, as one unit. */
async function stampInTx(tx: TransactionSql, orgId: string, roots: readonly string[], unit: string): Promise<void> {
    await tx`
        insert into thread_expiry (org_id, root_job_id, unit)
        select ${orgId}, id, ${unit} from job
        where org_id = ${orgId}
          and (id = any(${roots as string[]}::uuid[])
               or review_of in (select id from job where org_id = ${orgId} and root_job_id = any(${roots as string[]}::uuid[])))
        on conflict do nothing
    `;
}

/** Step 1, under the org's row lock: the window this pass deletes by, null for unlimited. */
async function reconcileWindow(tx: TransactionSql, orgId: string, target: number | undefined): Promise<number | null> {
    const [row] = await tx<{ effective_days: number | null; pending_days: number | null; due: boolean }[]>`
        select effective_days, pending_days,
               coalesce(pending_from + make_interval(days => ${DOWNGRADE_NOTICE_DAYS}) <= now(), false) as due
        from org_retention where org_id = ${orgId}
    `;
    const effective = row?.effective_days ?? null;
    const set = (days: number | null) =>
        tx`update org_retention set effective_days = ${days}, pending_days = null, pending_from = null,
                                    updated_at = now() where org_id = ${orgId}`;
    if (target === undefined) {
        if (effective !== null || row?.pending_days != null) await set(null);
        return null;
    }
    if (effective !== null && target >= effective) {
        if (target !== effective || row?.pending_days != null) await set(target);
        return target;
    }
    if (row?.pending_days !== target) {
        const [noticed] = await tx<{ effective_at: Date }[]>`
            update org_retention set pending_days = ${target}, pending_from = now(), updated_at = now()
            where org_id = ${orgId}
            returning now() + make_interval(days => ${DOWNGRADE_NOTICE_DAYS}) as effective_at
        `;
        await recordAudit(tx, {
            orgId,
            actor: { kind: 'system', id: null },
            action: 'org.retention_downgrade',
            target: orgId,
            detail: { fromDays: effective, toDays: target, effectiveAt: noticed?.effective_at.toISOString() ?? null },
        });
        return effective;
    }
    if (row.due) {
        await set(target);
        return target;
    }
    return effective;
}

/** Step 2: stamps up to the bound of eligible lone threads, then of eligible batches. */
async function stampEligible(pass: OrgPass, days: number): Promise<void> {
    const { deps, orgId, counts } = pass;
    const { sql } = deps;
    const bound = deps.threadsPerPass ?? THREADS_PER_PASS;
    const cutoff = cutoffOf(sql, days);
    // A thread's newest finish is never before its root's creation, so only roots created before the cutoff qualify.
    const roots = await sql<{ id: string }[]>`
        select r.id from job r
        where r.org_id = ${orgId} and r.root_job_id = r.id and r.review_of is null and r.created_at < ${cutoff}
          and not exists (select 1 from thread_expiry e where e.org_id = r.org_id and e.root_job_id = r.id)
          and not exists (select 1 from batch_task t where t.org_id = r.org_id and t.root_job_id = r.id)
          and ${settledBefore(sql, orgId, sql`r.id`, cutoff)}
        order by r.created_at, r.id limit ${bound}
    `;
    for (const { id } of roots) {
        if (pass.expired()) return;
        const stamped = await sql.begin(async (tx) => {
            if ((await lockStampedRoots(tx, orgId, [id])).length !== 1) return false;
            const [still] = await tx<{ ok: boolean }[]>`
                select ${settledBefore(tx, orgId, tx`${id}::uuid`, cutoffOf(tx, days))}
                   and not exists (select 1 from batch_task t where t.org_id = ${orgId} and t.root_job_id = ${id})
                   as ok
            `;
            if (still?.ok !== true) return false;
            await stampInTx(tx, orgId, [id], `thread:${id}`);
            return true;
        });
        if (stamped) counts.stamped += 1;
    }
    const batches = await sql<{ id: string }[]>`
        select b.id from batch b
        where b.org_id = ${orgId} and b.updated_at < ${cutoff}
          and not exists (select 1 from thread_expiry e where e.org_id = b.org_id and e.unit = 'batch:' || b.id)
          and ${batchSettledBefore(sql, orgId, sql`b.id`, cutoff)}
        order by b.updated_at, b.id limit ${Math.max(0, bound - roots.length)}
    `;
    for (const { id } of batches) {
        if (pass.expired()) return;
        await stampBatch(pass, id, days);
    }
}

/** Stamps every thread of a settled batch as one unit; a batch that backs none is deleted at once. */
async function stampBatch(pass: OrgPass, batchId: string, days: number): Promise<void> {
    const { orgId, counts } = pass;
    const outcome = await pass.deps.sql.begin(async (tx) => {
        const [batch] = await tx`select 1 from batch where org_id = ${orgId} and id = ${batchId} for update`;
        if (!batch) return 'gone';
        const roots = await tx<{ id: string }[]>`
            select root_job_id as id from batch_task
            where org_id = ${orgId} and batch_id = ${batchId} and root_job_id is not null
        `;
        const ids = roots.map((row) => row.id);
        if ((await lockStampedRoots(tx, orgId, ids)).length !== ids.length) return 'gone';
        const [still] = await tx<{ ok: boolean }[]>`
            select ${batchSettledBefore(tx, orgId, tx`${batchId}::uuid`, cutoffOf(tx, days))} as ok
        `;
        if (still?.ok !== true) return 'gone';
        if (ids.length === 0) {
            await tx`delete from batch where org_id = ${orgId} and id = ${batchId}`;
            return 'deleted';
        }
        await stampInTx(tx, orgId, ids, `batch:${batchId}`);
        return 'stamped';
    });
    if (outcome === 'stamped') counts.stamped += 1;
    if (outcome === 'deleted') counts.expired += 1;
}

interface Unit {
    unit: string;
    roots: string[];
    drained: boolean;
    /** Its deletion began (`deleting_at`): it is only ever finished, never revived. */
    deleting: boolean;
}

/** The unit's job ids: every member of each stamped root (reviews are stamped roots too). */
async function unitJobIds(sql: Sql | TransactionSql, orgId: string, roots: readonly string[]): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        select id::text as id from job where org_id = ${orgId} and root_job_id = any(${roots as string[]}::uuid[])
    `;
    return rows.map((row) => row.id);
}

/** Step 3a: every secret whose identity names a member of the unit, physically collected. */
async function expireSecrets(pass: OrgPass, jobIds: readonly string[]): Promise<RetentionError | null> {
    const { deps, orgId, expired, signal } = pass;
    return deps.sql.begin(async (tx) => {
        const owner = ownerOrg(tx);
        const named = tx`identity_key::jsonb #>> '{4}' = 'job' and identity_key::jsonb #>> '{5}' = any(${jobIds as string[]})`;
        const owned = await tx<{ ref: string; identity_key: string }[]>`
            select ref, identity_key from secret where ${owner} = ${orgId} and ${named}
            union select ref, identity_key from secret_operation where ${owner} = ${orgId} and ${named}
            order by ref
        `;
        return retireSecrets({ tx, secrets: deps.secrets, expired, signal }, owned);
    });
}

/** Step 3b: every object under the unit's prefixes (`<prefix><org>/<member>/<root>/`), until each list is empty. */
async function expireObjects(pass: OrgPass, unit: Unit, jobIds: readonly string[]): Promise<RetentionError | null> {
    const { deps, orgId } = pass;
    const prefixes = await deps.sql<{ member_id: string; root_job_id: string }[]>`
        select member_id, root_job_id from artifact_chunk
        where org_id = ${orgId} and job_id = any(${jobIds as string[]}) and root_job_id = any(${unit.roots})
        union
        select member_id, root_job_id from artifact_manifest
        where org_id = ${orgId} and job_id = any(${jobIds as string[]}) and root_job_id = any(${unit.roots})
    `;
    for (const { member_id: member, root_job_id: root } of prefixes) {
        const namespace = `${deps.prefix}${orgId}/${member}/${root}/`;
        for (let page: PurgeError | null | 'empty' = null; page !== 'empty'; ) {
            if (pass.expired()) return 'pass-timeout';
            page = await deleteObjectPage(deps.objects, namespace, pass.signal);
            if (page !== null && page !== 'empty') return page;
        }
    }
    return null;
}

/** Every thread root of the unit (not its reviews) is settled before `cutoff`; false when one is not. */
async function unitSettled(sql: Sql | TransactionSql, orgId: string, unit: Unit, cutoff: Fragment): Promise<boolean> {
    const [row] = await sql<{ ok: boolean | null }[]>`
        select bool_and(${settledBefore(sql, orgId, sql`r.id`, cutoff)}) as ok
        from job r where r.org_id = ${orgId} and r.id = any(${unit.roots}::uuid[]) and r.review_of is null
    `;
    // No thread root left (a row step that committed before its stamp was marked) is nothing to keep.
    return row?.ok !== false;
}

/**
 * The deletion start: under the org's plan-change lock (a push takes it too) the window is reconciled again and the
 * unit re-checked against it; only then is `deleting_at` written, before any secret or object is touched. `'revive'`
 * when the window no longer covers the unit; null once the phase is written.
 */
async function beginDeletion(pass: OrgPass, unit: Unit): Promise<'revive' | null> {
    const { deps, orgId } = pass;
    return deps.sql.begin(async (tx) => {
        await waitAdvisoryXactLock(tx, planChangeLockKey(orgId));
        await tx`select 1 from org_retention where org_id = ${orgId} for update`;
        const days = await reconcileWindow(tx, orgId, (await planLimits(tx, orgId, deps.planDefaults)).retentionDays);
        if (days === null || !(await unitSettled(tx, orgId, unit, cutoffOf(tx, days)))) return 'revive';
        await tx`update thread_expiry set deleting_at = now() where org_id = ${orgId} and unit = ${unit.unit}`;
        return null;
    });
}

/** The unit's thread roots (not its reviews), locked; every member is still terminal, as its stamp froze it. */
async function lockUnitThreads(tx: TransactionSql, orgId: string, unit: Unit): Promise<string[]> {
    const threads = await tx<{ id: string }[]>`
        select id from job where org_id = ${orgId} and id = any(${unit.roots}::uuid[]) and review_of is null
    `;
    const roots = await lockStampedRoots(
        tx,
        orgId,
        threads.map((row) => row.id)
    );
    for (const root of roots) {
        const [still] = await tx<{ ok: boolean }[]>`
            select ${settledBefore(tx, orgId, tx`${root}::uuid`, tx`now()`)} as ok
        `;
        if (still?.ok !== true) throw new ThreadRefusedError();
    }
    return roots;
}

/** The Remove path refused a stamped thread, or one is no longer settled: the whole row step rolls back. */
class ThreadRefusedError extends Error {}

/** Step 3c: the unit's rows, in one transaction under its locks. Past the deletion start, so no window re-check. */
async function expireRows(pass: OrgPass, unit: Unit): Promise<RetentionError | null> {
    const { deps, orgId } = pass;
    const step = deps.sql.begin(async (tx) => {
        const batchId = unit.unit.startsWith('batch:') ? unit.unit.slice('batch:'.length) : null;
        if (batchId) await tx`select 1 from batch where org_id = ${orgId} and id = ${batchId} for update`;
        const roots = await lockUnitThreads(tx, orgId, unit);
        const jobIds = await unitJobIds(tx, orgId, unit.roots);
        if (batchId) await tx`delete from batch where org_id = ${orgId} and id = ${batchId}`;
        for (const root of roots) {
            const removed = await removeLockedThreadInTx(tx, { orgId, prs: undefined }, root, null);
            if (typeof removed === 'string' && removed !== 'missing') throw new ThreadRefusedError();
        }
        const stamped = tx`${unit.roots}::uuid[]`;
        await tx`delete from artifact_chunk where org_id = ${orgId} and job_id = any(${jobIds})`;
        await tx`delete from artifact_manifest where org_id = ${orgId} and job_id = any(${jobIds})`;
        await tx`delete from job_pr where org_id = ${orgId} and root_job_id = any(${stamped})`;
        await tx`delete from workflow_wait where org_id = ${orgId} and root_job_id = any(${stamped})`;
        await tx`delete from notification_event where org_id = ${orgId} and root_job_id = any(${stamped})`;
        await tx`
            update thread_expiry set rows_deleted_at = now(), last_error = null
            where org_id = ${orgId} and unit = ${unit.unit}
        `;
        return null;
    });
    return step.catch((e: unknown) => {
        if (e instanceof ThreadRefusedError) return 'thread-refused' as const;
        throw e;
    });
}

/** Step 3: each stamped unit whose writes have drained, in stamp order, up to the bound. */
async function expireStamped(pass: OrgPass, days: number | null): Promise<void> {
    const { deps, orgId, counts } = pass;
    const drainSecs = (deps.writeDrainMs ?? OBJECT_WRITE_DRAIN_MS) / MS_PER_SECOND;
    const units = await deps.sql<Unit[]>`
        select unit, array_agg(root_job_id::text order by root_job_id) as roots,
               bool_and(now() >= stamped_at + make_interval(secs => ${drainSecs})) as drained,
               bool_or(deleting_at is not null) as deleting
        from thread_expiry where org_id = ${orgId} and rows_deleted_at is null
        group by unit order by min(stamped_at), unit limit ${deps.threadsPerPass ?? THREADS_PER_PASS}
    `;
    for (const unit of units) {
        if (pass.expired()) {
            counts.errors.push('pass-timeout');
            return;
        }
        const outcome = await expireUnit(pass, unit, days);
        if (outcome === null) counts.expired += 1;
        else if (outcome === 'revive') {
            await deps.sql`
                delete from thread_expiry where org_id = ${orgId} and unit = ${unit.unit} and deleting_at is null
            `;
            counts.revived += 1;
        } else {
            counts.pending += 1;
            if (outcome !== 'writes-draining') {
                counts.errors.push(outcome);
                await deps.sql`
                    update thread_expiry set attempts = attempts + 1, last_error = ${outcome}
                    where org_id = ${orgId} and unit = ${unit.unit}
                `;
            }
        }
    }
}

async function expireUnit(pass: OrgPass, unit: Unit, days: number | null): Promise<RetentionError | 'revive' | null> {
    const { sql } = pass.deps;
    if (!unit.deleting) {
        // An upgrade (or an unlimited window) lifts the stamp before anything is deleted: the window covers it again.
        if (days === null || !(await unitSettled(sql, pass.orgId, unit, cutoffOf(sql, days)))) return 'revive';
        if (!unit.drained) return 'writes-draining';
        if ((await beginDeletion(pass, unit)) === 'revive') return 'revive';
    }
    const jobIds = await unitJobIds(sql, pass.orgId, unit.roots);
    return (
        (await expireSecrets(pass, jobIds)) ??
        (await expireObjects(pass, unit, jobIds)) ??
        (await expireRows(pass, unit))
    );
}

/**
 * Step 4: the org's telemetry older than the window, in bounded batches. A point's org was resolved from its session's
 * owner row, task binding or branch row (`metric_point_org_of`), so those name every session an org's point can have;
 * each is probed and deleted through `metric_point_session`. An old branch row goes unless it is the last link to a
 * session that still has points of the org, so no point is left unreachable.
 */
async function expireTelemetry(pass: OrgPass, days: number): Promise<void> {
    const { deps, orgId, counts } = pass;
    const { sql } = deps;
    const cutoff = cutoffOf(sql, days);
    const sessions = await sql<{ session_id: string }[]>`
        select s.session_id from (
            select session_id from telemetry_session_owner where org_id = ${orgId}
            union select session_id from job_execution_session where org_id = ${orgId}
            union select session_id from session_branch where org_id = ${orgId}
        ) s
        where exists (select 1 from metric_point p
                      where p.session_id = s.session_id and p.org_id = ${orgId} and p.time < ${cutoff})
        order by s.session_id limit ${POINT_BATCHES}
    `;
    let batches = POINT_BATCHES;
    for (const { session_id: session } of sessions) {
        for (let deleted = POINT_BATCH_ROWS; deleted === POINT_BATCH_ROWS && batches > 0; batches -= 1) {
            if (pass.expired()) return;
            const gone = await sql`
                delete from metric_point where (tableoid, ctid) in (
                    select tableoid, ctid from metric_point
                    where session_id = ${session} and org_id = ${orgId} and time < ${cutoff}
                    limit ${POINT_BATCH_ROWS})
            `;
            deleted = gone.count;
            counts.points += gone.count;
        }
    }
    const branches = await sql`
        delete from session_branch where ctid in (
            select b.ctid from session_branch b
            where b.org_id = ${orgId} and b.last_seen < ${cutoff}
              and (not exists (select 1 from metric_point p where p.session_id = b.session_id and p.org_id = ${orgId})
                   or exists (select 1 from telemetry_session_owner o
                              where o.session_id = b.session_id and o.org_id = ${orgId})
                   or exists (select 1 from job_execution_session e
                              where e.org_id = ${orgId} and e.session_id = b.session_id)
                   or exists (select 1 from session_branch n
                              where n.org_id = ${orgId} and n.session_id = b.session_id and n.last_seen >= ${cutoff}))
            limit ${POINT_BATCH_ROWS})
    `;
    counts.branches += branches.count;
}

/** How long a lease on an org outlives the pass that took it, should its replica be lost. */
const LEASE_MARGIN_SECS = 60;

/**
 * Takes the org for this pass in one short transaction: a lease (`claimed_until`), the org still active, and the window
 * reconciled under the plan-change lock. Null when another replica holds the lease or the org is not active. No
 * connection is held across the pass: every later step is its own short transaction, one at a time.
 */
async function claimOrg(deps: OrgRetentionDeps, orgId: string): Promise<{ days: number | null } | null> {
    const leaseSecs = (deps.passMs ?? RETENTION_PASS_MS) / MS_PER_SECOND + LEASE_MARGIN_SECS;
    return deps.sql.begin(async (tx) => {
        const [org] = await tx<{ status: string }[]>`select status from organization where id = ${orgId} for share`;
        if (org?.status !== 'active') return null;
        await waitAdvisoryXactLock(tx, planChangeLockKey(orgId));
        await tx`insert into org_retention (org_id) values (${orgId}) on conflict do nothing`;
        const [claimed] = await tx`
            update org_retention set claimed_until = now() + make_interval(secs => ${leaseSecs}), updated_at = now()
            where org_id = ${orgId} and (claimed_until is null or claimed_until < now())
            returning 1
        `;
        if (!claimed) return null;
        const target = (await planLimits(tx, orgId, deps.planDefaults)).retentionDays;
        return { days: await reconcileWindow(tx, orgId, target) };
    });
}

/** One org's pass, its steps sequential short transactions; null when another replica holds it. */
async function retainOrg(
    deps: OrgRetentionDeps,
    orgId: string,
    expired: () => boolean,
    signal: AbortSignal | undefined
): Promise<Counts | null> {
    const claimed = await claimOrg(deps, orgId);
    if (!claimed) return null;
    const { days } = claimed;
    const counts: Counts = { days, stamped: 0, expired: 0, revived: 0, pending: 0, points: 0, branches: 0, errors: [] };
    const pass: OrgPass = { deps, orgId, expired, signal, counts };
    try {
        if (days !== null) await stampEligible(pass, days);
        await expireStamped(pass, days);
        if (days !== null) await expireTelemetry(pass, days);
        await deps.sql`
            delete from thread_expiry where org_id = ${orgId}
              and rows_deleted_at < now() - make_interval(hours => ${STAMP_KEEP_HOURS})
        `;
    } finally {
        await deps.sql`update org_retention set claimed_until = null where org_id = ${orgId}`.catch(() => {
            // The lease lapses on its own; the next pass takes the org then.
        });
    }
    return counts;
}

/** One pass over every active org, least recently served first; never throws for one org's failure. */
export async function runRetentionPass(deps: OrgRetentionDeps, signal?: AbortSignal): Promise<void> {
    const log = deps.log ?? ((line: string) => console.log(line));
    const until = Date.now() + (deps.passMs ?? RETENTION_PASS_MS);
    const expired = () => signal?.aborted === true || Date.now() > until;
    // The pass reads absence: under the request role a missing setting reads no rows, so it never runs there.
    const [role] = await deps.sql<{ request: boolean }[]>`select current_user = ${REQUEST_ROLE} as request`;
    if (role?.request !== false) {
        log(`[retention] ${JSON.stringify({ event: 'retention.refused', reason: 'request-role' })}`);
        return;
    }
    const orgs = await deps.sql<{ id: string }[]>`
        select o.id from organization o left join org_retention r on r.org_id = o.id
        where o.status = 'active' order by r.updated_at nulls first, o.id
    `;
    for (const { id: orgId } of orgs) {
        if (expired()) return;
        let line: Record<string, unknown>;
        try {
            const counts = await retainOrg(deps, orgId, expired, signal);
            if (!counts) continue;
            line = { event: 'retention.pass', orgId, ...counts, errors: [...new Set(counts.errors)] };
        } catch {
            // The error text may quote a row; the line carries the closed code only.
            line = { event: 'retention.pass', orgId, errors: ['pass-failed'] };
        }
        log(`[retention] ${JSON.stringify(line)}`);
    }
}

/** The retention loop: a pass now and then every `RETENTION_INTERVAL_MS`; safe on every replica. Returns the stop. */
export function startOrgRetention(deps: OrgRetentionDeps, intervalMs = RETENTION_INTERVAL_MS): () => Promise<void> {
    return startIntervalLoop('org-retention', (signal) => runRetentionPass(deps, signal), intervalMs);
}

/** What `GET /api/org/retention` answers: the window, and a lower one with the day it applies. */
export interface RetentionView {
    days: number | null;
    pending: { days: number; effectiveAt: string } | null;
}

/**
 * The org's window as the pass will apply it: the stored row, or — before the pass first ran — the plan's target as a
 * notice starting now. Read on the request pool under the org's setting.
 */
export async function orgRetentionView(sql: Sql, orgId: string, defaults: PlanLimits): Promise<RetentionView> {
    const target = (await planLimits(sql, orgId, defaults)).retentionDays;
    const [row] = await sql<
        { effective_days: number | null; pending_days: number | null; effective_at: Date | null }[]
    >`
        select effective_days, pending_days,
               pending_from + make_interval(days => ${DOWNGRADE_NOTICE_DAYS}) as effective_at
        from org_retention where org_id = ${orgId}
    `;
    const days = row?.effective_days ?? null;
    if (target === undefined) return { days: null, pending: null };
    if (days !== null && target >= days) return { days: target, pending: null };
    if (row?.pending_days === target && row.effective_at) {
        return { days, pending: { days: target, effectiveAt: row.effective_at.toISOString() } };
    }
    const [now] = await sql<{ at: Date }[]>`select now() + make_interval(days => ${DOWNGRADE_NOTICE_DAYS}) as at`;
    return { days, pending: { days: target, effectiveAt: (now?.at ?? new Date()).toISOString() } };
}
