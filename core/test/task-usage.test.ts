import { describe, expect, it } from 'vitest';
import { filterJobRuns } from '../src/range.js';
import type { DateRange } from '../src/range.js';
import { taskUsageStats } from '../src/task-usage.js';
import type { JobRun, TokenTotals } from '../src/types.js';
import { emptyBlock, type TaskUsage } from '../src/usage.js';
import { fixtureReport } from './fixtures/load.js';

const ALICE = { id: 'u-alice', login: 'alice', name: 'Alice', avatarUrl: null };
const BOB = { id: 'u-bob', login: 'bob', name: null, avatarUrl: null };

const T = (input: number | null, output: number | null): TokenTotals => ({
    input,
    output,
    cacheRead: null,
    cacheCreation: null,
});

/** A canonical task of the usage report with the given token totals. */
function task(taskId: string, tokens: TokenTotals, removed = false): TaskUsage {
    return { taskId, removed, usage: { ...emptyBlock('measured'), tokens }, runs: [], taskOwned: null };
}

function run(over: Partial<JobRun>): JobRun {
    return {
        rootJobId: 't1',
        repo: 'o/r',
        createdBy: ALICE.id,
        createdAt: '2026-08-20T00:00:00.000Z',
        agentTurns: 0,
        wallClockMs: 60_000,
        ...over,
    };
}

// The spec's 1k/2k/3k scenario: three tasks, hand-checkable percentiles.
const threeTasks = [task('t1', T(600, 400)), task('t2', T(1200, 800)), task('t3', T(2400, 600))];

describe('tokens per task', () => {
    it('reports avg 2k, p50 2k and p95 3k over the 1k/2k/3k scenario', () => {
        const stats = taskUsageStats(threeTasks, []);
        expect(stats.tokensPerTask).toEqual({ avg: 2000, p50: 2000, p95: 3000, tasks: 3 });
    });

    it('excludes a task with no measured tokens rather than counting it as zero', () => {
        const stats = taskUsageStats(
            [threeTasks[0] as TaskUsage, threeTasks[2] as TaskUsage, task('t2', T(null, null))],
            []
        );
        // Nearest-rank median of two values is the lower one: ceil(0.5·2) = 1st of the sort.
        expect(stats.tokensPerTask).toEqual({ avg: 2000, p50: 1000, p95: 3000, tasks: 2 });
    });

    it('sums input and output only, never cache reads', () => {
        const stats = taskUsageStats(
            [task('t1', { input: 100, output: 50, cacheRead: 999_999, cacheCreation: 888_888 })],
            []
        );
        expect(stats.tokensPerTask.p50).toBe(150);
    });

    it('keeps a task with only one of the two measured', () => {
        expect(taskUsageStats([task('t1', T(null, 70))], []).tokensPerTask.p50).toBe(70);
    });

    it('answers null figures, not zeros, when no task carries measured tokens', () => {
        const stats = taskUsageStats([], []);
        expect(stats.tokensPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
        expect(stats.jobTurnsPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
        expect(stats.agentTurnsPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
    });
});

describe('canonical tasks from the usage report', () => {
    // The fixture holds a follow-up (t-s01), a review of t-s02 and a removed task (t-s18).
    const report = fixtureReport({ repos: ['Bellows-AI/bellows.ai'] });
    const stats = taskUsageStats(report.tasks, []);
    const find = (id: string) => report.tasks.find((t) => t.taskId === id) as TaskUsage;

    it('folds a review into its requester: the review is no task of its own', () => {
        expect(report.tasks.map((t) => t.taskId)).not.toContain('t-s02-review');
        expect(find('t-s02').usage.tokens.input).toBe(51000 + 8000);
    });

    it('retains a removed task in the distribution', () => {
        expect(find('t-s18').removed).toBe(true);
        expect(find('t-s18').usage.tokens.output).toBe(2200);
    });

    it('takes one value per task, input plus output of the whole canonical task', () => {
        expect(stats.tokensPerTask.tasks).toBe(report.tasks.length);
        const expected = report.tasks.map((t) => (t.usage.tokens.input ?? 0) + (t.usage.tokens.output ?? 0));
        expect(stats.tokensPerTask.avg).toBe(expected.reduce((a, b) => a + b, 0) / expected.length);
    });
});

describe('job turns per task', () => {
    it('counts every run row once — a first run and two follow-ups are three job turns', () => {
        const stats = taskUsageStats(
            [task('t1', T(10, 5))],
            [
                run({ rootJobId: 't1', createdAt: '2026-08-18T00:00:00Z' }),
                run({ rootJobId: 't1', createdAt: '2026-08-19T00:00:00Z' }),
                run({ rootJobId: 't1', createdAt: '2026-08-20T00:00:00Z' }),
            ]
        );
        expect(stats.jobTurnsPerTask).toEqual({ avg: 3, p50: 3, p95: 3, tasks: 1 });
    });

    it('counts a task in scope via its usage even when all its runs fall outside the range', () => {
        // The range filter has already run: the usage survived, the run did not. The task
        // still enters — with a real zero (no run of it was queued inside the range).
        const stats = taskUsageStats([task('t1', T(10, 5))], []);
        expect(stats.jobTurnsPerTask).toEqual({ avg: 0, p50: 0, p95: 0, tasks: 1 });
        expect(stats.tokensPerTask.tasks).toBe(1);
        expect(stats.agentTurnsPerTask.tasks).toBe(1);
        expect(stats.agentTurnsPerTask.p50).toBe(0);
    });
});

describe('agent turns per task', () => {
    it('sums the runs stored counts — a first run of 9 and a follow-up of 4 enter as 13', () => {
        const stats = taskUsageStats(
            [task('t1', T(10, 5))],
            [
                run({ rootJobId: 't1', createdAt: '2026-08-19T00:00:00Z', agentTurns: 9 }),
                run({ rootJobId: 't1', createdAt: '2026-08-20T00:00:00Z', agentTurns: 4 }),
            ]
        );
        expect(stats.agentTurnsPerTask).toEqual({ avg: 13, p50: 13, p95: 13, tasks: 1 });
    });

    it('excludes a task with any unmeasured run from the turn distribution only', () => {
        // A partial sum presented as a total is a quiet undercount, so the task drops out of
        // THIS figure — while its tokens and job turns still count in theirs.
        const stats = taskUsageStats(
            [task('t1', T(500, 500))],
            [
                run({ rootJobId: 't1', createdAt: '2026-08-19T00:00:00Z', agentTurns: 7 }),
                run({ rootJobId: 't1', createdAt: '2026-08-20T00:00:00Z', agentTurns: null }),
            ]
        );
        expect(stats.agentTurnsPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
        expect(stats.tokensPerTask.tasks).toBe(1);
        expect(stats.jobTurnsPerTask).toEqual({ avg: 2, p50: 2, p95: 2, tasks: 1 });
    });

    it('stores a genuine zero when the root conversation took no assistant response', () => {
        const stats = taskUsageStats([task('t1', T(10, 5))], [run({ rootJobId: 't1', agentTurns: 0 })]);
        expect(stats.agentTurnsPerTask).toEqual({ avg: 0, p50: 0, p95: 0, tasks: 1 });
    });
});

describe('range interaction', () => {
    // A two-day range; the report is reduced over the same window by the caller.
    const range: DateRange = {
        preset: 'custom',
        from: '2026-08-19T00:00:00.000Z',
        to: '2026-08-21T00:00:00.000Z',
    };

    it('includes a task known only through a run queued in the range', () => {
        // No usage point ever landed for this thread (the plugin was off); the run row alone
        // puts the task in scope for the turn figures.
        const stats = taskUsageStats([], [run({ rootJobId: 't9', createdAt: '2026-08-20T08:00:00Z', agentTurns: 11 })]);
        expect(stats.jobTurnsPerTask).toEqual({ avg: 1, p50: 1, p95: 1, tasks: 1 });
        expect(stats.agentTurnsPerTask).toEqual({ avg: 11, p50: 11, p95: 11, tasks: 1 });
        // No attributed usage carries measured tokens: excluded, not zeroed.
        expect(stats.tokensPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
    });

    it('keeps out a run queued after the range and a task with no usage in it', () => {
        const runs = [run({ rootJobId: 't2', createdAt: '2026-08-21T01:00:00Z' })];
        const stats = taskUsageStats([], filterJobRuns(runs, range));
        expect(stats.tokensPerTask.tasks).toBe(0);
        expect(stats.jobTurnsPerTask.tasks).toBe(0);
    });
});

describe('caller scope', () => {
    it("narrows the run set to the caller's runs; the usage report is scoped by the caller", () => {
        const ALICE_AGENT_TURNS = 3;
        const stats = taskUsageStats(
            [task('t1', T(10, 5))],
            [
                run({ rootJobId: 't1', createdBy: ALICE.id, agentTurns: ALICE_AGENT_TURNS }),
                run({ rootJobId: 't2', createdBy: BOB.id, agentTurns: 4 }),
            ],
            { user: { id: ALICE.id } }
        );
        expect(stats.tokensPerTask).toEqual({ avg: 15, p50: 15, p95: 15, tasks: 1 });
        expect(stats.jobTurnsPerTask.tasks).toBe(1);
        expect(stats.agentTurnsPerTask.p50).toBe(ALICE_AGENT_TURNS);
    });

    it('leaves runs without attribution out of a caller scope, and keeps them in the org scope', () => {
        const runs = [run({ rootJobId: 't1', createdBy: null, agentTurns: 5 })];
        expect(taskUsageStats([], runs, { user: { id: ALICE.id } }).jobTurnsPerTask.tasks).toBe(0);
        expect(taskUsageStats([], runs).jobTurnsPerTask.tasks).toBe(1);
    });
});

describe('repo scope', () => {
    it('excludes out-of-repo runs from the run distributions', () => {
        const stats = taskUsageStats(
            [task('t1', T(1000, 1000))],
            [run({ rootJobId: 't1', agentTurns: 3 }), run({ rootJobId: 't2', agentTurns: 4, repo: 'other/repo' })],
            { repos: ['o/r'] }
        );
        expect(stats.agentTurnsPerTask).toEqual({ avg: 3, p50: 3, p95: 3, tasks: 1 });
        // A run with no repo label is out the same way: it never reached the totals either.
        expect(
            taskUsageStats([], [run({ rootJobId: 't3', repo: null })], { repos: ['o/r'] }).jobTurnsPerTask.tasks
        ).toBe(0);
    });
});

describe('wall clock per task', () => {
    it('sums the runs banked wall clock per thread, as a distribution over tasks', () => {
        const stats = taskUsageStats(
            [],
            [
                run({ rootJobId: 't1', wallClockMs: 60_000 }),
                run({ rootJobId: 't1', wallClockMs: 30_000 }),
                run({ rootJobId: 't2', wallClockMs: 200_000 }),
            ]
        );
        // Nearest-rank over [90_000, 200_000]: p50 is the 1st of the sort, p95 the 2nd.
        expect(stats.wallClockPerTask).toEqual({ avg: 145_000, p50: 90_000, p95: 200_000, tasks: 2 });
    });

    it('excludes a task with any unmeasured run from this distribution only', () => {
        // t2's run never executed (null wall clock = never ran, not zero); both tasks carry
        // measured tokens, so both count in tokens while only t1 counts in wall clock.
        const stats = taskUsageStats(
            [task('t1', T(1000, 1000)), task('t2', T(1000, 1000))],
            [run({ rootJobId: 't1', wallClockMs: 60_000 }), run({ rootJobId: 't2', wallClockMs: null })]
        );
        expect(stats.wallClockPerTask).toEqual({ avg: 60_000, p50: 60_000, p95: 60_000, tasks: 1 });
        expect(stats.tokensPerTask.tasks).toBe(2);
    });

    it('counts a task with no in-range run as zero banked time, not missing', () => {
        const stats = taskUsageStats([task('t1', T(10, 5))], []);
        expect(stats.wallClockPerTask).toEqual({ avg: 0, p50: 0, p95: 0, tasks: 1 });
    });

    it('answers null figures, not zeros, when no task is measured', () => {
        const stats = taskUsageStats([], []);
        expect(stats.wallClockPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
    });
});

describe('payload hygiene', () => {
    it('exposes no monetary field anywhere', () => {
        // Cost is deliberately out of scope (docs/metrics.md). This stops it returning via a
        // "small addition" to the new block.
        const stats = taskUsageStats(threeTasks, [run({ agentTurns: 3 })]);
        const keys: string[] = [];
        const walk = (value: unknown) => {
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object') {
                for (const [k, v] of Object.entries(value)) {
                    keys.push(k.toLowerCase());
                    walk(v);
                }
            }
        };
        walk(stats);
        for (const forbidden of ['cost', 'usd', 'price', 'dollars']) {
            expect(keys).not.toContain(forbidden);
        }
    });
});
