import type { RunUsage, TaskUsage, TokenType, UsageBlock } from '@factory-ai/core';
import type {
    GateActivity,
    GateOutcomeKey,
    JobActivity,
    PrActivity,
    PrOperation,
    ThreadActivity,
} from './api/useJobActivity.js';
import { isTerminal, type Job } from './api/useJobs.js';
import { duration } from './format.js';
import { figure, TOKEN_TYPE_LABELS } from './components/usage/usage-format.js';

/**
 * The task statistics read model (issues 530, 848): a pure view over the activity answer. The task's
 * figures are the canonical `task.usage` (reviews and run-unassigned amounts included) and every run
 * row is a `task.runs[]` entry - nothing is re-summed from runs or buckets. A figure the board never
 * measured stays null and renders "—", a run still going is provisional.
 */

/** One token type: its field, the label the reader sees, and the line class that draws it. */
export interface TokenTypeSpec {
    key: TokenType;
    label: string;
    line: string;
}

/** The four token types, in the order the pulse legend lists them. */
export const TOKEN_TYPES: readonly TokenTypeSpec[] = [
    { key: 'input', label: TOKEN_TYPE_LABELS.input, line: 'pulse-input' },
    { key: 'output', label: TOKEN_TYPE_LABELS.output, line: 'pulse-output' },
    { key: 'cacheRead', label: TOKEN_TYPE_LABELS.cacheRead, line: 'pulse-cache-read' },
    { key: 'cacheCreation', label: TOKEN_TYPE_LABELS.cacheCreation, line: 'pulse-cache-creation' },
];

/**
 * Where telemetry stands: still being asked for, refused or never reported by a session
 * (`unavailable`), asked and answered with nothing (`none`), or measured.
 */
export type TelemetryState = 'loading' | 'unavailable' | 'none' | 'measured';

/** One run of the task as the modal's table reads it: a thread run, or a task run the thread does not list. */
export interface RunStat {
    id: string;
    kind: RunUsage['kind'];
    /** "Run 2", "Review of run 1": the thread position, never a count of adoptions or claims. */
    label: string;
    /** The run's 1-based position in the thread; null for a review or a run no longer on the board. */
    number: number | null;
    /** False: the job row is gone, only its usage remains. */
    operational: boolean;
    status: Job['status'] | null;
    startedAt: string | null;
    finishedAt: string | null;
    /** The run is still going: its figures are provisional. */
    live: boolean;
    /** Null is unmeasured — never zero. */
    agentTurns: number | null;
    telemetry: TelemetryState;
    /** This run's usage block; null while loading or when the board refused it. */
    usage: UsageBlock | null;
    /** The newest run's whole answer (it carries the chart); other runs have none. */
    activity: JobActivity | null;
}

/** A thread-wide figure and how much of the thread it covers. */
export interface Coverage<T> {
    /** Null when no run measured it. */
    value: T | null;
    measured: number;
    runs: number;
}

export interface TaskStats {
    runs: RunStat[];
    /** The newest run of the thread (the one the sidebar charts); null for an empty thread. */
    latest: RunStat | null;
    agentTurns: Coverage<number>;
    telemetry: TelemetryState;
    /** The canonical `task.usage`: review runs and run-unassigned amounts included. Null until answered. */
    usage: UsageBlock | null;
    /** Usage the task owns but no run: its own row. */
    taskOwned: UsageBlock | null;
    /** Review runs the task usage includes. */
    reviews: number;
    /** Some run is still going, so the figures will move. */
    provisional: boolean;
    /** The task's gate activity from the newest answer; null until one lands, or when the board refused. */
    gates: GateActivity | null;
    prs: PrActivity | null;
}

const labelOf = (run: RunUsage, number: number | null, numberOf: ReadonlyMap<string, number>): string => {
    if (number !== null) return `Run ${number}`;
    if (run.kind !== 'review') return 'Earlier run';
    const target = run.reviewOf === null ? undefined : numberOf.get(run.reviewOf);
    return target === undefined ? 'Review' : `Review of run ${target}`;
};

/** A thread run with no entry in the task: loading until there is an answer, then unmeasured or refused. */
function threadTelemetry(
    answer: ThreadActivity[string] | undefined,
    entry: RunUsage | undefined,
    task: TaskUsage | null
): { state: TelemetryState; usage: UsageBlock | null } {
    if (answer === 'unavailable') return { state: 'unavailable', usage: null };
    const usage = entry?.usage ?? (answer === undefined ? null : answer.usage);
    if (usage === null)
        return task === null && answer === undefined ? { state: 'loading', usage } : { state: 'none', usage };
    if (usage.state === 'unavailable') return { state: 'unavailable', usage };
    return { state: usage.state === 'measured' ? 'measured' : 'none', usage };
}

/** An answer that carries token figures: telemetry was on for it, even if it measured nothing. */
const isTokenAnswer = (answer: ThreadActivity[string] | undefined): boolean =>
    typeof answer === 'object' && answer.usage.state !== 'unavailable';

/** The task-level gate and PR activity of the newest answered run; null while none is answered. */
function newestTaskActivity(answers: readonly (ThreadActivity[string] | undefined)[]): {
    gates: GateActivity | null;
    prs: PrActivity | null;
} {
    const newest = [...answers].reverse().find((answer): answer is JobActivity => typeof answer === 'object');
    return { gates: newest?.taskActivity.gates ?? null, prs: newest?.taskActivity.prs ?? null };
}

/** The task's statistics: thread runs oldest first, then the task's runs the thread does not list. */
export function taskStats(jobs: readonly Job[], activity: ThreadActivity): TaskStats {
    const answers = jobs.map((job) => activity[job.id]);
    // Any run's answer carries the same task; the newest answer is the freshest.
    const task =
        [...answers]
            .reverse()
            .map((answer) => (typeof answer === 'object' ? answer.task : null))
            .find((candidate) => candidate != null) ?? null;
    const { gates, prs } = newestTaskActivity(answers);
    const taskRuns = task?.runs ?? [];
    const numberOf = new Map(jobs.map((job, index) => [job.id, index + 1] as const));
    const threadRuns: RunStat[] = jobs.map((job, index) => {
        const entry = taskRuns.find((run) => run.jobId === job.id);
        const answer = answers[index];
        const { state, usage } = threadTelemetry(answer, entry, task);
        return {
            id: job.id,
            kind: entry?.kind ?? (index === 0 ? 'run' : 'follow-up'),
            label: `Run ${index + 1}`,
            number: index + 1,
            operational: true,
            status: job.status,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            live: !isTerminal(job.status),
            agentTurns: job.agentTurns,
            telemetry: state,
            usage,
            activity: typeof answer === 'object' ? answer : null,
        };
    });
    const extraRuns: RunStat[] = taskRuns
        .filter((run) => !numberOf.has(run.jobId))
        .map((run) => ({
            id: run.jobId,
            kind: run.kind,
            label: labelOf(run, null, numberOf),
            number: null,
            operational: run.operational,
            status: null,
            startedAt: run.startedAt,
            finishedAt: run.endedAt,
            live: run.live,
            agentTurns: null,
            telemetry: run.usage.state === 'measured' ? ('measured' as const) : ('none' as const),
            usage: run.usage,
            activity: null,
        }));
    const runs = [...threadRuns, ...extraRuns];
    const turns = threadRuns.filter((run) => run.agentTurns !== null);
    const loading = threadRuns.some((run) => run.telemetry === 'loading');
    let telemetry: TelemetryState;
    if (task !== null) telemetry = task.usage.state === 'measured' ? 'measured' : 'none';
    else if (loading) telemetry = 'loading';
    else telemetry = answers.some(isTokenAnswer) ? 'none' : 'unavailable';
    return {
        runs,
        latest: threadRuns.at(-1) ?? null,
        agentTurns: {
            value: turns.length === 0 ? null : turns.reduce((sum, run) => sum + run.agentTurns!, 0),
            measured: turns.length,
            runs: threadRuns.length,
        },
        telemetry,
        usage: task?.usage ?? null,
        taskOwned: task?.taskOwned ?? null,
        reviews: taskRuns.filter((run) => run.kind === 'review').length,
        provisional: (task?.usage.provisional ?? false) || runs.some((run) => run.live),
        gates,
        prs,
    };
}

/** The sentence naming incomplete coverage, or null when every run is covered. */
export function coverageNote(label: string, coverage: Coverage<unknown>): string | null {
    if (coverage.measured === coverage.runs) return null;
    return `${label} measured for ${coverage.measured} of ${coverage.runs} runs.`;
}

const OUTCOME_LABELS: Record<GateOutcomeKey, string> = {
    passed: 'Passed',
    failed: 'Failed',
    setup_failed: 'Setup failed',
    not_started: 'Not started',
    incomplete: 'Incomplete',
    running: 'Running',
    unknown: 'Unknown',
};
const OUTCOME_ORDER = Object.keys(OUTCOME_LABELS) as GateOutcomeKey[];

const MS_PER_SECOND = 1000;
const MS_PER_TENTH_SECOND = 100;
const TENTHS_PER_SECOND = 10;
/** Characters of an execution id the dialog shows: enough to tell two executions apart. */
const SHORT_ID_LENGTH = 8;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/** A gate duration: seconds and minutes are what a gate takes, so the hour-scale `duration` is only the long tail. */
function gateDuration(ms: number): string {
    if (ms < MS_PER_SECOND) return `${ms}ms`;
    if (ms < MS_PER_MINUTE) return `${Math.round(ms / MS_PER_TENTH_SECOND) / TENTHS_PER_SECOND}s`;
    if (ms < MS_PER_HOUR)
        return `${Math.floor(ms / MS_PER_MINUTE)}m ${Math.round((ms % MS_PER_MINUTE) / MS_PER_SECOND)}s`;
    return duration(ms / MS_PER_HOUR);
}

/** How the dialog words the task's gate activity; every figure the board did not record reads "—". */
export interface GateFigures {
    /** False: nothing was recorded, so every figure is a dash. */
    recorded: boolean;
    partial: boolean;
    executions: string;
    outcomes: { key: GateOutcomeKey; label: string; count: number }[];
    duration: string;
    durationNote: string | null;
    reused: { gate: string; text: string }[];
    /** Gate calls only the transcript shows: agent activity, kept apart from the board's executions. */
    observed: string | null;
}

export function gateFigures(gates: GateActivity): GateFigures {
    const timed = gates.measuredCount + gates.unmeasuredCount;
    const observed = gates.observed?.executions ?? 0;
    return {
        recorded: gates.coverage !== null,
        partial: gates.coverage === 'partial',
        executions: figure(gates.executions),
        outcomes: OUTCOME_ORDER.flatMap((key) => {
            const count = gates.byOutcome?.[key] ?? 0;
            return count > 0 ? [{ key, label: OUTCOME_LABELS[key], count }] : [];
        }),
        duration: gates.measuredMs === null ? '—' : gateDuration(gates.measuredMs),
        durationNote:
            gates.coverage !== null && gates.unmeasuredCount > 0
                ? `Duration measured for ${gates.measuredCount} of ${timed} executions.`
                : null,
        reused: gates.reused.map((r) => ({
            gate: r.gate,
            text: `Reused the result of execution ${r.executionId.slice(0, SHORT_ID_LENGTH)}: ${r.reason}`,
        })),
        observed:
            observed === 0
                ? null
                : `${observed} more gate ${observed === 1 ? 'call appears' : 'calls appear'} in the agent transcript with no board record.`,
    };
}

const PR_KIND_LABELS: Record<PrOperation['kind'], string> = {
    created: 'Created',
    reused: 'Reused',
    agent_created: 'Created by the agent',
};

/** How the dialog words the task's PR activity: operations and distinct PRs are separate figures. */
export interface PrFigures {
    recorded: boolean;
    partial: boolean;
    operations: string;
    distinct: string;
    byKind: { label: string; count: number }[];
    links: { label: string; url: string }[];
}

export function prFigures(prs: PrActivity): PrFigures {
    return {
        recorded: prs.coverage !== null,
        partial: prs.coverage === 'partial',
        operations: figure(prs.counts?.operations ?? null),
        distinct: figure(prs.counts?.distinct ?? null),
        byKind: (Object.keys(PR_KIND_LABELS) as PrOperation['kind'][]).flatMap((kind) => {
            const count = prs.operations.filter((o) => o.kind === kind).length;
            return count > 0 ? [{ label: PR_KIND_LABELS[kind], count }] : [];
        }),
        links: prs.distinct.map((pr) => ({ label: `${pr.repo}#${pr.number}`, url: pr.url })),
    };
}
