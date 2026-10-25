import type { JobRun, TaskUsageDistribution, TaskUsageStats } from './types.js';
import type { TaskUsage } from './usage.js';

export interface TaskUsageOptions {
    /**
     * Only runs queued against these repos are counted — the same repo scope every other figure
     * on the page applies. The usage report the tasks come from was already scoped by the caller.
     */
    repos?: readonly string[];
    /** Only runs the caller queued are counted, so the task set narrows to the caller's tasks. */
    user?: { id: string };
}

/**
 * A task's input + output, the stopgap figure of the task panel until the four-type
 * distributions replace it (the four token types are never collapsed elsewhere). Null when the
 * task measured neither — a contributor absent, not a zero.
 */
function billableTokens(task: TaskUsage): number | null {
    const { input, output } = task.usage.tokens;
    if (input === null && output === null) return null;
    return (input ?? 0) + (output ?? 0);
}

const P50 = 0.5;
const P95 = 0.95;

/**
 * Nearest-rank percentile over the ascending sort: the ceil(p·N)-th value, 1-indexed. Chosen
 * because it recomputes by hand — the independent suites restate these figures without a
 * percentile library, and a linear-interpolation median would not survive that.
 */
function distribution(values: number[]): TaskUsageDistribution {
    if (values.length === 0) return { avg: null, p50: null, p95: null, tasks: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const rank = (p: number) => sorted[Math.ceil(p * sorted.length) - 1] as number;
    return {
        avg: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
        p50: rank(P50),
        p95: rank(P95),
        tasks: sorted.length,
    };
}

/**
 * Tokens per canonical task, from the usage report: a task whose sessions measured neither
 * input nor output is EXCLUDED from the distribution, never counted as a zero-total task.
 */
function computeTokenValues(usageTasks: readonly TaskUsage[], tasks: ReadonlySet<string>): number[] {
    const values: number[] = [];
    for (const task of usageTasks) {
        if (!tasks.has(task.taskId)) continue;
        const total = billableTokens(task);
        if (total !== null) values.push(total);
    }
    return values;
}

/**
 * Job turns: one run row, one job turn. Every task in scope counts, including one whose
 * runs all fell outside the range — it got here through its sessions, and its zero is
 * real (no run of this task was queued inside the range).
 */
function computeJobTurnValues(runs: readonly JobRun[], tasks: ReadonlySet<string>): number[] {
    const jobTurnCounts = new Map<string, number>();
    for (const run of runs) {
        jobTurnCounts.set(run.rootJobId, (jobTurnCounts.get(run.rootJobId) ?? 0) + 1);
    }
    return [...tasks].map((task) => jobTurnCounts.get(task) ?? 0);
}

/**
 * Shared shape behind agent turns and wall clock: sum a per-run measurement onto its task,
 * but a task with any unmeasured (null) in-range run is excluded from THIS distribution only —
 * a partial sum presented as a total is a quiet undercount. A task with no in-range run banked
 * nothing in the range, and that zero is a measurement, not a missing value.
 */
function sumMeasuredPerTask(
    runs: readonly JobRun[],
    tasks: ReadonlySet<string>,
    getValue: (run: JobRun) => number | null
): number[] {
    const sums = new Map<string, { sum: number; unmeasured: boolean }>();
    for (const run of runs) {
        const entry = sums.get(run.rootJobId) ?? { sum: 0, unmeasured: false };
        const value = getValue(run);
        if (value === null) entry.unmeasured = true;
        else entry.sum += value;
        sums.set(run.rootJobId, entry);
    }
    const values: number[] = [];
    for (const task of tasks) {
        const entry = sums.get(task);
        if (entry?.unmeasured) continue;
        values.push(entry?.sum ?? 0);
    }
    return values;
}

/**
 * What a task costs, as four distributions over the job threads in scope: tokens per task
 * (input + output of the canonical task, reviews and removed tasks included), job turns per
 * task (run rows — the board's own count), agent turns per task (the runs' close-time counts,
 * summed), and wall clock per task (the execution time the board banked for those runs).
 *
 * The caller range-filters the runs (`filterJobRuns`) and reduces the usage report over the same
 * range, repos and user first, so this function sees only what the selected range keeps. A task
 * enters the statistics when either input still carries it.
 *
 * Pure, like every aggregation in core. The fetch lives in the server; only the arithmetic
 * lives here.
 */
export function taskUsageStats(
    usageTasks: readonly TaskUsage[],
    runs: readonly JobRun[],
    options: TaskUsageOptions = {}
): TaskUsageStats {
    const { repos, user } = options;
    const inRepoScope = (name: string | null) => name !== null && (repos === undefined || repos.includes(name));

    const visibleRuns = runs.filter(
        (r) => inRepoScope(r.repo) && (user === undefined || (r.createdBy !== null && r.createdBy === user.id))
    );

    // The task set: a canonical task with usage in the report, or a run in its thread.
    const tasks = new Set<string>(usageTasks.map((t) => t.taskId));
    for (const run of visibleRuns) tasks.add(run.rootJobId);

    return {
        tokensPerTask: distribution(computeTokenValues(usageTasks, tasks)),
        jobTurnsPerTask: distribution(computeJobTurnValues(visibleRuns, tasks)),
        agentTurnsPerTask: distribution(sumMeasuredPerTask(visibleRuns, tasks, (r) => r.agentTurns)),
        wallClockPerTask: distribution(sumMeasuredPerTask(visibleRuns, tasks, (r) => r.wallClockMs)),
    };
}
