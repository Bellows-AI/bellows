/**
 * The SQL fragments the job store shares across files: the wall-tick bank and the two rules every
 * thread read and write repeats, "this run is terminal" and "this thread was marked Done". A new
 * query takes them from here; `server/test/job-store-sql-fragments.test.ts` fails a second copy.
 */

import type { Sql, Fragment, TransactionSql } from 'postgres';
import { TERMINAL_STATUSES } from '../task-summary.js';

/** `<column> in ('succeeded','failed','dead','stopped')`, as a literal so a partial index on it still matches. */
export function terminalFragment(q: Sql | TransactionSql, column = 'status'): Fragment {
    const literal = TERMINAL_STATUSES.map((status) => `'${status}'`).join(',');
    return q`${q.unsafe(column)} in (${q.unsafe(literal)})`;
}

/** `<alias>.done_at is not null`: the thread carries a Done stamp. */
export function doneFragment(q: Sql | TransactionSql, alias?: string): Fragment {
    return q`${q.unsafe(alias === undefined ? 'done_at' : `${alias}.done_at`)} is not null`;
}

/** The caller owns the thread: an admin verdict, or the thread root's `execution_user_id` is the caller (null-safe). Reads `job.root_job_id`. */
export function authorOwnsFragment(
    q: Sql | TransactionSql,
    who: { orgId: string; admin: boolean; createdBy: string | null }
): Fragment {
    const { orgId, admin, createdBy } = who;
    return q`(${admin}::boolean or (
        select r.execution_user_id from job r where r.org_id = ${orgId} and r.id = job.root_job_id
    ) is not distinct from ${createdBy})`;
}

/** No member of the thread is unfinished and none carries a Done stamp: a follow-up or retry may be queued into it. */
export function threadIdleFragment(q: Sql | TransactionSql, orgId: string, rootJobIdColumn: string): Fragment {
    return q`not exists (
        select 1 from job m
        where m.org_id = ${orgId} and m.root_job_id = ${q.unsafe(rootJobIdColumn)}
          and not ${terminalFragment(q, 'm.status')}
    )
    and not exists (
        select 1 from job d
        where d.org_id = ${orgId} and d.root_job_id = ${q.unsafe(rootJobIdColumn)}
          and ${doneFragment(q, 'd')}
    )`;
}

/**
 * The wall-clock banking, shared by every settle point that ends (or supersedes) an executed
 * segment: add the segment `started_at → now()` to what the row has banked. Used inside
 * transactions, like the claim's sameThreadRunning fragment. The SET expression reads the
 * PRE-update row, so it composes beside `started_at = now()` in the claim — the superseded
 * segment is banked in the same statement that resets the stamp, which is the only moment it
 * can be. `greatest` ignores nulls, so a row that never started measures zero, and a clock never
 * runs backwards.
 *
 * The segment is banked less the time it spent waiting for an answer (issue 738): the segment's
 * own questions (its `lease_token`), each clipped to `started_at → now()` — a question still
 * pending waits up to the settle — and merged where they overlap, since the run waits while ANY
 * question is pending (`driver/src/run-deadline.ts`).
 */
export function wallTickFragment(sql: Sql): Fragment {
    return sql`coalesce(wall_clock_ms, 0) + greatest(0,
        (extract(epoch from (now() - started_at)) * 1000)::bigint - (
            select coalesce((extract(epoch from sum(e - s)) * 1000)::bigint, 0) from (
                select min(s) as s, max(e) as e from (
                    select s, e, sum(fresh) over (order by s, e rows unbounded preceding) as island from (
                        select s, e, case when s <= max(e) over (order by s, e rows between unbounded preceding
                                                                 and 1 preceding) then 0 else 1 end as fresh
                        from (
                            select greatest(q.asked_at, job.started_at) as s,
                                   least(coalesce(q.answered_at, now()), now()) as e
                            from job_question q
                            where q.org_id = job.org_id and q.job_id = job.id and q.lease_token = job.lease_token
                        ) waits
                        where e > s
                    ) flagged
                ) islands
                group by island
            ) merged
        ))`;
}
