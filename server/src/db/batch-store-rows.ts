import type { BatchPlan, ResolvedBatchPlan } from '@factory-ai/core';
import { BATCH_COMPLETION_ACCEPTED, BATCH_COMPLETION_PR, type ExecutorScope } from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';
import {
    BATCH_LIST_LIMIT,
    DECISION_ADVANCE,
    BATCH_STARTED,
    type BatchRecord,
    type BatchStageVerification,
    type BatchStatus,
    type BatchSummary,
    type BatchWriteRefusal,
} from './batch-store-types.js';

/** The SQL behind `batch-store.ts`: row shapes, the plan's rows in and out, and the freeze writes. */

interface BatchRow {
    id: string;
    status: BatchStatus;
    version: number;
    plan_version: number;
    title: string;
    default_target: string | null;
    executor: string | null;
    executor_scope: ExecutorScope | null;
    policy: BatchPlan['policy'];
    concurrency: number;
    infra_retries: number;
    repairs: number;
    time_limit_minutes: number;
    created_by: string | null;
    started_by: string | null;
    created_at: Date;
    updated_at: Date;
    started_at: Date | null;
    cancelled_at: Date | null;
    completed_at: Date | null;
    deadline_at: Date | null;
    expired_at: Date | null;
}

interface TargetRow {
    key: string;
    repo: string;
    branch: string | null;
}

interface StageRow {
    key: string;
    policy: BatchPlan['policy'] | null;
}

interface TaskRow {
    key: string;
    stage_key: string;
    target_key: string | null;
    executor: string | null;
    executor_scope: ExecutorScope | null;
    objective: string;
    acceptance: string;
    verification: string;
    required: boolean;
    completion_kind: string;
    completion_condition: string | null;
    root_job_id: string | null;
    execution: string;
    pr: string;
    gate: string;
    wait_reason: string | null;
    attention: string | null;
    closed_at: Date | null;
    attempt: number;
}

/** The plan's rows are addressed by the org and the batch, always together. */
export interface BatchAddress {
    orgId: string;
    id: string;
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function planOf(batch: BatchRow, targets: TargetRow[], stages: StageRow[], tasks: TaskRow[]): BatchPlan {
    return {
        planVersion: batch.plan_version as BatchPlan['planVersion'],
        title: batch.title,
        targets: targets.map((t) => ({ key: t.key, repo: t.repo, ...(t.branch === null ? {} : { branch: t.branch }) })),
        ...(batch.default_target === null ? {} : { defaultTarget: batch.default_target }),
        ...(batch.executor === null ? {} : { executor: batch.executor }),
        ...(batch.executor_scope === null ? {} : { executorScope: batch.executor_scope }),
        policy: batch.policy,
        concurrency: batch.concurrency,
        infraRetries: batch.infra_retries,
        repairs: batch.repairs,
        timeLimitMinutes: batch.time_limit_minutes,
        stages: stages.map((stage) => ({
            key: stage.key,
            ...(stage.policy === null ? {} : { policy: stage.policy }),
            tasks: tasks
                .filter((task) => task.stage_key === stage.key)
                .map((task) => ({
                    key: task.key,
                    ...(task.target_key === null ? {} : { target: task.target_key }),
                    ...(task.executor === null ? {} : { executor: task.executor }),
                    ...(task.executor_scope === null ? {} : { executorScope: task.executor_scope }),
                    objective: task.objective,
                    acceptance: task.acceptance,
                    verification: task.verification,
                    required: task.required,
                    completion:
                        task.completion_kind === BATCH_COMPLETION_ACCEPTED
                            ? { kind: BATCH_COMPLETION_ACCEPTED, condition: task.completion_condition! }
                            : { kind: BATCH_COMPLETION_PR },
                })),
        })),
    };
}

/** Each automerge stage's combined verification, in stage order; shared by the record and the report. */
export async function readVerification(sql: Sql, { orgId, id }: BatchAddress): Promise<BatchStageVerification[]> {
    const rows = await sql<
        { stage_key: string; state: string; detail: string | null; head_sha: string | null; checked_at: Date }[]
    >`
        select v.stage_key, v.state, v.detail, v.head_sha, v.checked_at
        from batch_stage_verification v
        join batch_stage s on s.org_id = v.org_id and s.batch_id = v.batch_id and s.key = v.stage_key
        where v.org_id = ${orgId} and v.batch_id = ${id}
        order by s.position
    `;
    return rows.map((row) => ({
        stage: row.stage_key,
        state: row.state,
        detail: row.detail,
        headSha: row.head_sha,
        checkedAt: row.checked_at.toISOString(),
    }));
}

/** The batch with its plan and per-task state, or null when this org has no such batch. */
export async function readRecord(sql: Sql, { orgId, id }: BatchAddress): Promise<BatchRecord | null> {
    const [batch] = await sql<BatchRow[]>`
        select id, status, version, plan_version, title, default_target, executor, executor_scope, policy, concurrency,
               infra_retries, repairs, time_limit_minutes, created_by, started_by, created_at, updated_at,
               started_at, cancelled_at, completed_at, deadline_at, expired_at
        from batch where org_id = ${orgId} and id = ${id}
    `;
    if (!batch) return null;
    const [targets, stages, tasks, advanced, verification] = await Promise.all([
        sql<TargetRow[]>`
            select key, repo, branch from batch_target
            where org_id = ${orgId} and batch_id = ${id} order by position
        `,
        sql<StageRow[]>`
            select key, policy from batch_stage
            where org_id = ${orgId} and batch_id = ${id} order by position
        `,
        sql<TaskRow[]>`
            select t.key, t.stage_key, t.target_key, t.executor, t.executor_scope, t.objective, t.acceptance,
                   t.verification,
                   t.required, t.completion_kind, t.completion_condition, t.root_job_id, t.execution,
                   t.pr, t.gate, t.wait_reason, t.attention, t.closed_at,
                   (select coalesce(max(a.attempt), 0)::int from batch_attempt a
                    where a.org_id = t.org_id and a.batch_id = t.batch_id and a.task_key = t.key) as attempt
            from batch_task t
            join batch_stage s on s.org_id = t.org_id and s.batch_id = t.batch_id and s.key = t.stage_key
            where t.org_id = ${orgId} and t.batch_id = ${id}
            order by s.position, t.position
        `,
        sql<{ subject: string }[]>`
            select subject from batch_decision
            where org_id = ${orgId} and batch_id = ${id} and kind = ${DECISION_ADVANCE}
        `,
        readVerification(sql, { orgId, id }),
    ]);
    const done = new Set(advanced.map((row) => row.subject));
    return {
        id: batch.id,
        status: batch.status,
        version: batch.version,
        createdBy: batch.created_by,
        startedBy: batch.started_by,
        createdAt: batch.created_at.toISOString(),
        updatedAt: batch.updated_at.toISOString(),
        startedAt: iso(batch.started_at),
        cancelledAt: iso(batch.cancelled_at),
        completedAt: iso(batch.completed_at),
        deadlineAt: iso(batch.deadline_at),
        expiredAt: iso(batch.expired_at),
        activeStage:
            batch.status === BATCH_STARTED ? (stages.find((stage) => !done.has(stage.key))?.key ?? null) : null,
        plan: planOf(batch, targets, stages, tasks),
        tasks: tasks.map((task) => ({
            key: task.key,
            stage: task.stage_key,
            execution: task.execution,
            pr: task.pr,
            gate: task.gate,
            waitReason: task.wait_reason,
            attention: task.attention,
            closedAt: task.closed_at ? task.closed_at.toISOString() : null,
            rootJobId: task.root_job_id,
            attempt: task.attempt,
        })),
        verification,
    };
}

export async function listSummaries(sql: Sql, orgId: string, rootJobId?: string): Promise<BatchSummary[]> {
    const rows = await sql<(BatchRow & { task_count: number })[]>`
        select b.id, b.status, b.version, b.title, b.created_by, b.created_at, b.updated_at, b.started_at,
               b.cancelled_at, b.completed_at,
               (select count(*)::int from batch_task t where t.org_id = b.org_id and t.batch_id = b.id)
                   as task_count
        from batch b
        where b.org_id = ${orgId}
          and (${rootJobId ?? null}::uuid is null or exists (
              select 1 from batch_task t
              where t.org_id = b.org_id and t.batch_id = b.id and t.root_job_id = ${rootJobId ?? null}::uuid))
        order by b.created_at desc, b.id
        limit ${BATCH_LIST_LIMIT}
    `;
    return rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        version: row.version,
        taskCount: row.task_count,
        createdBy: row.created_by,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        startedAt: iso(row.started_at),
        cancelledAt: iso(row.cancelled_at),
        completedAt: iso(row.completed_at),
    }));
}

/** The plan's targets, stages and tasks, written under an existing batch row. */
export async function insertChildren(tx: TransactionSql, { orgId, id }: BatchAddress, plan: BatchPlan): Promise<void> {
    const targets = plan.targets.map((target, position) => ({
        org_id: orgId,
        batch_id: id,
        key: target.key,
        position,
        repo: target.repo,
        branch: target.branch ?? null,
    }));
    await tx`insert into batch_target ${tx(targets, 'org_id', 'batch_id', 'key', 'position', 'repo', 'branch')}`;
    const stages = plan.stages.map((stage, position) => ({
        org_id: orgId,
        batch_id: id,
        key: stage.key,
        position,
        policy: stage.policy ?? null,
    }));
    await tx`insert into batch_stage ${tx(stages, 'org_id', 'batch_id', 'key', 'position', 'policy')}`;
    const tasks = plan.stages.flatMap((stage) =>
        stage.tasks.map((task, position) => ({
            org_id: orgId,
            batch_id: id,
            key: task.key,
            stage_key: stage.key,
            position,
            target_key: task.target ?? null,
            executor: task.executor ?? null,
            executor_scope: task.executorScope ?? null,
            objective: task.objective,
            acceptance: task.acceptance,
            verification: task.verification,
            required: task.required,
            completion_kind: task.completion.kind,
            completion_condition: task.completion.kind === BATCH_COMPLETION_PR ? null : task.completion.condition,
        }))
    );
    await tx`
        insert into batch_task ${tx(
            tasks,
            'org_id',
            'batch_id',
            'key',
            'stage_key',
            'position',
            'target_key',
            'executor',
            'executor_scope',
            'objective',
            'acceptance',
            'verification',
            'required',
            'completion_kind',
            'completion_condition'
        )}
    `;
}

export async function deleteChildren(tx: TransactionSql, { orgId, id }: BatchAddress): Promise<void> {
    await tx`delete from batch_task where org_id = ${orgId} and batch_id = ${id}`;
    await tx`delete from batch_stage where org_id = ${orgId} and batch_id = ${id}`;
    await tx`delete from batch_target where org_id = ${orgId} and batch_id = ${id}`;
}

/** Writes the resolved plan into the draft's own rows: branches, task targets, executors and scopes, stage policies. */
export async function writeResolved(
    tx: TransactionSql,
    { orgId, id }: BatchAddress,
    plan: ResolvedBatchPlan
): Promise<void> {
    for (const target of plan.targets) {
        await tx`
            update batch_target set branch = ${target.branch}
            where org_id = ${orgId} and batch_id = ${id} and key = ${target.key}
        `;
    }
    for (const stage of plan.stages) {
        await tx`
            update batch_stage set policy = ${stage.policy}
            where org_id = ${orgId} and batch_id = ${id} and key = ${stage.key}
        `;
        for (const task of stage.tasks) {
            await tx`
                update batch_task
                set target_key = ${task.target}, executor = ${task.executor},
                    executor_scope = ${task.executor === null ? null : task.executorScope}
                where org_id = ${orgId} and batch_id = ${id} and key = ${task.key}
            `;
        }
    }
}

/** Why a conditional draft write matched nothing. */
export async function refusalOf(tx: TransactionSql, { orgId, id }: BatchAddress): Promise<BatchWriteRefusal> {
    const [row] = await tx<{ status: BatchStatus; version: number }[]>`
        select status, version from batch where org_id = ${orgId} and id = ${id}
    `;
    if (!row) return { result: 'missing' };
    if (row.status === BATCH_STARTED) return { result: 'started' };
    return { result: 'stale', version: row.version };
}
