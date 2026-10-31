import type { TransactionSql } from 'postgres';
import { TERMINAL_STATUSES } from '../task-summary.js';

/**
 * Names the precondition a follow-up's or a retry's conditional insert failed on, for the thread
 * AS IT IS NOW — a thread that moved on between the CTE and this read can make the refusal name
 * the newer state, and the retry then succeeds. One read for both ops, so their refusals cannot
 * drift apart. The priority: a thread with ANY unfinished member owns the turn (`not_finished`)
 * even when a member carries done_at — retry later, or reopen the done first; a done on ANY member
 * is the thread closed (`task_done`); the author predicate is decided last, so a thread that is
 * over answers its over-ness to whoever asks before it answers `forbidden` — and forbidden is the
 * catch-all for a row that moved between the CTE and this read. A row that moved all the way to
 * deleted answers `missing` rather than dying on the read.
 */
export async function threadRefusalOf(
    tx: TransactionSql,
    orgId: string,
    id: string
): Promise<'missing' | 'task_done' | 'not_finished' | 'forbidden'> {
    const [row] = await tx<{ busy: boolean; done: boolean }[]>`
        select exists (
            select 1 from job m
            where m.org_id = ${orgId} and m.root_job_id = named.root_job_id
              and m.status not in ${tx([...TERMINAL_STATUSES])}
        ) as busy,
        exists (
            select 1 from job d
            where d.org_id = ${orgId} and d.root_job_id = named.root_job_id
              and d.done_at is not null
        ) as done
        from job named
        where named.org_id = ${orgId} and named.id = ${id}
    `;
    if (!row) return 'missing';
    if (row.busy) return 'not_finished';
    if (row.done) return 'task_done';
    return 'forbidden';
}
