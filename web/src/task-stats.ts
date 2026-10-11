import type { JobActivity, ThreadActivity, TokenTypes } from './api/useJobActivity.js';
import { isTerminal, type Job } from './api/useJobs.js';

/**
 * The task statistics read model (issue 530): what the activity pulse and its modal say about a
 * thread, derived from the runs and their activity answers. Nothing is inferred — a figure the
 * board never measured stays null and renders "—", a run still going is provisional, and a total
 * that sums fewer runs than the thread has says how many it covers.
 */

/** One token type: its field, the label the reader sees, and the line class that draws it. */
export interface TokenTypeSpec {
    key: keyof TokenTypes;
    label: string;
    line: string;
}

/** The four token types, in the order the legend and the table list them. */
export const TOKEN_TYPES: readonly TokenTypeSpec[] = [
    { key: 'input', label: 'Input', line: 'pulse-input' },
    { key: 'output', label: 'Output', line: 'pulse-output' },
    { key: 'cacheRead', label: 'Cache read', line: 'pulse-cache-read' },
    { key: 'cacheCreation', label: 'Cache creation', line: 'pulse-cache-creation' },
];

/**
 * Where a run's telemetry stands: still being asked for, refused or never reported by a session
 * (`unavailable`), asked and answered with nothing (`none`), or measured.
 */
export type TelemetryState = 'loading' | 'unavailable' | 'none' | 'measured';

/** One run of the thread, oldest first, as the modal's table row reads it. */
export interface RunStat {
    id: string;
    /** The run's 1-based position in the thread. */
    number: number;
    status: Job['status'];
    startedAt: string | null;
    finishedAt: string | null;
    /** The run is still going: its figures are provisional. */
    live: boolean;
    /** Null is unmeasured — never zero. */
    agentTurns: number | null;
    telemetry: TelemetryState;
    tokens: TokenTypes | null;
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
    tokens: Coverage<TokenTypes>;
    /** Some run is still going, so the totals will move. */
    provisional: boolean;
    /** Some run's telemetry is still being fetched. */
    loading: boolean;
}

function telemetryOf(answer: ThreadActivity[string] | undefined): {
    state: TelemetryState;
    payload: JobActivity | null;
} {
    if (answer === undefined) return { state: 'loading', payload: null };
    if (answer === 'unavailable') return { state: 'unavailable', payload: null };
    return { state: answer.totals === null ? 'none' : 'measured', payload: answer };
}

const addTokens = (a: TokenTypes, b: TokenTypes): TokenTypes => ({
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
});

/** The thread's statistics: the runs, oldest first, and the totals over what was measured. */
export function taskStats(jobs: readonly Job[], activity: ThreadActivity): TaskStats {
    const runs: RunStat[] = jobs.map((job, index) => {
        const { state, payload } = telemetryOf(activity[job.id]);
        return {
            id: job.id,
            number: index + 1,
            status: job.status,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            live: !isTerminal(job.status),
            agentTurns: job.agentTurns,
            telemetry: state,
            tokens: payload?.totals ?? null,
            activity: payload,
        };
    });
    const turns = runs.filter((run) => run.agentTurns !== null);
    const measured = runs.filter((run) => run.tokens !== null);
    return {
        runs,
        agentTurns: {
            value: turns.length === 0 ? null : turns.reduce((sum, run) => sum + run.agentTurns!, 0),
            measured: turns.length,
            runs: runs.length,
        },
        tokens: {
            value: measured.length === 0 ? null : measured.map((run) => run.tokens!).reduce(addTokens),
            measured: measured.length,
            runs: runs.length,
        },
        provisional: runs.some((run) => run.live),
        loading: runs.some((run) => run.telemetry === 'loading'),
    };
}

/** "—" for an unmeasured figure, the exact grouped integer otherwise. */
export const figure = (value: number | null): string => (value === null ? '—' : value.toLocaleString('en-US'));

/** The sentence naming incomplete coverage, or null when every run is covered. */
export function coverageNote(label: string, coverage: Coverage<unknown>): string | null {
    if (coverage.measured === coverage.runs) return null;
    return `${label} measured for ${coverage.measured} of ${coverage.runs} runs.`;
}
