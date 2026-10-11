/**
 * The batch scheduler's pure decisions (docs/batches.md): which tasks of the active stage launch
 * now, and whether the stage is settled so the next may begin. No I/O — the board's transactions
 * read the state, ask here, and write the answer under the batch's row lock. Stage order is the
 * only dependency model, so the active stage is the first one without an advance decision.
 */

/** A task's execution state: the thread head's status folded to what the scheduler branches on. */
export const TASK_PENDING = 'pending';
/** A retry the board has accepted and not yet launched — it waits for a slot like a first launch. */
export const TASK_RETRY = 'retry';
export const TASK_QUEUED = 'queued';
export const TASK_RUNNING = 'running';
export const TASK_SUCCEEDED = 'succeeded';
export const TASK_FAILED = 'failed';
export const TASK_STOPPED = 'stopped';
export const TASK_CANCELLED = 'cancelled';
export type BatchTaskExecution =
    | typeof TASK_PENDING
    | typeof TASK_RETRY
    | typeof TASK_QUEUED
    | typeof TASK_RUNNING
    | typeof TASK_SUCCEEDED
    | typeof TASK_FAILED
    | typeof TASK_STOPPED
    | typeof TASK_CANCELLED;

/** The durable completion gate, set by an explicit signal and never by a run's own verdict. */
export const GATE_OPEN = 'open';
export const GATE_PASSED = 'passed';
export const GATE_FAILED = 'failed';
export type BatchGate = typeof GATE_OPEN | typeof GATE_PASSED | typeof GATE_FAILED;

/** Executions that hold a concurrency slot: a launched run, or a retry/repair about to be one. */
const ACTIVE: readonly string[] = [TASK_QUEUED, TASK_RUNNING];
const WAITING: readonly string[] = [TASK_PENDING, TASK_RETRY];

export const holdsSlot = (execution: string): boolean => ACTIVE.includes(execution);

export interface ScheduleTask {
    key: string;
    stage: string;
    required: boolean;
    execution: string;
    gate: string;
}

export interface ScheduleInput {
    /** Stage keys in plan order. */
    stages: readonly string[];
    /** Tasks in plan order. */
    tasks: readonly ScheduleTask[];
    concurrency: number;
    /** Stage keys that already carry an advance decision. */
    advanced: readonly string[];
    cancelled: boolean;
}

export interface ScheduleDecision {
    /** The first stage not yet advanced past; null once every stage has. */
    activeStage: string | null;
    /** Tasks to launch now, retries first, never more than the free slots. */
    launch: string[];
    /** The stage to record as settled, or null. */
    advance: string | null;
    /** True when every stage has advanced: the batch is finished. */
    complete: boolean;
    /** Tasks holding a slot now. */
    active: number;
}

/** A task's accepted outcome: it ran to success AND its gate passed. A verdict alone is not enough. */
export const isAccepted = (task: Pick<ScheduleTask, 'execution' | 'gate'>): boolean =>
    task.execution === TASK_SUCCEEDED && task.gate === GATE_PASSED;

/** A task can be re-run when it failed or stopped, or ran fine but its gate refused the result. */
export const isRetryable = (task: Pick<ScheduleTask, 'execution' | 'gate'>): boolean =>
    task.execution === TASK_FAILED ||
    task.execution === TASK_STOPPED ||
    (task.execution === TASK_SUCCEEDED && task.gate === GATE_FAILED);

/**
 * A stage is settled when every required task is accepted and no other task is still pending or
 * moving — an optional task that failed does not hold the batch, one still running does.
 */
function stageSettled(tasks: readonly ScheduleTask[]): boolean {
    return tasks.every((task) => {
        if (task.required) return isAccepted(task);
        return !WAITING.includes(task.execution) && !holdsSlot(task.execution);
    });
}

export function decideSchedule(input: ScheduleInput): ScheduleDecision {
    const active = input.tasks.filter((task) => holdsSlot(task.execution)).length;
    const activeStage = input.stages.find((stage) => !input.advanced.includes(stage)) ?? null;
    const none = { activeStage, launch: [], advance: null, complete: false, active };
    if (input.cancelled) return none;
    if (activeStage === null) return { ...none, complete: true };

    const inStage = input.tasks.filter((task) => task.stage === activeStage);
    if (stageSettled(inStage)) return { ...none, advance: activeStage };

    const free = Math.max(0, input.concurrency - active);
    const waiting = inStage.filter((task) => WAITING.includes(task.execution));
    // A retry or repair was already running once and the operator is waiting on it.
    const ordered = [
        ...waiting.filter((t) => t.execution === TASK_RETRY),
        ...waiting.filter((t) => t.execution === TASK_PENDING),
    ];
    return { ...none, launch: ordered.slice(0, free).map((task) => task.key) };
}

/**
 * The frozen instructions a task's thread starts from: objective, acceptance and verification as
 * the plan wrote them, so editing nothing later can change what a launched task was asked.
 */
export function batchTaskCommand(task: { objective: string; acceptance: string; verification: string }): string {
    return [task.objective, `Acceptance:\n${task.acceptance}`, `Verification:\n${task.verification}`].join('\n\n');
}

/**
 * The long-poll's verdict on a started batch: `terminal` once finished or cancelled with nothing
 * moving, `parked` when nothing moves and nothing will without an operator (a failed task, a gate
 * not yet signalled), otherwise null — still moving.
 */
export type BatchWaitResult = 'terminal' | 'parked';

export function batchWaitResult(state: {
    complete: boolean;
    cancelled: boolean;
    active: number;
}): BatchWaitResult | null {
    if (state.active > 0) return null;
    if (state.complete || state.cancelled) return 'terminal';
    return 'parked';
}
