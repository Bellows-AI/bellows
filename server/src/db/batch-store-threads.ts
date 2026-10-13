import { holdsSlot, TASK_CANCELLED } from '@factory-ai/core';
import type { Sql } from 'postgres';
import type { Tx } from './batch-store-repair.js';
import { BATCH_STARTED } from './batch-store-types.js';
import { TERMINAL_STATUSES } from './task-summary.js';

export interface OpenThread {
    root: string;
    status: string;
    closed_at: Date | null;
    closed_by: string | null;
}

/** A thread root the scheduler acts on after its pass commits, and the person it acts for. */
export interface ThreadAct {
    root: string;
    by: string | null;
}

interface BatchEnds {
    completed_at: Date | null;
    cancelled_at: Date | null;
    expired_at: Date | null;
    threads_closed_at: Date | null;
}

/**
 * The threads not yet done that the board closes: every one of a batch that ended (completed,
 * cancelled or expired), and a force-closed task's in a live one. The head is the run Done stamps.
 * An ended batch with none left is stamped `threads_closed_at` (068), so later sweeps skip it.
 */
export async function openThreads({ tx, orgId, id }: Tx, batch: BatchEnds): Promise<OpenThread[]> {
    const ended = batch.completed_at !== null || batch.cancelled_at !== null || batch.expired_at !== null;
    const open = await tx<OpenThread[]>`
        select t.root_job_id as root, head.status, t.closed_at, t.closed_by
        from batch_task t
        join lateral (
            select j.status, j.done_at from job j
            where j.org_id = t.org_id and j.root_job_id = t.root_job_id and j.review_of is null
            order by j.created_at desc, j.id desc
            limit 1
        ) head on true
        where t.org_id = ${orgId} and t.batch_id = ${id} and head.done_at is null
          and (${ended} or t.closed_at is not null)
    `;
    if (ended && open.length === 0 && batch.threads_closed_at === null) {
        await tx`update batch set threads_closed_at = now() where org_id = ${orgId} and id = ${id}`;
    }
    return open;
}

/**
 * A force-closed task still moving: it keeps its execution, and so its concurrency slot, until the
 * stopped run settles, then is cancelled — never recovered, its wait reason left as the force-close
 * wrote it. True when the task changed.
 */
export async function syncClosed(at: Tx, task: { key: string; execution: string }, next: string): Promise<boolean> {
    if (next === task.execution) return false;
    await at.tx`
        update batch_task set execution = ${holdsSlot(next) ? next : TASK_CANCELLED}
        where org_id = ${at.orgId} and batch_id = ${at.id} and key = ${task.key}
    `;
    return true;
}

/**
 * The started batches a sweep reconciles: every one until all its threads are closed
 * (`threads_closed_at`, 068) — a live one schedules, a fenced one stops what still moves, an ended
 * one closes its threads, at boot too — after which the partial index skips it for good.
 */
export async function openBatches(sql: Sql, orgId: string): Promise<{ id: string }[]> {
    return sql<{ id: string }[]>`
        select b.id from batch b
        where b.org_id = ${orgId} and b.status = ${BATCH_STARTED} and b.threads_closed_at is null
        order by b.started_at, b.id
    `;
}

/**
 * What a pass does to threads once it commits: stop the moving ones of a fenced batch (`fenced`)
 * and of force-closed tasks, and close the settled ones `openThreads` found — as the person who
 * force-closed the task, else the batch's canceller.
 */
export function threadActs(
    open: readonly OpenThread[],
    fenced: { roots: readonly string[]; by: string | null }
): { toStop: ThreadAct[]; toClose: ThreadAct[] } {
    const settled = (thread: OpenThread) => (TERMINAL_STATUSES as readonly string[]).includes(thread.status);
    const forced = open.filter(
        (thread) => thread.closed_at !== null && !settled(thread) && !fenced.roots.includes(thread.root)
    );
    return {
        toStop: [
            ...fenced.roots.map((root) => ({ root, by: fenced.by })),
            ...forced.map((thread) => ({ root: thread.root, by: thread.closed_by })),
        ],
        toClose: open
            .filter(settled)
            .map((thread) => ({ root: thread.root, by: thread.closed_at === null ? fenced.by : thread.closed_by })),
    };
}

/**
 * After a pass commits: stop its moving threads, pass again to fold the stops in, then close the
 * settled ones. Returns the last pass's progress.
 */
export async function settleThreads<Progress>(
    deps: {
        sql: Sql;
        orgId: string;
        stop?: ((jobId: string, by: string | null) => Promise<unknown>) | undefined;
        close?: ((jobId: string, by: string | null) => Promise<unknown>) | undefined;
    },
    last: { toStop: ThreadAct[]; toClose: ThreadAct[]; progress: Progress },
    repass: () => Promise<{ toClose: ThreadAct[]; progress: Progress } | null>
): Promise<Progress> {
    let final: { toClose: ThreadAct[]; progress: Progress } = last;
    if (last.toStop.length > 0 && deps.stop) {
        // Cancellation settles active tasks through the job store's own stop, after the fence
        // committed: nothing launches behind it, and a repeat pass stops whatever is still moving.
        await actOnHeads(deps, last.toStop, deps.stop);
        final = (await repass()) ?? final;
    }
    // An ended batch's threads, and a force-closed task's, leave the review lists through the job
    // store's own Done, which queues the worktree reclaim. A head still moving is closed by a later
    // pass, once its stop lands.
    if (deps.close) await actOnHeads(deps, final.toClose, deps.close);
    return final.progress;
}

/** Calls the job store's stop or Done on each thread's head job, the row both address. */
async function actOnHeads(
    { sql, orgId }: { sql: Sql; orgId: string },
    acts: readonly ThreadAct[],
    act: (jobId: string, by: string | null) => Promise<unknown>
): Promise<void> {
    for (const { root, by } of acts) {
        const [head] = await sql<{ id: string }[]>`
            select id from job
            where org_id = ${orgId} and root_job_id = ${root} and review_of is null
            order by created_at desc, id desc limit 1
        `;
        if (head) await act(head.id, by);
    }
}
