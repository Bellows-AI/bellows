import {
    BATCH_COMPLETION_ACCEPTED,
    BATCH_COMPLETION_PR,
    BATCH_PLAN_VERSION,
    DEFAULT_BATCH_CONCURRENCY,
    DEFAULT_BATCH_INFRA_RETRIES,
    DEFAULT_BATCH_REPAIRS,
    DEFAULT_BATCH_TIME_LIMIT_MINUTES,
    DEFAULT_BATCH_POLICY,
    isAccepted,
    isRetryable,
    ORG_SCOPE,
    TASK_CANCELLED,
    TASK_FAILED,
    TASK_NO_PR,
    TASK_PENDING,
    TASK_QUEUED,
    TASK_RETRY,
    TASK_RUNNING,
    TASK_STOPPED,
    TASK_SUCCEEDED,
    VERIFY_FAILED,
    VERIFY_PENDING,
    type BatchNextAction,
    type BatchPlan,
    type BatchPolicy,
    type BatchStage,
    type BatchTarget,
    type BatchTask,
} from '@factory-ai/core';

/**
 * The batch pages' pure model: the draft's immutable edits, what a started batch's tasks mean to a
 * person, and the one verdict a batch wears. Nothing here decides what the board decides — the
 * plan's rules are `validateBatchPlan`'s, scheduling, retry and the gate are the server's; this
 * only names them for a reader (docs/batches.md).
 */

/** The board's lifecycle `status`; the end states are its stamps, cancelled outranking expired. */
export const BATCH_DRAFT = 'draft';
export const BATCH_RUNNING = 'running';
export const BATCH_COMPLETED = 'completed';
export const BATCH_CANCELLED = 'cancelled';
export const BATCH_EXPIRED = 'expired';

/** A task's runtime state, as the board's read model carries it. */
export interface BatchTaskState {
    key: string;
    stage: string;
    execution: string;
    pr: string;
    gate: string;
    waitReason: string | null;
    rootJobId: string | null;
    attempt: number;
}

export interface BatchSummary {
    id: string;
    title: string;
    status: string;
    version: number;
    taskCount: number;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    cancelledAt: string | null;
    completedAt: string | null;
    expiredAt: string | null;
}

/** An automerge stage's combined verification, as the record carries it (server `BatchStageVerification`). */
export interface StageVerificationState {
    stage: string;
    state: string;
    detail: string | null;
    headSha: string | null;
    checkedAt: string;
}

export interface BatchRecord extends Omit<BatchSummary, 'title' | 'taskCount'> {
    startedBy: string | null;
    activeStage: string | null;
    plan: BatchPlan;
    tasks: BatchTaskState[];
    verification: StageVerificationState[];
}

/** The subset of `GET /api/batches/:id/report` the monitor reads: each task's `next`, the board's word on who acts. */
export interface BatchReportView {
    state: string;
    /** `execution` and `attempts` name the run each `next` was judged on (server `BatchReportTask`). */
    tasks: { key: string; execution: string; attempts: number; next: BatchNextAction }[];
}

/** The report as the model reads it; null until the first one lands. */
export type BatchNextOf = Pick<BatchReportView, 'tasks'> | null;

export type BatchVerdict = 'draft' | 'running' | 'needs_attention' | 'completed' | 'cancelled' | 'expired';

export const VERDICT_LABEL: Record<BatchVerdict, string> = {
    draft: 'Draft',
    running: 'Running',
    needs_attention: 'Needs attention',
    completed: 'Completed',
    cancelled: 'Cancelled',
    expired: 'Expired',
};

/** The pill skin per verdict; the label beside it always renders, so color never carries the state alone. */
export const VERDICT_PILL: Record<BatchVerdict, string> = {
    draft: 'pill',
    running: 'pill pill-ok',
    needs_attention: 'pill pill-accent',
    completed: 'pill pill-done',
    cancelled: 'pill pill-warn',
    expired: 'pill pill-warn',
};

const PARKED_EXECUTIONS: readonly string[] = [TASK_FAILED, TASK_STOPPED];

const NEXT_WAIT = 'wait';

/**
 * The board still acting on a task — moving work, or an automerge PR it is merging or repairing. The
 * record and the report are read apart, so an entry judged on another run than the record's speaks
 * for nothing: the record's own rule decides until the report catches up.
 */
export function boardActing(task: BatchTaskState, report: BatchNextOf): boolean {
    const entry = report?.tasks.find((candidate) => candidate.key === task.key);
    return entry?.next.action === NEXT_WAIT && entry.execution === task.execution && entry.attempts === task.attempt;
}

/**
 * A task nothing will move without a person: a failed or stopped run, or a gate waiting on one —
 * unless the report's `next` says the board is on it (the CLI's `needsPerson`, cli/src/batch.ts).
 */
export const needsPerson = (task: BatchTaskState, report: BatchNextOf): boolean =>
    (task.waitReason !== null || PARKED_EXECUTIONS.includes(task.execution)) && !boardActing(task, report);

/** A merged stage whose target failed its checks: the board holds the next stage until a person fixes it on GitHub. */
export const verificationFailed = (row: StageVerificationState): boolean => row.state === VERIFY_FAILED;

/** A verification the board is still judging; it needs no one. */
export const verificationPending = (row: StageVerificationState): boolean => row.state === VERIFY_PENDING;

/** Where a batch stands: every status but running is the board's own; a running one is read off the tasks. */
export function batchVerdict(
    batch: Pick<BatchRecord, 'status' | 'tasks' | 'verification'>,
    report: BatchNextOf
): BatchVerdict {
    if (batch.status === BATCH_DRAFT) return 'draft';
    if (batch.status === BATCH_CANCELLED) return 'cancelled';
    if (batch.status === BATCH_EXPIRED) return 'expired';
    if (batch.status === BATCH_COMPLETED) return 'completed';
    return batch.tasks.some((task) => needsPerson(task, report)) || batch.verification.some(verificationFailed)
        ? 'needs_attention'
        : 'running';
}

/** A list row's verdict: the summary carries no tasks, so a started batch not yet finished reads as running. */
export function summaryVerdict(batch: Pick<BatchSummary, 'status'>): BatchVerdict {
    return batchVerdict({ ...batch, tasks: [], verification: [] }, null);
}

export type TaskTone = 'ok' | 'warn' | 'bad' | 'done' | 'accent';

/** A task's state as one label and one tone; the label always renders (design-system.md, status color). */
export function taskStateLabel(task: BatchTaskState, report: BatchNextOf): { label: string; tone: TaskTone } {
    if (isAccepted(task)) return { label: 'Accepted', tone: 'done' };
    switch (task.execution) {
        case TASK_RUNNING:
            return { label: 'Running', tone: 'ok' };
        case TASK_QUEUED:
            return { label: 'Queued', tone: 'ok' };
        case TASK_RETRY:
            return { label: 'Retry queued', tone: 'ok' };
        case TASK_FAILED:
            return { label: 'Failed', tone: 'bad' };
        case TASK_STOPPED:
            return { label: 'Stopped', tone: 'bad' };
        case TASK_CANCELLED:
            return { label: 'Cancelled', tone: 'warn' };
        case TASK_SUCCEEDED:
            return boardActing(task, report)
                ? { label: 'Board merging', tone: 'ok' }
                : { label: 'Waiting for you', tone: 'accent' };
        default:
            return { label: 'Not started', tone: 'warn' };
    }
}

/** Retry is the active stage's, and only while the batch still schedules; the server judges the rest. */
export const canRetry = (batch: BatchRecord, task: BatchTaskState): boolean =>
    batch.status === BATCH_RUNNING && task.stage === batch.activeStage && isRetryable(task);

/** A run that finished but was not accepted is re-run as a repair; a failed or stopped one is retried. */
export const retryLabel = (task: BatchTaskState): string =>
    PARKED_EXECUTIONS.includes(task.execution) ? 'Retry' : 'Run again';

export const effectivePolicy = (plan: BatchPlan, stage: BatchStage): BatchPolicy => stage.policy ?? plan.policy;

/** A value a stage or task takes from the batch, or sets itself — shown before launch, so nothing is a surprise. */
export interface Inherited {
    value: string;
    source: 'inherited' | 'overridden';
}

export const stagePolicyOf = (plan: BatchPlan, stage: BatchStage): Inherited => ({
    value: effectivePolicy(plan, stage),
    source: stage.policy === undefined ? 'inherited' : 'overridden',
});

/** An executor by name, an organization profile marked as such; `fallback` when none is named. */
export const executorLabel = (name: string | undefined, scope: string | undefined, fallback: string): string =>
    name === undefined ? fallback : `${name}${scope === ORG_SCOPE ? ' (organization)' : ''}`;

/** The task's executor as it will launch: an organization profile names its scope. */
export const taskExecutorOf = (plan: BatchPlan, task: BatchTask): Inherited => ({
    value: executorLabel(
        task.executor ?? plan.executor,
        task.executorScope ?? plan.executorScope,
        'your default executor'
    ),
    source: task.executor === undefined && task.executorScope === undefined ? 'inherited' : 'overridden',
});

export const taskTargetOf = (plan: BatchPlan, task: BatchTask): Inherited => ({
    value: task.target ?? plan.defaultTarget ?? '',
    source: task.target === undefined ? 'inherited' : 'overridden',
});

export const targetLabel = (plan: BatchPlan, key: string): string => {
    const target = plan.targets.find((candidate) => candidate.key === key);
    return target ? `${target.repo}@${target.branch ?? 'default branch'}` : key;
};

/**
 * What a person must do for a task's gate, in words: the PR to review and merge, or the condition
 * to confirm. Null when nothing waits on a person for it.
 */
export function gateInstruction(task: BatchTask, state: BatchTaskState, report: BatchNextOf): string | null {
    if (state.waitReason === null || state.execution !== TASK_SUCCEEDED || boardActing(state, report)) return null;
    if (task.completion.kind === BATCH_COMPLETION_ACCEPTED) {
        return `Check that ${task.completion.condition} holds, then record your acceptance.`;
    }
    return state.pr === TASK_NO_PR
        ? 'The run finished without a pull request. Run it again, or open and merge one yourself.'
        : 'Review and merge the pull request.';
}

/** The sentence that says a human gate resumes by itself, shown wherever a gate is. */
export const GATE_RESUMES_AUTOMATICALLY =
    'Nothing to press: once every required task of the stage has its pull request merged or its acceptance recorded, the next stage starts automatically.';

export interface StageView {
    stage: BatchStage;
    tasks: { task: BatchTask; state: BatchTaskState | undefined }[];
}

/** The plan's stages in order, each task beside its runtime state. */
export function stageViews(batch: Pick<BatchRecord, 'plan' | 'tasks'>): StageView[] {
    return batch.plan.stages.map((stage) => ({
        stage,
        tasks: stage.tasks.map((task) => ({
            task,
            state: batch.tasks.find((candidate) => candidate.key === task.key),
        })),
    }));
}

export interface MorningReport {
    accepted: number;
    needsYou: number;
    notStarted: number;
    total: number;
}

/** The batch at a glance: what landed, what waits on a person, what has not begun. Counts only. */
export function morningReport(batch: Pick<BatchRecord, 'tasks' | 'verification'>, report: BatchNextOf): MorningReport {
    return {
        accepted: batch.tasks.filter(isAccepted).length,
        needsYou:
            batch.tasks.filter((task) => !isAccepted(task) && needsPerson(task, report)).length +
            batch.verification.filter(verificationFailed).length,
        notStarted: batch.tasks.filter((task) => task.execution === TASK_PENDING).length,
        total: batch.tasks.length,
    };
}

/* ── the draft's edits: each returns a new plan, never mutates ── */

const TASK_BLANK: Omit<BatchTask, 'key'> = {
    objective: '',
    acceptance: '',
    verification: '',
    required: true,
    completion: { kind: BATCH_COMPLETION_PR },
};

/** `prefix-N` with the smallest N not taken: keys are stable identifiers, so the editor mints them. */
export function nextKey(prefix: string, taken: readonly string[]): string {
    let n = 1;
    while (taken.includes(`${prefix}-${n}`)) n += 1;
    return `${prefix}-${n}`;
}

const allTaskKeys = (plan: BatchPlan): string[] => plan.stages.flatMap((stage) => stage.tasks.map((task) => task.key));

const blankTask = (plan: BatchPlan): BatchTask => ({ key: nextKey('task', allTaskKeys(plan)), ...TASK_BLANK });

export function blankPlan(repo: string): BatchPlan {
    const target: BatchTarget = { key: 'main', repo };
    return {
        planVersion: BATCH_PLAN_VERSION,
        title: '',
        targets: [target],
        defaultTarget: target.key,
        policy: DEFAULT_BATCH_POLICY,
        concurrency: DEFAULT_BATCH_CONCURRENCY,
        infraRetries: DEFAULT_BATCH_INFRA_RETRIES,
        repairs: DEFAULT_BATCH_REPAIRS,
        timeLimitMinutes: DEFAULT_BATCH_TIME_LIMIT_MINUTES,
        stages: [{ key: 'stage-1', tasks: [{ key: 'task-1', ...TASK_BLANK }] }],
    };
}

export function addStage(plan: BatchPlan): BatchPlan {
    const key = nextKey(
        'stage',
        plan.stages.map((stage) => stage.key)
    );
    return { ...plan, stages: [...plan.stages, { key, tasks: [blankTask(plan)] }] };
}

export function removeStage(plan: BatchPlan, stageKey: string): BatchPlan {
    return { ...plan, stages: plan.stages.filter((stage) => stage.key !== stageKey) };
}

export function moveStage(plan: BatchPlan, stageKey: string, by: -1 | 1): BatchPlan {
    const from = plan.stages.findIndex((stage) => stage.key === stageKey);
    const to = from + by;
    if (from < 0 || to < 0 || to >= plan.stages.length) return plan;
    const stages = [...plan.stages];
    const [moved] = stages.splice(from, 1);
    stages.splice(to, 0, moved!);
    return { ...plan, stages };
}

export function updateStage(plan: BatchPlan, stageKey: string, change: (stage: BatchStage) => BatchStage): BatchPlan {
    return { ...plan, stages: plan.stages.map((stage) => (stage.key === stageKey ? change(stage) : stage)) };
}

export function addTask(plan: BatchPlan, stageKey: string): BatchPlan {
    const task = blankTask(plan);
    return updateStage(plan, stageKey, (stage) => ({ ...stage, tasks: [...stage.tasks, task] }));
}

export function removeTask(plan: BatchPlan, taskKey: string): BatchPlan {
    return {
        ...plan,
        stages: plan.stages.map((stage) => ({ ...stage, tasks: stage.tasks.filter((task) => task.key !== taskKey) })),
    };
}

export function updateTask(plan: BatchPlan, taskKey: string, change: (task: BatchTask) => BatchTask): BatchPlan {
    return {
        ...plan,
        stages: plan.stages.map((stage) => ({
            ...stage,
            tasks: stage.tasks.map((task) => (task.key === taskKey ? change(task) : task)),
        })),
    };
}

/** An optional field set, or dropped when empty: the plan refuses an empty string, so "unset" is absence. */
export function withOptional<T extends object>(value: T, field: keyof T, next: string): T {
    const rest = { ...value } as Record<string, unknown>;
    delete rest[field as string];
    return (next === '' ? rest : { ...rest, [field]: next }) as T;
}
