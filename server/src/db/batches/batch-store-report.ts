import {
    batchNextAction,
    batchUsageOf,
    emptyBlock,
    GATE_PASSED,
    holdsSlot,
    TASK_NO_PR,
    TASK_RETRY,
    TASK_RUNNING,
    VERIFY_FAILED,
    type UsageBlock,
} from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';
import { readUsageFacts } from '../../telemetry/usage-facts.js';
import { type BatchPrObservation, readObservations } from './batch-store-observation.js';
import { type BoardMergeRow, boardMergeColumns, boardMerging, readVerification } from './batch-store-rows.js';
import {
    ACCEPTANCE_PR_MERGED,
    BATCH_DRAFT,
    type BatchReport,
    type BatchReportObservation,
    type BatchReportState,
    type BatchReportTask,
    type BatchUsageUnavailable,
} from './batch-store-types.js';

/**
 * The morning report (docs/batches.md): assembled from durable rows on every read — the plan, the
 * attempts, the acceptances and the threads' jobs — so a restart cannot lose it and a merge that
 * landed after the limit expired still shows. Nothing here is written.
 */

interface ReportBatch {
    id: string;
    title: string;
    status: string;
    infra_retries: number;
    repairs: number;
    time_limit_minutes: number;
    started_at: Date | null;
    deadline_at: Date | null;
    expired_at: Date | null;
    cancelled_at: Date | null;
    completed_at: Date | null;
}

interface ReportTaskRow extends BoardMergeRow {
    key: string;
    stage_key: string;
    required: boolean;
    execution: string;
    gate: string;
    attention: string | null;
    wait_reason: string | null;
    closed_at: Date | null;
    closed_by: string | null;
    pr: string;
    root_job_id: string | null;
    completion_kind: string;
    attempts: number;
    infra_retries: number;
    repairs: number;
    manual_retries: number;
    wall_clock_ms: string;
    agent_turns: string;
    pending_question: string | null;
    pending_question_job: string | null;
}

const iso = (value: Date): string => value.toISOString();

const observationOf = (row: BatchPrObservation | undefined): BatchReportObservation | null =>
    row
        ? {
              outcome: row.outcome,
              checks: row.checks,
              mergeability: row.mergeability,
              review: row.review,
              headSha: row.headSha,
              targetSha: row.targetSha,
              stale: row.stale,
              observedAt: row.observedAt,
              error: row.error,
          }
        : null;

function stateOf(batch: ReportBatch, tasks: readonly ReportTaskRow[]): BatchReportState {
    if (batch.cancelled_at) return 'cancelled';
    if (batch.expired_at) return 'expired';
    if (batch.completed_at) return 'completed';
    const moving = tasks.some(
        (task) => holdsSlot(task.execution) || task.execution === TASK_RETRY || boardMerging(task)
    );
    return moving ? 'running' : 'parked';
}

/** Where the report's usage comes from: only a postgres telemetry source describes the board's own tasks. */
export type ReportTelemetrySource = 'postgres' | 'fixture' | 'off';

export interface ReportDeps {
    telemetrySource?: ReportTelemetrySource;
    /** Test hook: runs between the membership reads and the usage read, inside the snapshot. */
    beforeUsage?: () => Promise<void>;
    /** Test seam: the usage reader, so a failing telemetry read can be injected. */
    readFacts?: typeof readUsageFacts;
}

/** Membership, scheduling and usage are read in ONE repeatable-read snapshot, so they describe the same batch. */
export function readReport(
    sql: Sql,
    { orgId, id }: { orgId: string; id: string },
    deps: ReportDeps = {}
): Promise<BatchReport | null> {
    return sql.begin('isolation level repeatable read, read only', (tx) => assembleReport(tx, { orgId, id }, deps));
}

async function assembleReport(
    sql: TransactionSql,
    { orgId, id }: { orgId: string; id: string },
    deps: ReportDeps
): Promise<BatchReport | null> {
    const [batch] = await sql<ReportBatch[]>`
        select id, title, status, infra_retries, repairs, time_limit_minutes, started_at, deadline_at, expired_at,
               cancelled_at, completed_at
        from batch where org_id = ${orgId} and id = ${id}
    `;
    if (!batch || batch.status === BATCH_DRAFT) return null;
    const [tasks, merged, verification, observations] = await Promise.all([
        sql<ReportTaskRow[]>`
            select t.key, t.stage_key, t.required, t.execution, t.gate, t.attention, t.wait_reason, t.closed_at,
                   t.closed_by, t.pr,
                   t.root_job_id, t.completion_kind, s.policy, ${boardMergeColumns(sql)},
                   (select count(*)::int from batch_attempt a
                    where a.org_id = t.org_id and a.batch_id = t.batch_id and a.task_key = t.key) as attempts,
                   (select count(*)::int from batch_attempt a
                    where a.org_id = t.org_id and a.batch_id = t.batch_id and a.task_key = t.key
                      and a.kind = 'infra_retry') as infra_retries,
                   (select count(*)::int from batch_attempt a
                    where a.org_id = t.org_id and a.batch_id = t.batch_id and a.task_key = t.key
                      and a.kind = 'repair') as repairs,
                   (select count(*)::int from batch_attempt a
                    where a.org_id = t.org_id and a.batch_id = t.batch_id and a.task_key = t.key
                      and a.kind = 'retry') as manual_retries,
                   (select coalesce(sum(j.wall_clock_ms), 0) from job j
                    where j.org_id = t.org_id and j.root_job_id = t.root_job_id) as wall_clock_ms,
                   (select coalesce(sum(j.agent_turns), 0) from job j
                    where j.org_id = t.org_id and j.root_job_id = t.root_job_id) as agent_turns,
                   q.question_id as pending_question, q.job_id as pending_question_job
            from batch_task t
            join batch_stage s on s.org_id = t.org_id and s.batch_id = t.batch_id and s.key = t.stage_key
            -- The question a running head can still be answered: the answer route addresses the job
            -- that asked it, which after a repair or retry is not the root, and only under the live lease.
            left join lateral (
                select q.question_id, q.job_id from job_question q
                join job h on h.org_id = q.org_id and h.id = q.job_id
                where q.org_id = t.org_id and h.root_job_id = t.root_job_id and q.state = 'pending'
                  and h.status = 'running' and q.lease_token = h.lease_token and t.execution = ${TASK_RUNNING}
                order by q.asked_at desc limit 1
            ) q on true
            where t.org_id = ${orgId} and t.batch_id = ${id}
            order by s.position, t.position
        `,
        sql<{ task_key: string; pr_url: string; merged_at: Date | null; recorded_at: Date }[]>`
            select a.task_key, a.pr_url, m.merged_at, a.recorded_at
            from batch_acceptance a
            left join pr_merge m on m.org_id = a.org_id and m.repo = a.repo and m.pr_number = a.pr_number
            where a.org_id = ${orgId} and a.batch_id = ${id} and a.kind = ${ACCEPTANCE_PR_MERGED}
            order by a.recorded_at, a.task_key
        `,
        readVerification(sql, { orgId, id }),
        readObservations({ sql: sql as unknown as Sql, orgId }, id),
    ]);
    const observed = new Map(observations.map((row) => [row.taskKey, row]));
    const state = stateOf(batch, tasks);
    await deps.beforeUsage?.();
    const usage = await readBatchUsage(sql, orgId, tasks, deps);
    // A report still moving can gain usage: provisional whatever the reducer saw.
    const live = state === 'running' || state === 'parked';
    const provisional = (block: UsageBlock): UsageBlock => (live ? { ...block, provisional: true } : block);
    const rows: BatchReportTask[] = tasks.map((task) => {
        const prUrl = task.pr === TASK_NO_PR ? null : task.pr;
        return {
            key: task.key,
            stage: task.stage_key,
            required: task.required,
            execution: task.execution,
            gate: task.gate,
            attempts: task.attempts,
            infraRetries: task.infra_retries,
            repairs: task.repairs,
            manualRetries: task.manual_retries,
            remaining: {
                infraRetries: Math.max(0, batch.infra_retries - task.infra_retries),
                repairs: Math.max(0, batch.repairs - task.repairs),
            },
            attention: task.attention,
            waitReason: task.wait_reason,
            closedAt: task.closed_at ? iso(task.closed_at) : null,
            closedBy: task.closed_by,
            pr: prUrl,
            job: task.root_job_id ? `/api/jobs/${task.root_job_id}` : null,
            usage: {
                wallClockMs: Number(task.wall_clock_ms),
                agentTurns: Number(task.agent_turns),
                ...usageOfTask(usage, task, provisional),
            },
            observation: observationOf(observed.get(task.key)),
            next: batchNextAction({
                batchId: id,
                batchState: state,
                task: {
                    key: task.key,
                    required: task.required,
                    execution: task.execution,
                    gate: task.gate,
                    attention: task.attention,
                    questionJobId: task.pending_question_job,
                    questionId: task.pending_question,
                    completionKind: task.completion_kind,
                    prUrl,
                    boardMerging: boardMerging(task),
                },
            }),
        };
    });
    const mergedTasks = new Set(merged.map((row) => row.task_key));
    return {
        id: batch.id,
        title: batch.title,
        state,
        startedAt: iso(batch.started_at!),
        deadlineAt: iso(batch.deadline_at!),
        expiredAt: batch.expired_at ? iso(batch.expired_at) : null,
        cancelledAt: batch.cancelled_at ? iso(batch.cancelled_at) : null,
        completedAt: batch.completed_at ? iso(batch.completed_at) : null,
        budgets: {
            infraRetries: batch.infra_retries,
            repairs: batch.repairs,
            timeLimitMinutes: batch.time_limit_minutes,
        },
        prs: {
            merged: merged.map((row) => ({
                task: row.task_key,
                url: row.pr_url,
                mergedAt: iso(row.merged_at ?? row.recorded_at),
            })),
            open: rows
                .filter((task) => task.pr !== null && !mergedTasks.has(task.key))
                .map((task) => ({ task: task.key, url: task.pr! })),
        },
        verification,
        tasks: rows,
        latestObservationAt:
            observations
                .map((row) => row.observedAt)
                .filter((at): at is string => at !== null)
                .sort()
                .at(-1) ?? null,
        usageSnapshotAt: iso(usage.snapshotAt),
        totals: {
            accepted: rows.filter((task) => task.gate === GATE_PASSED).length,
            failed: rows.filter((task) => task.execution === 'failed').length,
            needsAttention:
                rows.filter((task) => task.attention !== null || task.waitReason !== null).length +
                verification.filter((row) => row.state === VERIFY_FAILED).length,
            infraRetries: rows.reduce((sum, task) => sum + task.infraRetries, 0),
            repairs: rows.reduce((sum, task) => sum + task.repairs, 0),
            wallClockMs: rows.reduce((sum, task) => sum + task.usage.wallClockMs, 0),
            agentTurns: rows.reduce((sum, task) => sum + task.usage.agentTurns, 0),
            tokenUsage: provisional(usage.total),
            usageUnavailableTasks: rows.filter((task) => task.usage.tokenUsageUnavailable === 'task-removed').length,
        },
    };
}

interface BatchUsage {
    snapshotAt: Date;
    /** Null when telemetry could not be read: every block is then `unavailable`. */
    tasks: ReturnType<typeof batchUsageOf>['tasks'] | null;
    total: UsageBlock;
}

/**
 * The members' usage from the shared reader and reducer, in the report's own snapshot. The read runs in
 * a savepoint: a failure rolls back to it, the scheduling rows already read stay valid, and the usage is
 * `unavailable` instead of failing the report. Only the trusted roots are asked for; `batch_attempt` rows
 * are counted as attempts and never read for tokens.
 */
async function readBatchUsage(
    tx: TransactionSql,
    orgId: string,
    tasks: readonly ReportTaskRow[],
    { telemetrySource = 'postgres', readFacts = readUsageFacts }: ReportDeps
): Promise<BatchUsage> {
    const [{ at }] = (await tx<{ at: Date }[]>`select now() as at`) as unknown as [{ at: Date }];
    const unavailable: BatchUsage = { snapshotAt: at, tasks: null, total: emptyBlock('unavailable') };
    if (telemetrySource !== 'postgres') return unavailable;
    const roots = tasks.flatMap((task) => (task.root_job_id ? [task.root_job_id] : []));
    try {
        const facts = await tx.savepoint((sp) => readFacts(sp, orgId, { taskIds: roots }));
        const { tasks: byRoot, total } = batchUsageOf(facts, roots, at);
        return { snapshotAt: at, tasks: byRoot, total };
    } catch {
        return unavailable;
    }
}

function usageOfTask(
    usage: BatchUsage,
    task: ReportTaskRow,
    provisional: (block: UsageBlock) => UsageBlock
): { tokenUsage: UsageBlock; tokenUsageUnavailable: BatchUsageUnavailable | null } {
    if (usage.tasks === null) return { tokenUsage: emptyBlock('unavailable'), tokenUsageUnavailable: 'telemetry' };
    if (task.root_job_id === null) {
        // `on delete set null`: a started task whose root is gone cannot be addressed, so it is never guessed.
        return task.attempts > 0
            ? { tokenUsage: emptyBlock('unavailable'), tokenUsageUnavailable: 'task-removed' }
            : { tokenUsage: provisional(emptyBlock('unmeasured')), tokenUsageUnavailable: null };
    }
    const found = usage.tasks.get(task.root_job_id);
    return {
        tokenUsage: provisional(found ? found.usage : emptyBlock('unmeasured')),
        tokenUsageUnavailable: null,
    };
}
