import { BATCH_DRAFT, batchVerdict, needsPerson, TASK_CANCELLED, VERIFY_FAILED } from './batch.js';
import type {
    BatchNextAction,
    BatchPlanView,
    BatchNextOf,
    BatchRecord,
    BatchReport,
    BatchReportTask,
    BatchStageVerification,
    BatchSummary,
    BatchTaskPlan,
    BatchTaskState,
} from './batch.js';

/**
 * Human renderers for the batch commands. Pure text in, text out, like `render.ts`; `--json`
 * prints the board's records instead. The plan is rendered as it will run — each stage's
 * effective policy, the concurrency, each task's target — so what start will freeze is on screen
 * before it is asked for.
 */

const DASH = '-';
const USER_SCOPE = 'user';
const HUMAN_POLICY = 'human';
const NO_PR = 'none';

/** The tasks whose state names a person to act: the wait reason is the board's own words for it. */
export const needsAction = (batch: BatchRecord, report?: BatchNextOf): BatchTaskState[] =>
    batch.tasks.filter((task) => needsPerson(task, report));

/** A stage's combined verification in a few words: its state, then why, if the board said. */
const verificationOf = (row: BatchStageVerification): string =>
    `verification ${row.state}${row.detail === null ? '' : `: ${row.detail}`}`;

/** An executor and, beside a name, whose profile it is: `Main ORG (org)`. */
const executorOf = (executor: string | undefined, scope: string | undefined): string =>
    executor === undefined ? 'default' : `${executor} (${scope ?? USER_SCOPE})`;

/** The plan's settings: effective policy per stage, concurrency, executor default. */
export function renderPlanSettings(plan: BatchPlanView): string[] {
    const lines = [
        `policy ${plan.policy} · concurrency ${plan.concurrency} · executor ${executorOf(plan.executor, plan.executorScope)}`,
        ...plan.targets.map((target) => `target ${target.key}: ${target.repo}@${target.branch ?? 'default branch'}`),
    ];
    return lines;
}

/** A task's executor when it is not the batch's own; empty when it follows the batch. */
function taskExecutorOf(plan: BatchPlanView, task: BatchTaskPlan | undefined): string {
    if (task?.executor === undefined) return '';
    const batch = executorOf(plan.executor, plan.executorScope);
    const own = executorOf(task.executor, task.executorScope ?? plan.executorScope);
    return own === batch ? '' : ` · executor ${own}`;
}

function renderStage(batch: BatchRecord, stageKey: string, report: BatchNextOf): string[] {
    const { plan } = batch;
    const tasks = batch.tasks.filter((task) => task.stage === stageKey);
    const verification = batch.verification.find((row) => row.stage === stageKey);
    const stage = plan.stages.find((candidate) => candidate.key === stageKey);
    const policy = stage?.policy ?? plan.policy;
    const gate = policy === HUMAN_POLICY ? ' [human review gate]' : '';
    const done = tasks.filter((task) => task.execution !== 'pending').length;
    const lines = [`stage ${stageKey} (${policy})${gate} — ${done}/${tasks.length} started`];
    for (const state of tasks) {
        const task = stage?.tasks.find((candidate) => candidate.key === state.key);
        const target = task?.target ?? plan.defaultTarget ?? DASH;
        const accepted = task?.completion.kind === 'accepted' ? ` · accepted when: ${task.completion.condition}` : '';
        const pr = state.pr === NO_PR ? '' : ` · pr ${state.pr}`;
        const thread = state.rootJobId ? ` · task ${state.rootJobId}` : '';
        const executor = taskExecutorOf(plan, task);
        lines.push(
            `  ${state.key} ${state.execution} · gate ${state.gate} · target ${target}${executor}${pr}${thread}${accepted}`
        );
        if (needsPerson(state, report)) lines.push(`    needs action: ${state.waitReason}`);
    }
    if (verification) lines.push(`  ${verificationOf(verification)} (at ${verification.headSha ?? 'unknown head'})`);
    return lines;
}

/** One batch, whole: header, settings, then every stage with its tasks and what waits on a person. */
export function renderBatch(batch: BatchRecord, report?: BatchNextOf): string {
    const lines = [`${batch.id} ${batch.status} v${batch.version} "${batch.plan.title}"`];
    if (batch.status !== BATCH_DRAFT) lines.push(`verdict ${batchVerdict(batch, report)}`);
    lines.push(...renderPlanSettings(batch.plan));
    const stages = [...new Set(batch.tasks.map((task) => task.stage))];
    for (const stage of stages) {
        lines.push(...renderStage(batch, stage, report));
    }
    return lines.join('\n');
}

export function renderBatchLine(batch: BatchSummary): string {
    return `${batch.id} ${batch.status} v${batch.version} ${batch.taskCount} task(s) "${batch.title}"`;
}

export function renderBatchList(batches: BatchSummary[]): string {
    return batches.map((batch) => `${renderBatchLine(batch)}\n`).join('');
}

/** A draft write's one-line answer; the version is what the next update or start must quote. */
export function renderDraftWritten(verb: string, written: { id: string; version: number }): string {
    return `${verb} ${written.id} v${written.version}`;
}

/** What `validate` found: the plan as start would freeze it, before anything is started. */
export function renderValidated(id: string, validated: { version: number; plan: BatchPlanView }): string {
    return [`valid ${id} v${validated.version} "${validated.plan.title}"`, ...renderPlanSettings(validated.plan)].join(
        '\n'
    );
}

/** The wait's final line, naming the tasks that need a person; `ending` replaces the verdict for a fenced batch. */
export function renderWaitEnd(
    batch: BatchRecord,
    report: BatchNextOf,
    ending: string = batchVerdict(batch, report)
): string {
    const waiting = needsAction(batch, report);
    const lines = [`${batch.id} ${ending}`];
    for (const task of waiting)
        lines.push(`  ${task.key}: ${task.waitReason}${task.pr === NO_PR ? '' : ` (pr ${task.pr})`}`);
    for (const row of batch.verification.filter((stage) => stage.state === VERIFY_FAILED))
        lines.push(`  stage ${row.stage} ${verificationOf(row)}`);
    return lines.join('\n');
}

const SECOND_MS = 1000;
const MINUTE_S = 60;
const HOUR_S = 3600;

/** How long ago an ISO instant was, coarsely: `45s`, `12m`, `3h`. */
function ageOf(at: string, now: number): string {
    const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / SECOND_MS));
    if (seconds < MINUTE_S) return `${seconds}s`;
    if (seconds < HOUR_S) return `${Math.floor(seconds / MINUTE_S)}m`;
    return `${Math.floor(seconds / HOUR_S)}h`;
}

const nextOf = (next: BatchNextAction): string =>
    [next.action, next.method, next.path ?? next.url].filter((part) => part !== undefined).join(' ');

function renderReportTask(task: BatchReportTask, now: number): string[] {
    // Cancelled while the batch is live means a person force-closed the task's thread (#676).
    const execution =
        task.execution === TASK_CANCELLED && task.closedAt !== null ? 'cancelled by a person' : task.execution;
    const lines = [
        `  ${task.key} ${execution} · gate ${task.gate} · attempts ${task.attempts} ` +
            `(infra ${task.infraRetries}, repairs ${task.repairs}, manual ${task.manualRetries}) · ` +
            `remaining infra ${task.remaining.infraRetries}, repairs ${task.remaining.repairs}`,
    ];
    if (task.pr !== null) lines.push(`    pr ${task.pr}`);
    const seen = task.observation;
    if (seen === null) {
        if (task.pr !== null) lines.push('    observed: none yet');
    } else {
        const when = seen.observedAt === null ? 'never read' : `${ageOf(seen.observedAt, now)} ago`;
        const stale = seen.stale ? ' (stale, re-reading)' : '';
        const error = seen.error === null ? '' : ` · read error ${seen.error.code}`;
        lines.push(`    observed ${seen.outcome ?? 'nothing'} ${when}${stale}${error}`);
    }
    if (task.waitReason !== null) lines.push(`    waiting: ${task.waitReason}`);
    lines.push(`    next: ${nextOf(task.next)}`);
    return lines;
}

/** The morning report: the batch's state and budgets, what merged, then every task with its next step. */
export function renderReport(report: BatchReport, now: number): string {
    const fence = report.expiredAt ? ` · expired ${report.expiredAt}` : '';
    const lines = [
        `${report.id} ${report.state} "${report.title}" · deadline ${report.deadlineAt}${fence}`,
        `budgets: infra ${report.budgets.infraRetries} · repairs ${report.budgets.repairs} · ` +
            `time limit ${report.budgets.timeLimitMinutes}m`,
        ...report.prs.merged.map((pr) => `merged ${pr.task}: ${pr.url}`),
        ...report.prs.open.map((pr) => `open ${pr.task}: ${pr.url}`),
        report.latestObservationAt === null
            ? 'latest observation: none yet'
            : `latest observation ${ageOf(report.latestObservationAt, now)} ago`,
        report.unavailable.map((what) => `${what}: unavailable`).join(' · '),
        ...report.verification.map((row) => `stage ${row.stage} ${verificationOf(row)}`),
    ];
    for (const task of report.tasks) lines.push(...renderReportTask(task, now));
    return lines.join('\n');
}
