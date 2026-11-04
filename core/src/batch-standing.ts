import { VERIFY_FAILED, VERIFY_PASSED } from './batch-merge.js';
import { TASK_CANCELLED, TASK_FAILED, TASK_NO_PR, TASK_SUCCEEDED } from './batch-schedule.js';

/**
 * Where a batch stands: the board's one verdict, computed from the record and the report's `next`
 * so the CLI, the MCP tools and the dashboard read the same word (docs/batches.md).
 */

export type BatchVerdict =
    | 'draft'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'needs_attention'
    /** The report could not be read whole: no verdict is claimed, least of all a terminal one. */
    | 'inconclusive';

export type BatchFence = 'cancelled' | 'expired';

export interface BatchAttention {
    key: string;
    stage: string;
    waitReason: string;
    /** The task's PR url, or null when it has none. */
    pr: string | null;
}

export interface BatchVerificationFailure {
    stage: string;
    state: string;
    detail: string | null;
    headSha: string | null;
}

export interface BatchStanding {
    verdict: BatchVerdict;
    /** Which fence ended the batch, so a reader can name it; null when none did. */
    fence: BatchFence | null;
    /** Tasks that wait on a person (the board is not acting on them). */
    attention: BatchAttention[];
    /** Every verification row in the failed state. */
    verificationFailures: BatchVerificationFailure[];
}

/** The record's fields the verdict reads. */
export interface StandingRecord {
    status: string;
    cancelledAt: string | null;
    expiredAt: string | null;
    tasks: {
        key: string;
        stage: string;
        execution: string;
        pr: string;
        waitReason: string | null;
        closedAt?: string | null;
    }[];
    verification: { stage: string; state: string; detail: string | null; headSha: string | null }[];
}

/** The report's subset the verdict reads: each task's `next`, the board's own word on who acts. */
export interface StandingReportTask {
    key: string;
    next: { action: string };
}

const STATUS_DRAFT = 'draft';
const STATUS_COMPLETED = 'completed';
const STATUS_CANCELLED = 'cancelled';
const STATUS_EXPIRED = 'expired';
const NEXT_WAIT = 'wait';
const TERMINAL: readonly string[] = [TASK_SUCCEEDED, TASK_FAILED, TASK_CANCELLED];

function fenceOf(record: StandingRecord): BatchFence | null {
    if (record.status === STATUS_EXPIRED) return 'expired';
    if (record.status === STATUS_CANCELLED) return 'cancelled';
    if (record.cancelledAt != null) return 'cancelled';
    if (record.expiredAt != null) return 'expired';
    return null;
}

/** The report's tasks when every one is well formed, else null: a malformed answer is not an answer. */
function wellFormed(reportTasks: unknown): StandingReportTask[] | null {
    if (!Array.isArray(reportTasks)) return null;
    for (const entry of reportTasks as unknown[]) {
        const task = entry as Partial<StandingReportTask> | null;
        if (typeof task?.key !== 'string' || typeof task.next?.action !== 'string') return null;
    }
    return reportTasks as StandingReportTask[];
}

/**
 * The standing of a batch. A fence outranks every verdict (attention keeps only the tasks that left a PR) and a draft has no report to read. For a
 * started batch, a task whose wait reason names a person needs one unless the report's `next` says
 * the board is on it, as does a failed stage verification, and those outrank everything else:
 * nothing a wait does moves them. Otherwise the batch is settled only when every task is, and then
 * a failed task beats a cancelled one beats success, which also needs every stage verified.
 * `reportTasks` null, malformed or missing a task is unconfirmed: `inconclusive`, never a verdict.
 */
export function batchStanding(record: StandingRecord, reportTasks: readonly unknown[] | null): BatchStanding {
    const fence = fenceOf(record);
    const verificationFailures = record.verification
        .filter((row) => row.state === VERIFY_FAILED)
        .map(({ stage, state, detail, headSha }) => ({ stage, state, detail, headSha }));
    const standing = (verdict: BatchVerdict, attention: BatchAttention[] = []): BatchStanding => ({
        verdict,
        fence,
        attention,
        verificationFailures,
    });
    if (record.status === STATUS_DRAFT) return standing('draft');

    const report = wellFormed(reportTasks);
    const next = new Map((report ?? []).map((task) => [task.key, task.next.action]));
    const whole = report !== null && record.tasks.every((task) => next.has(task.key));
    const boardActing = (task: { key: string }): boolean => next.get(task.key) === NEXT_WAIT;
    const attention = !whole
        ? []
        : record.tasks
              .filter((task) => task.waitReason !== null && !boardActing(task))
              .map((task) => ({
                  key: task.key,
                  stage: task.stage,
                  waitReason: task.waitReason as string,
                  pr: task.pr === TASK_NO_PR ? null : task.pr,
              }));
    // A fence ends the batch whatever the report says, but a PR it left open still needs its person; a task with no
    // PR waited on the batch the fence ended, so nothing is left for a person there.
    if (fence !== null) {
        return standing(
            'cancelled',
            attention.filter((entry) => entry.pr !== null)
        );
    }
    if (!whole) return standing('inconclusive');
    if (attention.length > 0 || verificationFailures.length > 0) return standing('needs_attention', attention);
    // A succeeded run whose PR the board is still merging is not settled: its gate is open.
    if (record.tasks.some(boardActing)) return standing('running');
    if (!record.tasks.every((task) => TERMINAL.includes(task.execution))) return standing('running');
    if (record.tasks.some((task) => task.execution === TASK_FAILED)) return standing('failed');
    // A task a person force-closed in a batch that still completed was settled by that person.
    const settledByPerson = (task: { closedAt?: string | null }) =>
        task.closedAt != null && record.status === STATUS_COMPLETED;
    if (record.tasks.some((task) => task.execution === TASK_CANCELLED && !settledByPerson(task))) {
        return standing('cancelled');
    }
    // The last automerge stage's tasks are all done while its verification is still being read.
    if (record.verification.some((row) => row.state !== VERIFY_PASSED)) return standing('running');
    // Before the board writes that verification the list is empty: only the board's own
    // `completed` says every stage was verified.
    if (record.status !== STATUS_COMPLETED) return standing('running');
    return standing('succeeded');
}
