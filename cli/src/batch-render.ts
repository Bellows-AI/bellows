import { BATCH_DRAFT, batchVerdict } from './batch.js';
import type {
    BatchNextAction,
    BatchPlanView,
    BatchRecord,
    BatchReport,
    BatchReportTask,
    BatchSummary,
    BatchTaskState,
} from './batch.js';

/**
 * Human renderers for the batch commands. Pure text in, text out, like `render.ts`; `--json`
 * prints the board's records instead. The plan is rendered as it will run — each stage's
 * effective policy, the concurrency, each task's target — so what start will freeze is on screen
 * before it is asked for.
 */

const DASH = '-';
const HUMAN_POLICY = 'human';
const NO_PR = 'none';

/** A task whose state names a person to act: the wait reason is the board's own words for it. */
export const needsAction = (task: BatchTaskState): boolean => task.waitReason !== null;

/** The plan's settings: effective policy per stage, concurrency, executor default. */
export function renderPlanSettings(plan: BatchPlanView): string[] {
    const lines = [
        `policy ${plan.policy} · concurrency ${plan.concurrency} · executor ${plan.executor ?? 'default'}`,
        ...plan.targets.map((target) => `target ${target.key}: ${target.repo}@${target.branch ?? 'default branch'}`),
    ];
    return lines;
}

function renderStage(plan: BatchPlanView, stageKey: string, tasks: BatchTaskState[]): string[] {
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
        lines.push(
            `  ${state.key} ${state.execution} · gate ${state.gate} · target ${target}${pr}${thread}${accepted}`
        );
        if (state.waitReason !== null) lines.push(`    needs action: ${state.waitReason}`);
    }
    return lines;
}

/** One batch, whole: header, settings, then every stage with its tasks and what waits on a person. */
export function renderBatch(batch: BatchRecord): string {
    const lines = [`${batch.id} ${batch.status} v${batch.version} "${batch.plan.title}"`];
    if (batch.status !== BATCH_DRAFT) lines.push(`verdict ${batchVerdict(batch)}`);
    lines.push(...renderPlanSettings(batch.plan));
    const stages = [...new Set(batch.tasks.map((task) => task.stage))];
    for (const stage of stages) {
        lines.push(
            ...renderStage(
                batch.plan,
                stage,
                batch.tasks.filter((task) => task.stage === stage)
            )
        );
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
export function renderWaitEnd(batch: BatchRecord, ending: string = batchVerdict(batch)): string {
    const waiting = batch.tasks.filter(needsAction);
    const lines = [`${batch.id} ${ending}`];
    for (const task of waiting)
        lines.push(`  ${task.key}: ${task.waitReason}${task.pr === NO_PR ? '' : ` (pr ${task.pr})`}`);
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
    const lines = [
        `  ${task.key} ${task.execution} · gate ${task.gate} · attempts ${task.attempts} ` +
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
    ];
    for (const task of report.tasks) lines.push(...renderReportTask(task, now));
    return lines.join('\n');
}
