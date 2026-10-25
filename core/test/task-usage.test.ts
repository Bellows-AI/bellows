import { describe, expect, it } from 'vitest';
import { filterJobRuns } from '../src/range.js';
import type { DateRange } from '../src/range.js';
import { taskUsageStats } from '../src/task-usage.js';
import { UNKNOWN_BUCKET } from '../src/token-contributions.js';
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

/** A task whose block carries per-model parent rows (children deliberately differ from the parent). */
function modelTask(
    taskId: string,
    rows: { model: string; raw?: string[]; tokens: TokenTotals; children?: TokenTotals[] }[],
    over: {
        tokens?: TokenTotals;
        coverage?: Partial<Record<keyof TokenTotals, { measured: number; contributors: number }>>;
    } = {}
): TaskUsage {
    const base = task(taskId, over.tokens ?? T(null, null));
    return {
        ...base,
        usage: {
            ...base.usage,
            coverage: { ...base.usage.coverage, ...over.coverage },
            rows: rows.map((r) => ({
                model: r.model,
                rawModels: r.raw ?? [r.model],
                querySource: null,
                tokens: r.tokens,
                ...(r.children === undefined
                    ? {}
                    : {
                          children: r.children.map((tokens) => ({
                              model: r.model,
                              rawModels: r.raw ?? [r.model],
                              querySource: 'main',
                              tokens,
                          })),
                      }),
            })),
        },
    };
}

const cell = (
    input: number | null,
    output: number | null,
    cacheRead: number | null = null,
    cacheCreation: number | null = null
): TokenTotals => ({
    input,
    output,
    cacheRead,
    cacheCreation,
});

const threeTasks = [task('t1', T(600, 400)), task('t2', T(1200, 800)), task('t3', T(2400, 600))];

describe('token distributions per type', () => {
    // Output per task over A..G: A 100, B 0 (measured zero), C 300, D null (excluded), E 500 (partial),
    // F 700 (removed), G 900 (review folded). Contributors = 6 -> sorted 0,100,300,500,700,900.
    // avg = 2500/6; p50 = ceil(0.5*6)=3rd = 300; p95 = ceil(0.95*6)=6th = 900.
    const world = [
        task('A', cell(1, 100)),
        task('B', cell(2, 0)),
        task('C', cell(3, 300)),
        task('D', cell(4, null)),
        {
            ...task('E', cell(5, 500)),
            usage: {
                ...task('E', cell(5, 500)).usage,
                coverage: { ...emptyBlock('measured').coverage, output: { measured: 1, contributors: 2 } },
            },
        },
        task('F', cell(6, 700), true),
        task('G', cell(7, 900)),
    ];

    it('counts a measured zero, excludes an unmeasured task, flags partial contributors', () => {
        const out = taskUsageStats(world, []).tokens.all.output;
        expect(out).toEqual({ avg: 2500 / 6, p50: 300, p95: 900, tasks: 6, partial: 1, tasksInScope: 7 });
    });

    it('keeps the four types separate: each has its own contributors', () => {
        const all = taskUsageStats(world, []).tokens.all;
        // input is measured for all 7: 1..7 -> avg 4, p50 = ceil(3.5)=4th = 4, p95 = ceil(6.65)=7th = 7.
        expect(all.input).toMatchObject({ avg: 4, p50: 4, p95: 7, tasks: 7 });
        expect(all.cacheRead).toEqual({ avg: null, p50: null, p95: null, tasks: 0, partial: 0, tasksInScope: 7 });
    });

    it('nearest-rank edges: N=1 and N=20 (p95 is the 19th)', () => {
        expect(taskUsageStats([task('a', cell(null, 42))], []).tokens.all.output).toMatchObject({ p50: 42, p95: 42 });
        const twenty = Array.from({ length: 20 }, (_, i) => task(`t${i}`, cell(null, (i + 1) * 10)));
        // values 10..200; p95 = ceil(0.95*20)=19th = 190; p50 = 10th = 100.
        expect(taskUsageStats(twenty, []).tokens.all.output).toMatchObject({ p50: 100, p95: 190, avg: 105 });
    });

    it('answers null figures, not zeros, when nothing is measured', () => {
        const stats = taskUsageStats([], []);
        expect(stats.tokens.all.output).toEqual({
            avg: null,
            p50: null,
            p95: null,
            tasks: 0,
            partial: 0,
            tasksInScope: 0,
        });
        expect(stats.tokens.byModel).toEqual([]);
        expect(stats.jobTurnsPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
    });

    describe('by model', () => {
        // m1 spans a [1m] raw variant. T1: m1 out 100 (children 60+60 would double count to 220),
        // m2 out 50. T2: m1 out 300. T3: m2 out null (unmeasured), m1 absent. T4: unknown model out 0.
        const tasks = [
            modelTask('T1', [
                {
                    model: 'm1',
                    raw: ['m1', 'm1[1m]'],
                    tokens: cell(null, 100),
                    children: [cell(null, 60), cell(null, 60)],
                },
                { model: 'm2', tokens: cell(null, 50) },
            ]),
            modelTask('T2', [{ model: 'm1', raw: ['m1[1m]'], tokens: cell(null, 300) }]),
            modelTask('T3', [{ model: 'm2', tokens: cell(null, null) }]),
            modelTask('T4', [{ model: UNKNOWN_BUCKET, tokens: cell(null, 0) }]),
        ];
        const byModel = taskUsageStats(tasks, []).tokens.byModel;
        const group = (m: string) => byModel.find((g) => g.model === m);

        it('lists models by contributing tasks desc then name, with their raw variants', () => {
            // m1: T1,T2 (2 tasks); m2: T1,T3 (2 tasks); the unknown bucket: T4 (1).
            expect(byModel.map((g) => g.model)).toEqual(['m1', 'm2', UNKNOWN_BUCKET]);
            expect(group('m1')?.rawModels).toEqual(['m1', 'm1[1m]']);
        });

        it('uses per-model denominators and never adds children to their parent', () => {
            // m1 output: 100 and 300 -> avg 200, p50 = 1st = 100, p95 = 2nd = 300 (not 220).
            expect(group('m1')?.dist.output).toMatchObject({ avg: 200, p50: 100, p95: 300, tasks: 2, tasksInScope: 4 });
            // m2: T1 50; T3 unmeasured -> excluded.
            expect(group('m2')?.dist.output).toMatchObject({ avg: 50, tasks: 1 });
            // measured zero participates.
            expect(group(UNKNOWN_BUCKET)?.dist.output).toMatchObject({ avg: 0, p50: 0, tasks: 1 });
        });
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

    it('takes one value per canonical task per type, never input plus output', () => {
        const expected = report.tasks.flatMap((t) => (t.usage.tokens.output === null ? [] : [t.usage.tokens.output]));
        expect(stats.tokens.all.output.tasks).toBe(expected.length);
        expect(stats.tokens.all.output.avg).toBe(expected.reduce((a, b) => a + b, 0) / expected.length);
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
        expect(stats.tokens.all.input.tasks).toBe(1);
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
        expect(stats.tokens.all.input.tasks).toBe(1);
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
        expect(stats.tokens.all.input.tasks).toBe(0);
    });

    it('keeps out a run queued after the range and a task with no usage in it', () => {
        const runs = [run({ rootJobId: 't2', createdAt: '2026-08-21T01:00:00Z' })];
        const stats = taskUsageStats([], filterJobRuns(runs, range));
        expect(stats.tokens.all.input.tasks).toBe(0);
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
        expect(stats.tokens.all.input).toMatchObject({ avg: 10, p50: 10, p95: 10, tasks: 1 });
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

describe('runs and tokens filter on different owners', () => {
    it('lets the run-based and token distributions cover different task sets', () => {
        // The usage report names t1 (its owner is in scope); the run rows name t2 (queued in scope,
        // no attributed session). Tokens: t1 only -> 1 task. Job turns: t1 banks 0 runs, t2 has 1
        // run -> 2 tasks, values 0 and 1.
        const stats = taskUsageStats([task('t1', T(10, 5))], [run({ rootJobId: 't2' })]);
        expect(stats.tokens.all.input.tasks).toBe(1);
        expect(stats.jobTurnsPerTask.tasks).toBe(2);
        expect(stats.jobTurnsPerTask).toMatchObject({ avg: 0.5, p50: 0, p95: 1 });
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
        expect(stats.tokens.all.input.tasks).toBe(2);
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
