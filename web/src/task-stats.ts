import type { RunUsage, TaskUsage, TokenType, UsageBlock } from '@factory-ai/core';
import type { JobActivity, ThreadActivity } from './api/useJobActivity.js';
import { isTerminal, type Job } from './api/useJobs.js';
import { TOKEN_TYPE_LABELS } from './components/usage/usage-format.js';

/**
 * The task statistics read model (issues 530, 848): a pure view over the activity answer. The task's
 * figures are the canonical `task.usage` (reviews and run-unassigned amounts included) and every run
 * row is a `task.runs[]` entry - nothing is re-summed from runs or buckets. A figure the board never
 * measured stays null and renders "-", a run still going is provisional.
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
    /** Null is unmeasured - never zero. */
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
    /** Some run's telemetry is still being fetched. */
    loading: boolean;
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
    return { state: usage.state === 'measured' ? 'measured' : 'none', usage };
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
    else telemetry = answers.some((answer) => typeof answer === 'object') ? 'none' : 'unavailable';
    return {
        runs,
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
        loading,
    };
}

/** The sentence naming incomplete coverage, or null when every run is covered. */
export function coverageNote(label: string, coverage: Coverage<unknown>): string | null {
    if (coverage.measured === coverage.runs) return null;
    return `${label} measured for ${coverage.measured} of ${coverage.runs} runs.`;
}
