import { BATCH_DRAFT, batchVerdict } from './batch.js';
import type { BatchPlanView, BatchRecord, BatchSummary, BatchTaskState } from './batch.js';

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

/** The wait's final line, naming the tasks that need a person. */
export function renderWaitEnd(batch: BatchRecord): string {
    const waiting = batch.tasks.filter(needsAction);
    const lines = [`${batch.id} ${batchVerdict(batch)}`];
    for (const task of waiting)
        lines.push(`  ${task.key}: ${task.waitReason}${task.pr === NO_PR ? '' : ` (pr ${task.pr})`}`);
    return lines.join('\n');
}
