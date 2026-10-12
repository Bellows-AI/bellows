import {
    AUTOMERGE,
    ATTENTION_QUESTION,
    ATTENTION_REFUSED,
    attentionWaitReason,
    BATCH_COMPLETION_ACCEPTED,
    batchTaskCommand,
    classifyTaskFailure,
    decideSchedule,
    GATE_OPEN,
    GATE_PASSED,
    holdsSlot,
    isRetryable,
    planRecovery,
    RECOVERY_INFRA,
    RECOVERY_REPAIR,
    TASK_CANCELLED,
    TASK_FAILED,
    TASK_PENDING,
    TASK_QUEUED,
    TASK_RETRY,
    TASK_RUNNING,
    TASK_STOPPED,
    TASK_SUCCEEDED,
    VERIFY_PASSED,
    type ScheduleDecision,
} from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';
import { judgeGates } from './batch-store-gates.js';
import { recoverObserved, withdrawRepair } from './batch-store-observed.js';
import { decide, failedAttentionReason, recoveriesUsed, repairInTx, type Tx } from './batch-store-repair.js';
import { insertJobInTx, retryInTx } from './job-store-actions.js';
import {
    ACCEPTANCE_ACCEPTED,
    BATCH_STARTED,
    DECISION_ADVANCE,
    DECISION_CANCEL,
    DECISION_COMPLETE,
    DECISION_EXPIRE,
    DECISION_LAUNCH,
    type BatchCancelRefusal,
    type BatchAcceptRefusal,
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
    /** The clock the deadline and the retry backoff are read against; absent is the wall clock. Tests move it. */
    now?: (() => Date) | undefined;
}

const nowOf = (deps: ScheduleDeps): Date => (deps.now ? deps.now() : new Date());

/** Each pass either records a decision or ends the loop; this bounds a pathological plan, not a real one. */
const MAX_PASSES = 64;

interface LockedBatch {
    status: string;
    concurrency: number;
    started_by: string | null;
    cancelled_at: Date | null;
    cancelled_by: string | null;
    completed_at: Date | null;
    infra_retries: number;
    repairs: number;
    deadline_at: Date | null;
    expired_at: Date | null;
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
    recovery: string | null;
    not_before: Date | null;
}

/** The batch row, locked. Everything the scheduler writes happens after this. */
async function lockBatch(tx: TransactionSql, orgId: string, id: string): Promise<LockedBatch | null> {
    const [row] = await tx<LockedBatch[]>`
        select status, concurrency, started_by, cancelled_at, cancelled_by, completed_at, infra_retries, repairs,
               deadline_at, expired_at
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

interface MovingTask {
    key: string;
    execution: string;
    attention: string | null;
    head_id: string | null;
    status: string | null;
    failure_kind: string | null;
    /** What lies under a gate, publish or helper failure (065, issue #581). */
    failure_cause: string | null;
    /** The newest question still waiting for an answer, which only a running job can receive. */
    pending_question: string | null;
    /** A question the thread asked that no person ever answered: pending, or expired unanswered. */
    unanswered: boolean;
}

/**
 * A run that just failed: classify it and either queue the matching automatic recovery or mark the
 * task as needing a person. Runs once per failure — the task was moving until this transition —
 * and never in a fenced (cancelled or expired) batch, where cancellation wins over a new recovery.
 */
async function recoverFailed(at: Tx, run: { batch: LockedBatch; task: MovingTask; now: Date }): Promise<void> {
    const { tx, orgId, id } = at;
    const { batch, task, now } = run;
    const plan = planRecovery({
        failure: classifyTaskFailure({
            status: task.status!,
            failureKind: task.failure_kind,
            failureCause: task.failure_cause,
            unansweredQuestion: task.unanswered,
        }),
        used: await recoveriesUsed(at, task.key),
        budgets: { infraRetries: batch.infra_retries, repairs: batch.repairs },
    });
    if (plan.action === 'attention') {
        await tx`
            update batch_task
            set execution = ${TASK_FAILED}, attention = ${plan.reason},
                wait_reason = ${failedAttentionReason(plan.reason, task)}
            where org_id = ${orgId} and batch_id = ${id} and key = ${task.key}
        `;
        return;
    }
    const notBefore = plan.action === RECOVERY_INFRA ? new Date(now.getTime() + plan.delayMs) : null;
    // The wait reason stays null: a task waiting out a backoff or a repair is moving, not parked.
    await tx`
        update batch_task
        set execution = ${TASK_RETRY}, recovery = ${plan.action}, not_before = ${notBefore}, attention = null,
            wait_reason = null
        where org_id = ${orgId} and batch_id = ${id} and key = ${task.key}
    `;
}

/** Folds each moving task's thread head into the task. True when any task changed. */
async function syncTasks(at: Tx, run: { batch: LockedBatch; now: Date }): Promise<boolean> {
    const { tx, orgId, id } = at;
    const { batch, now } = run;
    const moving = await tx<MovingTask[]>`
        select t.key, t.execution, t.attention, head.id as head_id, head.status, head.failure_kind, head.failure_cause,
               (select q.question_id from job_question q
                where q.org_id = t.org_id and q.job_id = head.id and q.state = 'pending'
                  and q.lease_token = head.lease_token
                order by q.asked_at desc limit 1) as pending_question,
               exists (select 1 from job_question q
                       where q.org_id = t.org_id and q.job_id = head.id and q.attempt = head.attempts
                         and q.state in ('pending', 'expired'))
                   as unanswered
        from batch_task t
        left join lateral (
            select j.id, j.status, j.failure_kind, j.failure_cause, j.lease_token, j.attempts from job j
            where j.org_id = t.org_id and j.root_job_id = t.root_job_id and j.review_of is null
            order by j.created_at desc, j.id desc
            limit 1
        ) head on true
        where t.org_id = ${orgId} and t.batch_id = ${id} and t.execution in (${TASK_QUEUED}, ${TASK_RUNNING})
    `;
    const fenced = batch.cancelled_at !== null || batch.expired_at !== null || batch.completed_at !== null;
    let changed = false;
    for (const task of moving) {
        // No head: the thread is gone (its job rows were deleted), so the attempt can never finish.
        const next = task.status === null ? TASK_FAILED : executionOf(task.status);
        if (next === task.execution) {
            changed = (await syncQuestion(at, task)) || changed;
            continue;
        }
        changed = true;
        if (next === TASK_FAILED && task.status !== null && !fenced) {
            await recoverFailed(at, { batch, task, now });
            continue;
        }
        await tx`
            update batch_task
            set execution = ${next}, attention = null,
                wait_reason = ${task.status === null ? 'thread removed' : null}
            where org_id = ${orgId} and batch_id = ${id} and key = ${task.key}
        `;
    }
    return changed;
}

/**
 * A running task whose agent asked a question needs a person to answer it: surfaced as attention
 * with the question's id, cleared once it is answered. The board never answers, and never extends
 * an expired question — a run that dies with one unanswered is classified as needing attention.
 */
async function syncQuestion(at: Tx, task: MovingTask): Promise<boolean> {
    const { tx, orgId, id } = at;
    if (task.execution !== TASK_RUNNING) return false;
    const asking = task.pending_question !== null;
    if (asking && task.attention !== ATTENTION_QUESTION) {
        await tx`
            update batch_task
            set attention = ${ATTENTION_QUESTION},
                wait_reason = ${attentionWaitReason(ATTENTION_QUESTION, {
                    jobId: task.head_id!,
                    detail: `question ${task.pending_question}`,
                })}
            where org_id = ${orgId} and batch_id = ${id} and key = ${task.key}
        `;
        return true;
    }
    if (!asking && task.attention === ATTENTION_QUESTION) {
        await tx`
            update batch_task set attention = null, wait_reason = null
            where org_id = ${orgId} and batch_id = ${id} and key = ${task.key}
        `;
        return true;
    }
    return false;
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
    /** Automerge stages whose merged result has not passed its combined verification (064). */
    unverified: string[];
    tasks: StateTask[];
    targets: Map<string, { repo: string; branch: string }>;
    attempts: Map<string, number>;
}

async function loadSnapshot({ tx, orgId, id }: Tx): Promise<Snapshot> {
    const [stages, advanced, unverified, tasks, targets, attempts] = await Promise.all([
        tx<{ key: string }[]>`
            select key from batch_stage where org_id = ${orgId} and batch_id = ${id} order by position
        `,
        tx<{ subject: string }[]>`
            select subject from batch_decision
            where org_id = ${orgId} and batch_id = ${id} and kind = ${DECISION_ADVANCE}
        `,
        tx<{ key: string }[]>`
            select s.key from batch_stage s
            where s.org_id = ${orgId} and s.batch_id = ${id} and s.policy = ${AUTOMERGE}
              and not exists (
                  select 1 from batch_stage_verification v
                  where v.org_id = s.org_id and v.batch_id = s.batch_id and v.stage_key = s.key
                    and v.state = ${VERIFY_PASSED}
              )
        `,
        tx<StateTask[]>`
            select t.key, t.stage_key, t.target_key, t.executor, t.objective, t.acceptance, t.verification,
                   t.required, t.root_job_id, t.execution, t.gate, t.recovery, t.not_before
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
        unverified: unverified.map((row) => row.key),
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
    const kind: string = retrying ? (task.recovery ?? 'retry') : 'launch';
    const created =
        kind === RECOVERY_REPAIR
            ? await repairInTx(tx, { orgId, batchId: id, task, startedBy })
            : retrying
              ? await retryInTx(tx, { orgId, id: task.root_job_id!, createdBy: startedBy })
              : await insertJobInTx(tx, deps, {
                    command: batchTaskCommand(task),
                    createdBy: startedBy,
                    target: { repo: target.repo, executor: task.executor },
                });
    if (typeof created === 'string') {
        // Nothing was created, so the decision must not stand. A checkout being purged is
        // transient — the next pass tries again; a refused retry is the task's outcome, and one
        // that needs a person.
        await tx`delete from batch_decision where org_id = ${orgId} and batch_id = ${id} and key = ${decisionKey}`;
        if (created === 'purging') return 'skipped';
        if (created === 'superseded') {
            await withdrawRepair(at, { key: task.key, attempt: attempt - 1 });
            return 'changed';
        }
        const refusal = `retry refused: ${created}`;
        await tx`
            update batch_task
            set execution = ${TASK_FAILED}, attention = ${ATTENTION_REFUSED}, recovery = null, not_before = null,
                wait_reason = ${attentionWaitReason(ATTENTION_REFUSED, { jobId: task.root_job_id ?? '', detail: refusal })}
            where org_id = ${orgId} and batch_id = ${id} and key = ${task.key}
        `;
        return 'changed';
    }
    await tx`
        insert into batch_attempt (org_id, batch_id, task_key, attempt, kind, job_id, repo, source_branch,
                                   source_revision)
        values (${orgId}, ${id}, ${task.key}, ${attempt}, ${kind}, ${created.id},
                ${target.repo}, ${target.branch}, ${revisions.get(revisionKey(target)) ?? null})
    `;
    // A new attempt invalidates what was observed of the last: its failures are history, and the
    // checks of whatever head it pushes are awaited afresh (063). An in-flight read loses its lease.
    await tx`
        delete from batch_pr_observation
        where org_id = ${orgId} and batch_id = ${id} and task_key = ${task.key}
    `;
    // A retry stays a row of the thread it already has; only a first launch binds one. The gate
    // reopens: a recovery's result is judged afresh, and a merge before this attempt began never counts.
    await tx`
        update batch_task
        set root_job_id = coalesce(root_job_id, ${created.id}), execution = ${TASK_QUEUED},
            gate = ${GATE_OPEN}, wait_reason = null, attention = null, recovery = null, not_before = null
        where org_id = ${orgId} and batch_id = ${id} and key = ${task.key}
    `;
    return 'launched';
}

/** What a pass reports: the long-poll's progress and the moving threads of a fenced batch to stop once it commits. */
function resultOf(batch: LockedBatch, snapshot: Snapshot, decision: ScheduleDecision) {
    const cancelled = batch.cancelled_at !== null;
    const expired = batch.expired_at !== null;
    return {
        progress: {
            complete: batch.completed_at !== null || decision.complete,
            cancelled,
            expired,
            active: decision.active,
            waiting: snapshot.tasks.filter((task) => task.execution === TASK_RETRY).length,
        },
        toStop: cancelled || expired ? movingRoots(snapshot) : [],
        cancelledBy: batch.cancelled_by,
    };
}

async function pass(deps: ScheduleDeps, id: string, revisions: Map<string, string | null>): Promise<PassResult | null> {
    const { sql, orgId } = deps;
    return sql.begin(async (tx) => {
        const batch = await lockBatch(tx, orgId, id);
        if (!batch || batch.status !== BATCH_STARTED) return null;
        const at = { tx, orgId, id };
        const now = nowOf(deps);
        // The time limit is a fence like cancel: it commits first, so nothing recovers, launches or
        // advances behind it.
        let changed = await expire(at, batch, now);
        changed = (await syncTasks(at, { batch, now })) || changed;
        changed = (await judge(at, batch)) || changed;

        const snapshot = await loadSnapshot(at);
        const decision = decideFor(batch, snapshot, now);
        const result = resultOf(batch, snapshot, decision);
        if (batch.completed_at !== null) return { ...result, changed };

        changed = (await settle(at, decision, batch.completed_at)) || changed;
        const launched = await launchAll(at, deps, decision, { snapshot, startedBy: batch.started_by, revisions });
        result.progress.active += launched.created;
        return { ...result, changed: changed || launched.changed };
    });
}

/**
 * The gates, then what each task's PR shows after a successful run (issue #581). The cancellation
 * fence: a merge observed after cancel or completion passes nothing. An expired batch still records
 * merges that land, so the report shows them, but recovers nothing.
 */
async function judge(at: Tx, batch: LockedBatch): Promise<boolean> {
    if (batch.cancelled_at !== null || batch.completed_at !== null) return false;
    const changed = await judgeGates(at.tx, at.orgId, at.id);
    if (batch.expired_at !== null) return changed;
    const budgets = { infraRetries: batch.infra_retries, repairs: batch.repairs };
    return (await recoverObserved(at, budgets)) || changed;
}

/**
 * Fences a batch whose deadline passed: stamps `expired_at`, records the decision once and cancels
 * work that never launched. Moving work is stopped after the commit, as a cancel's is. A batch
 * that already finished or was cancelled has nothing to expire.
 */
async function expire(at: Tx, batch: LockedBatch, now: Date): Promise<boolean> {
    const { tx, orgId, id } = at;
    const due = batch.deadline_at !== null && batch.deadline_at.getTime() <= now.getTime();
    if (!due || batch.expired_at !== null || batch.cancelled_at !== null || batch.completed_at !== null) return false;
    if (!(await decide(tx, at, { key: DECISION_EXPIRE, kind: DECISION_EXPIRE, subject: null }))) return false;
    await tx`update batch set expired_at = ${now}, updated_at = now() where org_id = ${orgId} and id = ${id}`;
    batch.expired_at = now;
    await tx`
        update batch_task
        set execution = ${TASK_CANCELLED}, recovery = null, not_before = null,
            wait_reason = 'the batch time limit expired before this task ran'
        where org_id = ${orgId} and batch_id = ${id} and execution in (${TASK_PENDING}, ${TASK_RETRY})
    `;
    return true;
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

function decideFor(batch: LockedBatch, snapshot: Snapshot, now: Date): ScheduleDecision {
    return decideSchedule({
        stages: snapshot.stages,
        tasks: snapshot.tasks.map((task) => ({
            key: task.key,
            stage: task.stage_key,
            required: task.required,
            execution: task.execution,
            gate: task.gate,
            notBefore: task.not_before ? task.not_before.getTime() : null,
        })),
        concurrency: batch.concurrency,
        advanced: snapshot.advanced,
        unverified: snapshot.unverified,
        cancelled: batch.cancelled_at !== null,
        expired: batch.expired_at !== null,
        now: now.getTime(),
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
          and ((b.cancelled_at is null and b.expired_at is null) or exists (
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
            update batch_task set execution = ${TASK_CANCELLED}, recovery = null, not_before = null
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
        if (batch.expired_at !== null) return { result: 'expired' };
        const [task] = await tx<{ stage_key: string; root_job_id: string | null; execution: string; gate: string }[]>`
            select stage_key, root_job_id, execution, gate from batch_task
            where org_id = ${orgId} and batch_id = ${id} and key = ${taskKey}
        `;
        if (!task) return { result: 'no_task' };
        if (task.execution === TASK_RETRY) {
            // A person's retry of an automatic recovery waiting out its backoff launches it now,
            // as a manual retry that spends no budget; a repeat of an accepted retry is the same request.
            await tx`
                update batch_task set recovery = null, not_before = null
                where org_id = ${orgId} and batch_id = ${id} and key = ${taskKey}
            `;
            return { result: 'ok' };
        }
        // The thread is what a retry re-runs; a task that never launched has none, and a settled
        // stage's outcome is history.
        const [advanced] = await tx`
            select 1 from batch_decision
            where org_id = ${orgId} and batch_id = ${id} and key = ${`${DECISION_ADVANCE}:${task.stage_key}`}
        `;
        if (advanced || !task.root_job_id || !isRetryable(task)) return { result: 'not_retryable' };
        await tx`
            update batch_task
            set execution = ${TASK_RETRY}, wait_reason = null, attention = null, recovery = null, not_before = null
            where org_id = ${orgId} and batch_id = ${id} and key = ${taskKey}
        `;
        return { result: 'ok' };
    });
    if (queued.result === 'ok') await reconcileBatch(deps, id);
    return queued;
}

interface AcceptTarget {
    stage_key: string;
    completion_kind: string;
    execution: string;
    gate: string;
    attempt: number | null;
}

/** What stands between a person and accepting the task: a refusal, `replay` for a repeat, or the attempt to accept. */
async function acceptCheck(
    at: Tx,
    taskKey: string
): Promise<BatchAcceptRefusal | { result: 'replay' } | { result: 'accept'; attempt: number }> {
    const { tx, orgId, id } = at;
    const [task] = await tx<AcceptTarget[]>`
        select t.stage_key, t.completion_kind, t.execution, t.gate,
               (select max(attempt)::int from batch_attempt
                where org_id = t.org_id and batch_id = t.batch_id and task_key = t.key) as attempt
        from batch_task t
        where t.org_id = ${orgId} and t.batch_id = ${id} and t.key = ${taskKey}
    `;
    if (!task) return { result: 'no_task' };
    if (task.completion_kind !== BATCH_COMPLETION_ACCEPTED) return { result: 'not_acceptable' };
    // A repeat of an acceptance already recorded is the same request, answered the same way.
    if (task.gate === GATE_PASSED) return { result: 'replay' };
    const [advanced] = await tx`
        select 1 from batch_decision
        where org_id = ${orgId} and batch_id = ${id} and key = ${`${DECISION_ADVANCE}:${task.stage_key}`}
    `;
    if (advanced) return { result: 'settled' };
    // Accepting judges a finished run's result; one that is moving, pending or failed is about
    // an earlier attempt, or about nothing.
    if (task.execution !== TASK_SUCCEEDED || task.attempt === null) return { result: 'not_ready' };
    return { result: 'accept', attempt: task.attempt };
}

export async function acceptBatchTask(
    deps: ScheduleDeps,
    id: string,
    taskKey: string,
    acceptedBy: string | null
): Promise<{ result: 'ok' } | BatchAcceptRefusal> {
    const { sql, orgId } = deps;
    const recorded = await sql.begin(async (tx): Promise<{ result: 'ok' } | BatchAcceptRefusal> => {
        const batch = await lockBatch(tx, orgId, id);
        if (!batch) return { result: 'missing' };
        if (batch.status !== BATCH_STARTED) return { result: 'not_started' };
        if (batch.cancelled_at !== null) return { result: 'cancelled' };
        // The accepted result must be the current one: fold the thread's head in first, so a run
        // that just finished is seen as finished.
        await syncTasks({ tx, orgId, id }, { batch, now: nowOf(deps) });
        const check = await acceptCheck({ tx, orgId, id }, taskKey);
        if (check.result === 'replay') return { result: 'ok' };
        if (check.result !== 'accept') return check;
        await tx`
            insert into batch_acceptance (org_id, batch_id, task_key, attempt, kind, accepted_by)
            values (${orgId}, ${id}, ${taskKey}, ${check.attempt}, ${ACCEPTANCE_ACCEPTED}, ${acceptedBy})
            on conflict do nothing
        `;
        await tx`
            update batch_task set gate = ${GATE_PASSED}, wait_reason = null
            where org_id = ${orgId} and batch_id = ${id} and key = ${taskKey}
        `;
        return { result: 'ok' };
    });
    if (recorded.result === 'ok') await reconcileBatch(deps, id);
    return recorded;
}
