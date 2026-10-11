import {
    batchTaskCommand,
    decideSchedule,
    GATE_OPEN,
    GATE_PASSED,
    holdsSlot,
    isRetryable,
    TASK_CANCELLED,
    TASK_FAILED,
    TASK_PENDING,
    TASK_QUEUED,
    TASK_RETRY,
    TASK_RUNNING,
    TASK_STOPPED,
    TASK_SUCCEEDED,
    type ScheduleDecision,
} from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';
import { insertJobInTx, retryInTx } from './job-store-actions.js';
import {
    BATCH_STARTED,
    DECISION_ADVANCE,
    DECISION_CANCEL,
    DECISION_COMPLETE,
    DECISION_LAUNCH,
    type BatchCancelRefusal,
    type BatchGateRefusal,
    type BatchGateSignal,
    type BatchProgress,
    type BatchRetryRefusal,
} from './batch-store-types.js';

/**
 * The scheduler's transactions (docs/batches.md). Every write runs under the batch row's
 * `for update` lock, so two scheduler processes, a retry and a cancel are serialized per batch; the
 * `batch_decision` key is the second fence — a decision already recorded is never made twice, so a
 * duplicate event, a restart or a fan-in completion finds the work done and writes nothing.
 */

export type StopThread = (jobId: string, stoppedBy: string | null) => Promise<unknown>;
/** The head commit of a repository's branch, or null when it cannot be resolved. */
export type RevisionOf = (repo: string, branch: string) => Promise<string | null>;

export interface ScheduleDeps {
    sql: Sql;
    orgId: string;
    stop?: StopThread | undefined;
    revisionOf?: RevisionOf | undefined;
}

/** Each pass either records a decision or ends the loop; this bounds a pathological plan, not a real one. */
const MAX_PASSES = 64;

interface LockedBatch {
    status: string;
    concurrency: number;
    started_by: string | null;
    cancelled_at: Date | null;
    cancelled_by: string | null;
    completed_at: Date | null;
}

interface StateTask {
    key: string;
    stage_key: string;
    target_key: string;
    executor: string | null;
    objective: string;
    acceptance: string;
    verification: string;
    required: boolean;
    root_job_id: string | null;
    execution: string;
    gate: string;
}

/** The batch row, locked. Everything the scheduler writes happens after this. */
async function lockBatch(tx: TransactionSql, orgId: string, id: string): Promise<LockedBatch | null> {
    const [row] = await tx<LockedBatch[]>`
        select status, concurrency, started_by, cancelled_at, cancelled_by, completed_at
        from batch where org_id = ${orgId} and id = ${id} for update
    `;
    return row ?? null;
}

/** A thread head's job status, as the task execution the scheduler branches on. */
function executionOf(status: string): string {
    switch (status) {
        case 'succeeded':
            return TASK_SUCCEEDED;
        case 'failed':
        case 'dead':
            return TASK_FAILED;
        case 'stopped':
            return TASK_STOPPED;
        case 'running':
            return TASK_RUNNING;
        default:
            return TASK_QUEUED;
    }
}

/** Folds each moving task's thread head into the task. True when any task changed. */
async function syncTasks(tx: TransactionSql, orgId: string, id: string): Promise<boolean> {
    const moving = await tx<{ key: string; execution: string; status: string | null }[]>`
        select t.key, t.execution, head.status
        from batch_task t
        left join lateral (
            select j.status from job j
            where j.org_id = t.org_id and j.root_job_id = t.root_job_id and j.review_of is null
            order by j.created_at desc, j.id desc
            limit 1
        ) head on true
        where t.org_id = ${orgId} and t.batch_id = ${id} and t.execution in (${TASK_QUEUED}, ${TASK_RUNNING})
    `;
    let changed = false;
    for (const task of moving) {
        // No head: the thread is gone (its job rows were deleted), so the attempt can never finish.
        const next = task.status === null ? TASK_FAILED : executionOf(task.status);
        if (next === task.execution) continue;
        await tx`
            update batch_task
            set execution = ${next}, wait_reason = ${task.status === null ? 'thread removed' : null}
            where org_id = ${orgId} and batch_id = ${id} and key = ${task.key}
        `;
        changed = true;
    }
    return changed;
}

/** Records a decision once. False when it was already recorded — the caller does nothing then. */
async function decide(
    tx: TransactionSql,
    at: { orgId: string; id: string },
    decision: { key: string; kind: string; subject: string | null }
): Promise<boolean> {
    const rows = await tx`
        insert into batch_decision (org_id, batch_id, key, kind, subject)
        values (${at.orgId}, ${at.id}, ${decision.key}, ${decision.kind}, ${decision.subject})
        on conflict do nothing
        returning key
    `;
    return rows.length > 0;
}

interface PassResult {
    changed: boolean;
    progress: BatchProgress;
    /** Thread roots still moving in a cancelled batch: the caller stops them after the commit. */
    toStop: string[];
    cancelledBy: string | null;
}

interface Snapshot {
    stages: string[];
    advanced: string[];
    tasks: StateTask[];
    targets: Map<string, { repo: string; branch: string }>;
    attempts: Map<string, number>;
}

type Tx = { tx: TransactionSql; orgId: string; id: string };

async function loadSnapshot({ tx, orgId, id }: Tx): Promise<Snapshot> {
    const [stages, advanced, tasks, targets, attempts] = await Promise.all([
        tx<{ key: string }[]>`
            select key from batch_stage where org_id = ${orgId} and batch_id = ${id} order by position
        `,
        tx<{ subject: string }[]>`
            select subject from batch_decision
            where org_id = ${orgId} and batch_id = ${id} and kind = ${DECISION_ADVANCE}
        `,
        tx<StateTask[]>`
            select t.key, t.stage_key, t.target_key, t.executor, t.objective, t.acceptance, t.verification,
                   t.required, t.root_job_id, t.execution, t.gate
            from batch_task t
            join batch_stage s on s.org_id = t.org_id and s.batch_id = t.batch_id and s.key = t.stage_key
            where t.org_id = ${orgId} and t.batch_id = ${id}
            order by s.position, t.position
        `,
        tx<{ key: string; repo: string; branch: string }[]>`
            select key, repo, branch from batch_target where org_id = ${orgId} and batch_id = ${id}
        `,
        tx<{ task_key: string; attempt: number }[]>`
            select task_key, max(attempt)::int as attempt from batch_attempt
            where org_id = ${orgId} and batch_id = ${id} group by task_key
        `,
    ]);
    return {
        stages: stages.map((stage) => stage.key),
        advanced: advanced.map((row) => row.subject),
        tasks,
        targets: new Map(targets.map((target) => [target.key, target])),
        attempts: new Map(attempts.map((row) => [row.task_key, row.attempt])),
    };
}

/** Records the stage advance or the batch's completion the decision names. True when one was new. */
async function settle(at: Tx, decision: ScheduleDecision, completedAt: Date | null): Promise<boolean> {
    const { tx, orgId, id } = at;
    let changed = false;
    if (decision.advance) {
        const key = `${DECISION_ADVANCE}:${decision.advance}`;
        changed = await decide(tx, at, { key, kind: DECISION_ADVANCE, subject: decision.advance });
    }
    if (decision.complete && completedAt === null) {
        if (await decide(tx, at, { key: DECISION_COMPLETE, kind: DECISION_COMPLETE, subject: null })) {
            await tx`update batch set completed_at = now(), updated_at = now() where org_id = ${orgId} and id = ${id}`;
            changed = true;
        }
    }
    return changed;
}

/**
 * One launch: the decision, then the job, then the attempt and the task's binding — all inside the
 * caller's transaction. `launched` created a job, `changed` settled a task's outcome without one,
 * `skipped` wrote nothing (the decision was already made, or the checkout is being purged).
 */
async function launch(
    at: Tx,
    deps: ScheduleDeps,
    run: { task: StateTask; snapshot: Snapshot; startedBy: string | null; revisions: Map<string, string | null> }
): Promise<'launched' | 'changed' | 'skipped'> {
    const { tx, orgId, id } = at;
    const { task, snapshot, startedBy, revisions } = run;
    const target = snapshot.targets.get(task.target_key)!;
    const attempt = (snapshot.attempts.get(task.key) ?? 0) + 1;
    const decisionKey = `${DECISION_LAUNCH}:${task.key}:${attempt}`;
    if (!(await decide(tx, at, { key: decisionKey, kind: DECISION_LAUNCH, subject: task.key }))) return 'skipped';

    const retrying = task.execution === TASK_RETRY;
    const created = retrying
        ? await retryInTx(tx, { orgId, id: task.root_job_id!, createdBy: startedBy })
        : await insertJobInTx(tx, deps, {
              command: batchTaskCommand(task),
              createdBy: startedBy,
              target: { repo: target.repo, executor: task.executor },
          });
    if (typeof created === 'string') {
        // Nothing was created, so the decision must not stand. A checkout being purged is
        // transient — the next pass tries again; a refused retry is the task's outcome.
        await tx`delete from batch_decision where org_id = ${orgId} and batch_id = ${id} and key = ${decisionKey}`;
        if (created === 'purging') return 'skipped';
        await tx`
            update batch_task set execution = ${TASK_FAILED}, wait_reason = ${`retry refused: ${created}`}
            where org_id = ${orgId} and batch_id = ${id} and key = ${task.key}
        `;
        return 'changed';
    }
    await tx`
        insert into batch_attempt (org_id, batch_id, task_key, attempt, kind, job_id, repo, source_branch,
                                   source_revision)
        values (${orgId}, ${id}, ${task.key}, ${attempt}, ${retrying ? 'retry' : 'launch'}, ${created.id},
                ${target.repo}, ${target.branch}, ${revisions.get(revisionKey(target)) ?? null})
    `;
    // A retry stays a row of the thread it already has; only a first launch binds one.
    await tx`
        update batch_task
        set root_job_id = coalesce(root_job_id, ${created.id}), execution = ${TASK_QUEUED},
            gate = ${GATE_OPEN}, wait_reason = null
        where org_id = ${orgId} and batch_id = ${id} and key = ${task.key}
    `;
    return 'launched';
}

async function pass(deps: ScheduleDeps, id: string, revisions: Map<string, string | null>): Promise<PassResult | null> {
    const { sql, orgId } = deps;
    return sql.begin(async (tx) => {
        const batch = await lockBatch(tx, orgId, id);
        if (!batch || batch.status !== BATCH_STARTED) return null;
        const at = { tx, orgId, id };
        let changed = await syncTasks(tx, orgId, id);

        const snapshot = await loadSnapshot(at);
        const cancelled = batch.cancelled_at !== null;
        const decision = decideFor(batch, snapshot);
        const result = {
            progress: {
                complete: batch.completed_at !== null || decision.complete,
                cancelled,
                active: decision.active,
            },
            // Moving threads of a cancelled batch: the caller stops them once this commits.
            toStop: cancelled ? movingRoots(snapshot) : [],
            cancelledBy: batch.cancelled_by,
        };
        if (batch.completed_at !== null) return { ...result, changed };

        changed = (await settle(at, decision, batch.completed_at)) || changed;
        const launched = await launchAll(at, deps, decision, { snapshot, startedBy: batch.started_by, revisions });
        result.progress.active += launched.created;
        return { ...result, changed: changed || launched.changed };
    });
}

const movingRoots = (snapshot: Snapshot): string[] =>
    snapshot.tasks.filter((t) => holdsSlot(t.execution) && t.root_job_id).map((t) => t.root_job_id!);

async function launchAll(
    at: Tx,
    deps: ScheduleDeps,
    decision: ScheduleDecision,
    run: { snapshot: Snapshot; startedBy: string | null; revisions: Map<string, string | null> }
): Promise<{ created: number; changed: boolean }> {
    let created = 0;
    let changed = false;
    for (const key of decision.launch) {
        const task = run.snapshot.tasks.find((candidate) => candidate.key === key)!;
        const outcome = await launch(at, deps, { task, ...run });
        if (outcome === 'skipped') continue;
        changed = true;
        if (outcome === 'launched') created += 1;
    }
    return { created, changed };
}

function decideFor(batch: LockedBatch, snapshot: Snapshot): ScheduleDecision {
    return decideSchedule({
        stages: snapshot.stages,
        tasks: snapshot.tasks.map((task) => ({
            key: task.key,
            stage: task.stage_key,
            required: task.required,
            execution: task.execution,
            gate: task.gate,
        })),
        concurrency: batch.concurrency,
        advanced: snapshot.advanced,
        cancelled: batch.cancelled_at !== null,
    });
}

const revisionKey = (target: { repo: string; branch: string }) => `${target.repo}@${target.branch}`;

/** The revisions of every target, resolved once per reconcile and only when a task is waiting to launch. */
async function resolveRevisions(deps: ScheduleDeps, id: string): Promise<Map<string, string | null>> {
    const revisions = new Map<string, string | null>();
    if (!deps.revisionOf) return revisions;
    const { sql, orgId } = deps;
    const [waiting] = await sql`
        select 1 from batch_task
        where org_id = ${orgId} and batch_id = ${id} and execution in (${TASK_PENDING}, ${TASK_RETRY}) limit 1
    `;
    if (!waiting) return revisions;
    const targets = await sql<{ repo: string; branch: string }[]>`
        select repo, branch from batch_target where org_id = ${orgId} and batch_id = ${id} and branch is not null
    `;
    await Promise.all(
        targets.map(async (target) => {
            // An unresolvable revision is recorded as unknown; it never blocks the launch.
            revisions.set(revisionKey(target), await deps.revisionOf!(target.repo, target.branch).catch(() => null));
        })
    );
    return revisions;
}

/** The head job of a thread, the row a stop addresses. */
async function headOf(sql: Sql, orgId: string, rootJobId: string): Promise<string | null> {
    const [row] = await sql<{ id: string }[]>`
        select id from job
        where org_id = ${orgId} and root_job_id = ${rootJobId} and review_of is null
        order by created_at desc, id desc limit 1
    `;
    return row?.id ?? null;
}

export async function reconcileBatch(deps: ScheduleDeps, id: string): Promise<BatchProgress | null> {
    const revisions = await resolveRevisions(deps, id);
    let last: PassResult | null = null;
    for (let i = 0; i < MAX_PASSES; i += 1) {
        const next = await pass(deps, id, revisions);
        if (!next) return null;
        last = next;
        if (!next.changed) break;
    }
    if (!last) return null;
    if (last.toStop.length > 0 && deps.stop) {
        // Cancellation settles active tasks through the job store's own stop, after the fence
        // committed: nothing launches behind it, and a repeat pass stops whatever is still moving.
        for (const root of last.toStop) {
            const head = await headOf(deps.sql, deps.orgId, root);
            if (head) await deps.stop(head, last.cancelledBy);
        }
        const settled = await pass(deps, id, revisions);
        if (settled) return settled.progress;
    }
    return last.progress;
}

export async function reconcileOpenBatches(deps: ScheduleDeps): Promise<void> {
    const open = await deps.sql<{ id: string }[]>`
        select b.id from batch b
        where b.org_id = ${deps.orgId} and b.status = ${BATCH_STARTED} and b.completed_at is null
          and (b.cancelled_at is null or exists (
              select 1 from batch_task t
              where t.org_id = b.org_id and t.batch_id = b.id and t.execution in (${TASK_QUEUED}, ${TASK_RUNNING})
          ))
        order by b.started_at, b.id
    `;
    for (const batch of open) {
        try {
            await reconcileBatch(deps, batch.id);
        } catch (e) {
            console.error(`[batches] reconcile of ${batch.id} failed: ${(e as Error).message}`);
        }
    }
}

export async function cancelBatch(
    deps: ScheduleDeps,
    id: string,
    cancelledBy: string | null
): Promise<{ result: 'ok'; replayed: boolean } | BatchCancelRefusal> {
    const { sql, orgId } = deps;
    const fenced = await sql.begin(async (tx) => {
        const batch = await lockBatch(tx, orgId, id);
        if (!batch) return { result: 'missing' as const };
        if (batch.status !== BATCH_STARTED) return { result: 'not_started' as const };
        if (batch.cancelled_at !== null) return { result: 'ok' as const, replayed: true };
        if (batch.completed_at !== null) return { result: 'finished' as const };
        await tx`
            update batch set cancelled_at = now(), cancelled_by = ${cancelledBy}, updated_at = now()
            where org_id = ${orgId} and id = ${id}
        `;
        await decide(tx, { orgId, id }, { key: DECISION_CANCEL, kind: DECISION_CANCEL, subject: null });
        // Work that never launched is cancelled outright; moving work is settled by reconcile's stop.
        await tx`
            update batch_task set execution = ${TASK_CANCELLED}
            where org_id = ${orgId} and batch_id = ${id} and execution in (${TASK_PENDING}, ${TASK_RETRY})
        `;
        return { result: 'ok' as const, replayed: false };
    });
    // A replay settles too: it finishes a cancel whose first caller died between fence and stop.
    if (fenced.result === 'ok') await reconcileBatch(deps, id);
    return fenced;
}

export async function retryBatchTask(
    deps: ScheduleDeps,
    id: string,
    taskKey: string
): Promise<{ result: 'ok' } | BatchRetryRefusal> {
    const { sql, orgId } = deps;
    const queued = await sql.begin(async (tx): Promise<{ result: 'ok' } | BatchRetryRefusal> => {
        const batch = await lockBatch(tx, orgId, id);
        if (!batch) return { result: 'missing' };
        if (batch.status !== BATCH_STARTED) return { result: 'not_started' };
        if (batch.cancelled_at !== null) return { result: 'cancelled' };
        const [task] = await tx<{ stage_key: string; root_job_id: string | null; execution: string; gate: string }[]>`
            select stage_key, root_job_id, execution, gate from batch_task
            where org_id = ${orgId} and batch_id = ${id} and key = ${taskKey}
        `;
        if (!task) return { result: 'no_task' };
        // A repeat of an accepted retry is the same request, answered the same way.
        if (task.execution === TASK_RETRY) return { result: 'ok' };
        // The thread is what a retry re-runs; a task that never launched has none, and a settled
        // stage's outcome is history.
        const [advanced] = await tx`
            select 1 from batch_decision
            where org_id = ${orgId} and batch_id = ${id} and key = ${`${DECISION_ADVANCE}:${task.stage_key}`}
        `;
        if (advanced || !task.root_job_id || !isRetryable(task)) return { result: 'not_retryable' };
        await tx`
            update batch_task set execution = ${TASK_RETRY}, wait_reason = null
            where org_id = ${orgId} and batch_id = ${id} and key = ${taskKey}
        `;
        return { result: 'ok' };
    });
    if (queued.result === 'ok') await reconcileBatch(deps, id);
    return queued;
}

export async function signalBatchGate(
    deps: ScheduleDeps,
    id: string,
    taskKey: string,
    gate: BatchGateSignal
): Promise<{ result: 'ok' } | BatchGateRefusal> {
    const { sql, orgId } = deps;
    const recorded = await sql.begin(async (tx): Promise<{ result: 'ok' } | BatchGateRefusal> => {
        const batch = await lockBatch(tx, orgId, id);
        if (!batch) return { result: 'missing' };
        if (batch.status !== BATCH_STARTED) return { result: 'not_started' };
        if (batch.cancelled_at !== null) return { result: 'cancelled' };
        // The judged result must be the current one: fold the thread's head in first, so a run that
        // just finished is seen as finished.
        await syncTasks(tx, orgId, id);
        const [task] = await tx<{ stage_key: string; execution: string; gate: string }[]>`
            select stage_key, execution, gate from batch_task
            where org_id = ${orgId} and batch_id = ${id} and key = ${taskKey}
        `;
        if (!task) return { result: 'no_task' };
        const [advanced] = await tx`
            select 1 from batch_decision
            where org_id = ${orgId} and batch_id = ${id} and key = ${`${DECISION_ADVANCE}:${task.stage_key}`}
        `;
        if (advanced) return { result: 'settled' };
        // A signal judges a finished run's result. One that arrives while the task is moving (or
        // pending, or failed) is about an earlier attempt, or about nothing, and would accept the
        // next result unevaluated. A repeat of the signal already recorded is the same request.
        if (task.execution !== TASK_SUCCEEDED) return { result: 'not_ready' };
        if (task.gate === gate) return { result: 'ok' };
        await tx`
            update batch_task set gate = ${gate}
            where org_id = ${orgId} and batch_id = ${id} and key = ${taskKey}
        `;
        return { result: 'ok' };
    });
    if (recorded.result === 'ok' && gate === GATE_PASSED) await reconcileBatch(deps, id);
    return recorded;
}
