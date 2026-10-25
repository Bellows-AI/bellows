import { describe, expect, it } from 'vitest';
import { reduceTokenObservations } from '../src/token-contributions.js';
import type { TokenContribution, TokenType } from '../src/token-contributions.js';
import { resolveOwnership, sessionKeyId } from '../src/usage-ownership.js';
import { reduceUsage, taskUsageOf } from '../src/usage-reduce.js';
import type { ExecutionEvidence, Tokens, UsageBlock, UsageInput } from '../src/usage.js';
import { TOKEN_TYPE_LIST, addTokens, emptyBlock } from '../src/usage.js';
import {
    ALL,
    NOW,
    at,
    branch,
    cumulative,
    delta,
    ev,
    none,
    out,
    unlocated,
    unresolvedPoint,
    world,
} from './usage-fixtures.js';

const EMPTY_DIAGNOSTIC = {
    sessions: 0,
    tokens: none(),
    unlocated: none(),
    unresolvedTemporality: { observations: 0 },
};
const sumTypes = (parts: Tokens[]): Tokens => parts.reduce((a, b) => addTokens(a, b), none());
const unassignedSum = (b: UsageBlock): Tokens => sumTypes(b.unassigned.map((u) => u.tokens));

/** eligible timed = assigned + unassigned, per type, null-aware. */
function expectConserved(b: UsageBlock): void {
    expect(addTokens(b.assigned, unassignedSum(b))).toEqual(b.tokens);
}

/** Task T1: root run [0,10), follow-up fu1 [12,20) on one shared session sA; review rev1 [30,40) on sR. */
function sharedWorld(extra: Partial<UsageInput> = {}): UsageInput {
    return world({
        board: [
            ev({ jobId: 'root1', rootJobId: 'root1', sessionId: 'sA', startedAt: at(0), endedAt: at(10) }),
            ev({ jobId: 'fu1', rootJobId: 'root1', sessionId: 'sA', startedAt: at(12), endedAt: at(20) }),
            ev({
                jobId: 'rev1',
                rootJobId: 'rev1',
                requestingJobId: 'root1',
                requestingRootJobId: 'root1',
                sessionId: 'sR',
                startedAt: at(30),
                endedAt: at(40),
            }),
        ],
        contributions: [
            delta(5, 100, { session: 'sA' }),
            delta(5, 7, { session: 'sA', type: 'input' }),
            delta(11, 40, { session: 'sA' }),
            delta(15, 60, { session: 'sA' }),
            delta(35, 25, { session: 'sR' }),
        ],
        ...extra,
    });
}

describe('shared-session follow-ups, reviews and the task view', () => {
    const report = reduceUsage(sharedWorld(), ALL);

    it('splits one session across runs and keeps the gap task-owned (hand computed)', () => {
        // output: 100 + 40 + 60 + 25 = 225; assigned 100 + 60 + 25 = 185; no-segment 40. input: 7 only.
        expect(report.eligible.tokens).toEqual({ input: 7, output: 225, cacheRead: null, cacheCreation: null });
        expect(report.eligible.assigned).toEqual({ input: 7, output: 185, cacheRead: null, cacheCreation: null });
        expect(report.eligible.unassigned).toEqual([{ reason: 'no-segment', tokens: out(40) }]);
        expect(report.eligible.counts).toEqual({ sessions: 2, runs: 3, tasks: 1 });
        expectConserved(report.eligible);
    });

    it('folds the named review into its requester: one task, own job id kept, kind review', () => {
        expect(report.tasks.map((t) => t.taskId)).toEqual(['root1']);
        const task = report.tasks[0]!;
        expect(task.runs.map((r) => [r.jobId, r.kind, r.reviewOf])).toEqual([
            ['root1', 'run', null],
            ['fu1', 'follow-up', null],
            ['rev1', 'review', 'root1'],
        ]);
        expect(task.runs.map((r) => r.usage.tokens.output)).toEqual([100, 60, 25]);
        expect(task.taskOwned?.tokens).toEqual(out(40));
    });

    it('task usage equals the sum of its runs plus the task-owned part, per type', () => {
        const task = report.tasks[0]!;
        const parts = [...task.runs.map((r) => r.usage.tokens), ...(task.taskOwned ? [task.taskOwned.tokens] : [])];
        expect(sumTypes(parts)).toEqual(task.usage.tokens);
    });

    it('taskUsageOf equals the stats task, lists runs without usage, and returns null for an unknown task', () => {
        const withIdle = sharedWorld({
            board: [
                ...sharedWorld().board,
                ev({ jobId: 'idle', rootJobId: 'root1', sessionId: 'sI', startedAt: at(50), endedAt: at(60) }),
            ],
        });
        const task = taskUsageOf(withIdle, 'root1', NOW)!;
        expect(task.usage.tokens).toEqual(report.tasks[0]!.usage.tokens);
        expect(task.runs.map((r) => r.jobId)).toEqual(['root1', 'fu1', 'rev1', 'idle']);
        expect(task.runs[3]!.usage.state).toBe('unmeasured');
        expect(taskUsageOf(withIdle, 'missing', NOW)).toBeNull();
    });

    it('adds no entry for a task that is absent from the evidence', () => {
        expect(taskUsageOf(world(), 'root1', NOW)).toBeNull();
        expect(reduceUsage(world(), ALL).tasks).toEqual([]);
    });

    it('does not change totals, counts or per-run usage when an adopting claim row is added after the points', () => {
        const base = world({
            board: [ev({ claimSeq: 1, startedAt: at(0), endedAt: at(10) })],
            contributions: [delta(3, 10), delta(8, 20)],
        });
        const adopted = world({
            ...base,
            board: [
                ...base.board,
                ev({ claimSeq: 2, launch: 'adopted', adoptsClaimSeq: 1, startedAt: at(15), endedAt: at(25) }),
            ],
        });
        const a = reduceUsage(base, ALL);
        const b = reduceUsage(adopted, ALL);
        expect(b.eligible).toEqual(a.eligible);
        expect(b.tasks[0]!.runs.map((r) => r.usage.tokens)).toEqual(a.tasks[0]!.runs.map((r) => r.usage.tokens));
        expect(b.eligible.counts).toEqual({ sessions: 1, runs: 1, tasks: 1 });
    });

    it('a point in the gap between two claims is assigned only when the later claim adopts the earlier', () => {
        const first = ev({ claimSeq: 1, startedAt: at(0), endedAt: at(10) });
        const at12 = [delta(12, 7)];
        const recovered = reduceUsage(
            world({ board: [first, ev({ claimSeq: 2, startedAt: at(15), endedAt: at(25) })], contributions: at12 }),
            ALL
        );
        expect(recovered.eligible.assigned).toEqual(none());
        expect(recovered.eligible.unassigned).toEqual([{ reason: 'no-segment', tokens: out(7) }]);
        const adopted = reduceUsage(
            world({
                board: [
                    first,
                    ev({ claimSeq: 2, launch: 'adopted', adoptsClaimSeq: 1, startedAt: at(15), endedAt: at(25) }),
                ],
                contributions: at12,
            }),
            ALL
        );
        expect(adopted.eligible.assigned).toEqual(out(7));
        expect(adopted.eligible.unassigned).toEqual([]);
    });

    it('keeps one run for same-row recovery (two claims, one job) and counts it once', () => {
        const input = world({
            board: [
                ev({ claimSeq: 1, startedAt: at(0), endedAt: at(10) }),
                ev({ claimSeq: 2, startedAt: at(15), endedAt: at(25) }),
            ],
            contributions: [delta(5, 1), delta(12, 2), delta(20, 4)],
        });
        const r = reduceUsage(input, ALL);
        expect(r.eligible.counts.runs).toBe(1);
        expect(r.eligible.assigned).toEqual(out(5));
        expect(r.eligible.unassigned).toEqual([{ reason: 'no-segment', tokens: out(2) }]);
    });

    it('a workflow node (own job, shared root) joins its task as a follow-up-kind run', () => {
        const input = world({
            board: [
                ev({ jobId: 'root1', rootJobId: 'root1', sessionId: 'sA', startedAt: at(0), endedAt: at(10) }),
                ev({ jobId: 'node2', rootJobId: 'root1', sessionId: 'sB', startedAt: at(10), endedAt: at(20) }),
            ],
            contributions: [delta(2, 3, { session: 'sA' }), delta(12, 4, { session: 'sB' })],
        });
        const r = reduceUsage(input, ALL);
        expect(r.tasks).toHaveLength(1);
        expect(r.tasks[0]!.runs.map((x) => [x.jobId, x.kind])).toEqual([
            ['root1', 'run'],
            ['node2', 'follow-up'],
        ]);
    });
});

describe('ownership in the report', () => {
    it('a session shared by two tasks is unresolved, outside eligible and visible only as a tenant diagnostic', () => {
        const input = world({
            board: [
                ev({ jobId: 'a', rootJobId: 'ta' }),
                ev({ jobId: 'b', rootJobId: 'tb', startedAt: at(20), endedAt: at(30) }),
            ],
            contributions: [delta(5, 9)],
        });
        const forward = reduceUsage(input, ALL);
        const reversed = reduceUsage(
            { ...input, board: [...input.board].reverse(), contributions: [...input.contributions].reverse() },
            ALL
        );
        expect(forward.eligible.tokens).toEqual(none());
        expect(forward.diagnostics.unresolvedOwnership).toEqual({ ...EMPTY_DIAGNOSTIC, sessions: 1, tokens: out(9) });
        expect(reversed).toEqual(forward);
    });

    it('leaks nothing of a foreign-org session: not in tokens, not in any count, not in the JSON', () => {
        const input = world({
            board: [ev({ sessionId: 'foreign-marker-session' })],
            branch: [branch({ sessionId: 'foreign-marker-session' })],
            foreignSessionIds: new Set(['foreign-marker-session']),
            contributions: [delta(5, 1234, { session: 'foreign-marker-session' })],
        });
        const r = reduceUsage(input, ALL);
        expect(JSON.stringify(r)).not.toContain('foreign-marker');
        expect(JSON.stringify(r)).not.toContain('1234');
        expect(r.diagnostics).toEqual({
            sessionsWithoutHook: 0,
            unresolvedOwnership: EMPTY_DIAGNOSTIC,
            excludedRepo: EMPTY_DIAGNOSTIC,
        });
    });

    it('hides an unowned session from every tenant, single-org installs included', () => {
        const r = reduceUsage(world({ contributions: [delta(5, 8)] }), ALL);
        expect(r.eligible.state).toBe('unmeasured');
        expect(r.byUser).toEqual([]);
    });

    it('a branch-only session is resolved, no-task, in the unknown-user bucket and outside scope=mine', () => {
        const input = world({ branch: [branch()], contributions: [delta(5, 6)] });
        const r = reduceUsage(input, ALL);
        expect(r.eligible.unassigned).toEqual([{ reason: 'no-task', tokens: out(6) }]);
        expect(r.byUser).toEqual([{ userId: null, usage: expect.objectContaining({ tokens: out(6) }) }]);
        expect(reduceUsage(input, { ...ALL, userId: 'u1' }).eligible.state).toBe('unmeasured');
    });

    it('a board-owned hook-less session is included and counted in sessionsWithoutHook', () => {
        const r = reduceUsage(world({ board: [ev()], contributions: [delta(5, 6)] }), ALL);
        expect(r.eligible.tokens).toEqual(out(6));
        expect(r.diagnostics.sessionsWithoutHook).toBe(1);
        const hooked = reduceUsage(world({ board: [ev()], branch: [branch()], contributions: [delta(5, 6)] }), ALL);
        expect(hooked.diagnostics.sessionsWithoutHook).toBe(0);
    });

    it('a removed task keeps its usage, is flagged, and its runs are not operational', () => {
        const input = world({ board: [ev({ removed: true, operational: false })], contributions: [delta(5, 6)] });
        const r = reduceUsage(input, ALL);
        expect(r.tasks[0]).toMatchObject({ taskId: 'j1', removed: true });
        expect(r.tasks[0]!.runs[0]).toMatchObject({ operational: false });
        expect(r.eligible.tokens).toEqual(out(6));
    });

    it('scope=mine takes the trusted author only; a null or conflicted author is outside', () => {
        const input = world({
            board: [
                ev({ jobId: 'a', rootJobId: 'a', sessionId: 'sa', authorId: 'u1' }),
                ev({ jobId: 'b', rootJobId: 'b', sessionId: 'sb', authorId: 'u2' }),
                ev({ jobId: 'c', rootJobId: 'c', sessionId: 'sc', authorId: null }),
                ev({ jobId: 'd', rootJobId: 'd', sessionId: 'sd', authorId: 'u1' }),
                ev({
                    jobId: 'd',
                    rootJobId: 'd',
                    sessionId: 'sd',
                    claimSeq: 2,
                    authorId: 'u2',
                    startedAt: at(20),
                    endedAt: at(30),
                }),
            ],
            contributions: [
                delta(1, 1, { session: 'sa' }),
                delta(1, 10, { session: 'sb' }),
                delta(1, 100, { session: 'sc' }),
                delta(1, 1000, { session: 'sd' }),
            ],
        });
        expect(reduceUsage(input, { ...ALL, userId: 'u1' }).eligible.tokens).toEqual(out(1));
        expect(reduceUsage(input, { ...ALL, userId: 'u2' }).eligible.tokens).toEqual(out(10));
        const all = reduceUsage(input, ALL);
        expect(all.byUser.map((u) => [u.userId, u.usage.tokens.output])).toEqual([
            ['u1', 1],
            ['u2', 10],
            [null, 1100],
        ]);
    });

    it('a repo filter moves other repos to excludedRepo only; a repo-less session cannot pass a filter', () => {
        const input = world({
            board: [
                ev({ jobId: 'a', rootJobId: 'a', sessionId: 'sa', repo: 'repo-1' }),
                ev({ jobId: 'b', rootJobId: 'b', sessionId: 'sb', repo: 'repo-2' }),
                ev({ jobId: 'c', rootJobId: 'c', sessionId: 'sc', repo: null }),
            ],
            contributions: [
                delta(1, 1, { session: 'sa' }),
                delta(1, 10, { session: 'sb' }),
                delta(1, 100, { session: 'sc' }),
            ],
        });
        const filtered = reduceUsage(input, { ...ALL, repos: ['repo-1'] });
        expect(filtered.eligible.tokens).toEqual(out(1));
        expect(filtered.diagnostics.excludedRepo).toEqual({ ...EMPTY_DIAGNOSTIC, sessions: 2, tokens: out(110) });
        expect(reduceUsage(input, ALL).eligible.tokens).toEqual(out(111));
        expectConserved(filtered.eligible);
    });
});

describe('null versus measured zero, precision, coverage, rows', () => {
    it('keeps an unmeasured type null everywhere and a measured zero 0', () => {
        const input = world({
            board: [ev()],
            contributions: [delta(5, 0, { type: 'input' }), delta(6, 4)],
        });
        const r = reduceUsage(input, ALL);
        expect(r.eligible.tokens).toEqual({ input: 0, output: 4, cacheRead: null, cacheCreation: null });
        expect(r.eligible.assigned.cacheRead).toBeNull();
        expect(r.eligible.rows[0]!.tokens.cacheCreation).toBeNull();
        expect(r.series.every((s) => s.usage.tokens.cacheRead === null)).toBe(true);
        expect(r.eligible.unassigned).toEqual([]);
        expect(JSON.stringify(r)).not.toMatch(/"(total|cost|usd|price)"/i);
    });

    it('reports exact, estimated and mixed precision per type; coverage marks a partial type', () => {
        const input = world({
            board: [ev({ sessionId: 's1' }), ev({ jobId: 'j2', rootJobId: 'j2', sessionId: 's2' })],
            contributions: [
                delta(2, 1, { session: 's1' }),
                delta(3, 1, { session: 's2', type: 'input' }),
                cumulative(1, 4, 5, { session: 's1', type: 'cacheRead' }),
                delta(5, 1, { session: 's1', type: 'cacheCreation' }),
                cumulative(1, 6, 5, { session: 's2', type: 'cacheCreation' }),
            ],
        });
        const b = reduceUsage(input, ALL).eligible;
        expect(b.precision).toEqual({
            output: 'exact',
            input: 'exact',
            cacheRead: 'estimated',
            cacheCreation: 'mixed',
        });
        expect(b.coverage.output).toEqual({ measured: 1, contributors: 2 });
        expect(b.coverage.cacheCreation).toEqual({ measured: 2, contributors: 2 });
        expect(reduceUsage(world(), ALL).eligible.precision.output).toBeNull();
    });

    it('builds model rows that sum to tokens, share a parent across [1m] variants and expand to query sources', () => {
        const input = world({
            board: [ev()],
            contributions: [
                delta(1, 10, { model: 'm-1', querySource: 'main' }),
                delta(2, 20, { model: 'm-1[1m]', querySource: 'sub' }),
                delta(3, 5, { model: null, querySource: null }),
                delta(4, 7, { model: 'm-2', querySource: '' }),
            ],
        });
        const { eligible } = reduceUsage(input, ALL);
        expect(eligible.rows.map((r) => [r.model, r.rawModels, r.tokens.output])).toEqual([
            ['m-1', ['m-1', 'm-1[1m]'], 30],
            ['m-2', ['m-2'], 7],
            ['unknown', [], 5],
        ]);
        expect(eligible.rows[0]!.children!.map((c) => [c.querySource, c.tokens.output])).toEqual([
            ['main', 10],
            ['sub', 20],
        ]);
        expect(eligible.rows[1]!.children![0]!.querySource).toBe('unknown');
        expect(sumTypes(eligible.rows.map((r) => r.tokens))).toEqual(eligible.tokens);
        for (const row of eligible.rows) expect(sumTypes(row.children!.map((c) => c.tokens))).toEqual(row.tokens);
        expect(eligible.counts).toEqual({ sessions: 1, runs: 1, tasks: 1 });
    });

    it('emptyBlock is all-null with no reasons', () => {
        const b = emptyBlock('unmeasured');
        expect(b.tokens).toEqual(none());
        expect(b.unassigned).toEqual([]);
        expect(b.counts).toEqual({ sessions: 0, runs: 0, tasks: 0 });
    });
});

describe('range, series, unlocated and unresolved', () => {
    const base = world({ board: [ev({ startedAt: at(-60 * 24 * 3), endedAt: null, live: true })] });

    it('ignores observations with no session: they are not ownable', () => {
        const r = reduceUsage(world({ board: [ev()], contributions: [delta(5, 3, { session: null })] }), ALL);
        expect(r.eligible.state).toBe('unmeasured');
    });

    it('partitions at point time half-open: a point at to is excluded, at from included; adjacent ranges sum to the union', () => {
        const input = { ...base, contributions: [delta(0, 1), delta(60, 10), delta(119, 100), delta(120, 1000)] };
        const R = (from: number, to: number) =>
            reduceUsage(input, { ...ALL, range: { from: at(from), to: at(to) } }).eligible.tokens;
        expect(R(0, 60)).toEqual(out(1));
        expect(R(60, 120)).toEqual(out(110));
        expect(R(0, 120)).toEqual(out(111));
        expect(R(120, 180)).toEqual(out(1000));
    });

    it('uses point time, not receipt time: a late-exported observation lands where it was observed', () => {
        const contributions = reduceTokenObservations([
            {
                agent: 'claude-code',
                sessionId: 's1',
                source: 'otel',
                metric: 'm',
                field: 'output',
                temporality: 'delta',
                startTime: null,
                time: at(5),
                value: 42,
                attrs: { model: 'm-1' },
            },
        ]);
        const input = { ...base, contributions };
        const lateNow = new Date(Date.parse(at(5)) + 40 * 86_400_000);
        const first = reduceUsage(input, { range: { from: at(0), to: at(10) }, now: lateNow });
        const second = reduceUsage(input, { range: { from: at(10), to: at(20) }, now: lateNow });
        expect(first.eligible.tokens).toEqual(out(42));
        expect(second.eligible.state).toBe('unmeasured');
    });

    it('splits a midnight crossing into two UTC days whose tokens sum to the total', () => {
        const input = world({
            board: [ev({ startedAt: '2026-03-01T00:00:00.000Z', endedAt: null })],
            contributions: [
                { ...delta(0, 3), observedAt: '2026-03-02T23:59:59.999Z' },
                { ...delta(0, 4), observedAt: '2026-03-03T00:00:00.000Z' },
            ],
        });
        const r = reduceUsage(input, { ...ALL, now: new Date('2026-03-03T12:00:00.000Z') });
        expect(r.series.map((s) => [s.start, s.usage.tokens.output, s.partial])).toEqual([
            ['2026-03-02', 3, false],
            ['2026-03-03', 4, true],
        ]);
        expect(r.series[1]!.usage.provisional).toBe(true);
        expect(r.series[0]!.usage.provisional).toBe(false);
    });

    it('seeds quiet buckets as unmeasured and a weekly series sums to the total', () => {
        const input = world({
            board: [ev({ startedAt: '2026-02-01T00:00:00.000Z', endedAt: null })],
            contributions: [
                { ...delta(0, 3), observedAt: '2026-03-02T10:00:00.000Z' },
                { ...delta(0, 5), observedAt: '2026-03-04T10:00:00.000Z' },
                { ...delta(0, 8), observedAt: '2026-03-18T10:00:00.000Z' },
            ],
        });
        const r = reduceUsage(input, { ...ALL, granularity: 'week' });
        expect(r.series.map((s) => [s.start, s.usage.state, s.usage.tokens.output])).toEqual([
            ['2026-03-02', 'measured', 8],
            ['2026-03-09', 'unmeasured', null],
            ['2026-03-16', 'measured', 8],
        ]);
        expect(sumTypes(r.series.map((s) => s.usage.tokens))).toEqual(r.eligible.tokens);
    });

    it('keeps unlocated and unresolved out of tokens, shown for a range only when the session span overlaps', () => {
        const input = {
            ...base,
            contributions: [delta(5, 1), unlocated(500), unresolvedPoint(5, 9)],
            spans: [{ agent: 'claude-code', sessionId: 's1', firstSeen: at(0), lastSeen: at(30) }],
        };
        const all = reduceUsage(input, ALL).eligible;
        expect(all.tokens).toEqual(out(1));
        expect(all.unlocated).toEqual(out(500));
        expect(all.unresolvedTemporality).toEqual({ observations: 1 });
        const inside = reduceUsage(input, { ...ALL, range: { from: at(10), to: at(20) } }).eligible;
        expect(inside.unlocated).toEqual(out(500));
        const outside = reduceUsage(input, { ...ALL, range: { from: at(60), to: at(70) } }).eligible;
        expect(outside.unlocated).toEqual(none());
        expect(outside.unresolvedTemporality.observations).toBe(0);
    });

    it('marks a block provisional when the range ends after now or an execution is live', () => {
        const input = { ...base, contributions: [delta(5, 1)] };
        expect(reduceUsage(input, ALL).eligible.provisional).toBe(true);
        const settled = world({ board: [ev()], contributions: [delta(5, 1)] });
        expect(reduceUsage(settled, ALL).eligible.provisional).toBe(false);
        expect(
            reduceUsage(settled, { ...ALL, range: { from: at(0), to: '2026-04-01T00:00:00.000Z' } }).eligible
                .provisional
        ).toBe(true);
    });
});

describe('amounts without timed usage are never dropped', () => {
    it('lists a task and an author that only have unlocated or unresolved-temporality usage', () => {
        const input = world({
            board: [ev({ jobId: 'tA', rootJobId: 'tA', sessionId: 'sA', authorId: 'uA' })],
            contributions: [unlocated(4, { session: 'sA' }), unresolvedPoint(5, 6, { session: 'sA' })],
        });
        const r = reduceUsage(input, ALL);
        expect(r.tasks.map((t) => t.taskId)).toEqual(['tA']);
        expect(r.tasks[0]!.usage.unlocated).toEqual(out(4));
        expect(r.tasks[0]!.usage.unresolvedTemporality).toEqual({ observations: 1 });
        expect(r.byUser.map((u) => u.userId)).toEqual(['uA']);
        expect(r.byUser[0]!.usage.unlocated).toEqual(out(4));
    });

    it('keeps unlocated and unresolved amounts of unresolved-owner and excluded-repo sessions in the diagnostics', () => {
        const input = world({
            board: [
                ev({ jobId: 'tA', rootJobId: 'tA', sessionId: 'sA', repo: 'repo-1' }),
                ev({ jobId: 'tB', rootJobId: 'tB', sessionId: 'sC', repo: 'repo-2' }),
                ev({ jobId: 'tC', rootJobId: 'tC', sessionId: 'sC', repo: 'repo-2' }),
            ],
            contributions: [
                unlocated(3, { session: 'sC' }),
                unresolvedPoint(5, 1, { session: 'sC' }),
                unlocated(8, { session: 'sA' }),
                unresolvedPoint(6, 1, { session: 'sA' }),
            ],
        });
        const d = reduceUsage(input, { ...ALL, repos: ['repo-1'] }).diagnostics;
        expect(d.unresolvedOwnership).toEqual({
            sessions: 1,
            tokens: none(),
            unlocated: out(3),
            unresolvedTemporality: { observations: 1 },
        });
        const e = reduceUsage(
            world({
                ...input,
                board: [input.board[0]!, ev({ jobId: 'tB', rootJobId: 'tB', sessionId: 'sB', repo: 'repo-2' })],
                contributions: [unlocated(9, { session: 'sB' }), unresolvedPoint(5, 1, { session: 'sB' })],
            }),
            { ...ALL, repos: ['repo-1'] }
        ).diagnostics.excludedRepo;
        expect(e).toEqual({
            sessions: 1,
            tokens: none(),
            unlocated: out(9),
            unresolvedTemporality: { observations: 1 },
        });
    });
});

describe('conservation over seeded random worlds', () => {
    function rng(seed: number): () => number {
        let s = seed;
        return () => {
            s = (s * 1664525 + 1013904223) % 4294967296;
            return s / 4294967296;
        };
    }
    const TYPES: TokenType[] = ['input', 'output', 'cacheRead', 'cacheCreation'];
    const LAUNCHES = ['observed', 'observed', 'requested', 'refused', 'unknown', 'adopted'] as const;

    function randomWorld(seed: number): UsageInput {
        const r = rng(seed);
        const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
        const board: ExecutionEvidence[] = [];
        const sessions = ['s1', 's2', 's3', 's4', 's5'];
        for (let i = 0; i < 12; i++) {
            const start = Math.floor(r() * 200);
            const task = pick(['t1', 't2', 't3']);
            board.push(
                ev({
                    jobId: `${task}-${pick(['a', 'b', 'c'])}`,
                    rootJobId: task,
                    claimSeq: 1 + Math.floor(r() * 3),
                    sessionId: pick(sessions.slice(0, 4)),
                    agent: pick(['claude-code', null]),
                    authorId: pick(['u1', 'u2', null]),
                    repo: pick(['repo-1', 'repo-2', null]),
                    launch: pick(LAUNCHES),
                    origin: r() < 0.1 ? 'backfill' : 'claim',
                    adoptsClaimSeq: r() < 0.2 ? 1 : null,
                    startedAt: at(start),
                    endedAt: r() < 0.2 ? null : at(start + 1 + Math.floor(r() * 80)),
                })
            );
        }
        const contributions: TokenContribution[] = [];
        for (let i = 0; i < 80; i++) {
            const session = pick(sessions);
            const type = pick(TYPES);
            const value = Math.floor(r() * 50);
            const t = Math.floor(r() * 300);
            contributions.push(
                r() < 0.3
                    ? cumulative(Math.max(0, t - Math.floor(r() * 60)), t, value, { session, type })
                    : delta(t, value, {
                          session,
                          type,
                          model: pick(['m-1', 'm-1[1m]', null, 'm-2']),
                          querySource: pick(['main', null, 'sub']),
                      })
            );
        }
        for (let i = 0; i < 20; i++) {
            const session = pick([...sessions, null]);
            const type = pick(TYPES);
            const value = Math.floor(r() * 50);
            contributions.push(
                r() < 0.5
                    ? unlocated(value, { session, type })
                    : unresolvedPoint(Math.floor(r() * 300), value, { session, type })
            );
        }
        for (let i = 0; i < 6; i++) {
            contributions.push(
                delta(Math.floor(r() * 300), Math.floor(r() * 50), { session: null, type: pick(TYPES) })
            );
        }
        return world({
            board,
            branch: [branch({ sessionId: 's5', repo: pick(['repo-1', 'repo-2']) })],
            foreignSessionIds: new Set(['s4']),
            contributions,
        });
    }

    for (let seed = 1; seed <= 25; seed++) {
        it(`holds eligible = assigned + unassigned in every view (seed ${seed})`, () => {
            const input = randomWorld(seed);
            const scopes = [
                { ...ALL },
                { ...ALL, repos: ['repo-1'] },
                { ...ALL, userId: 'u1' },
                { ...ALL, range: { from: at(50), to: at(150) } },
                {
                    ...ALL,
                    range: { from: at(50), to: at(150) },
                    repos: ['repo-2'],
                    userId: 'u2',
                    granularity: 'week' as const,
                },
            ];
            for (const opts of scopes) {
                const r = reduceUsage(input, opts);
                const blocks = [
                    r.eligible,
                    ...r.tasks.map((t) => t.usage),
                    ...r.byUser.map((u) => u.usage),
                    ...r.series.map((s) => s.usage),
                ];
                for (const b of blocks) {
                    expectConserved(b);
                    for (const row of b.rows) expect(sumTypes(row.children!.map((c) => c.tokens))).toEqual(row.tokens);
                    expect(sumTypes(b.rows.map((x) => x.tokens))).toEqual(b.tokens);
                }
                expect(sumTypes(r.byUser.map((u) => u.usage.tokens))).toEqual(r.eligible.tokens);
                expect(sumTypes(r.series.map((s) => s.usage.tokens))).toEqual(r.eligible.tokens);
                const noTask = r.eligible.unassigned.find((u) => u.reason === 'no-task')?.tokens ?? none();
                expect(sumTypes([...r.tasks.map((t) => t.usage.tokens), noTask])).toEqual(r.eligible.tokens);
                for (const t of r.tasks) {
                    const parts = [...t.runs.map((x) => x.usage.tokens), ...(t.taskOwned ? [t.taskOwned.tokens] : [])];
                    expect(sumTypes(parts)).toEqual(t.usage.tokens);
                }
                for (const type of TOKEN_TYPE_LIST)
                    expect(r.eligible.coverage[type].measured).toBeLessThanOrEqual(
                        r.eligible.coverage[type].contributors
                    );
            }
            const m = at(100);
            const left = reduceUsage(input, { ...ALL, range: { from: at(0), to: m } }).eligible.tokens;
            const right = reduceUsage(input, { ...ALL, range: { from: m, to: at(400) } }).eligible.tokens;
            expect(addTokens(left, right)).toEqual(
                reduceUsage(input, { ...ALL, range: { from: at(0), to: at(400) } }).eligible.tokens
            );
        });

        it(`gives every contribution exactly one destination, summed independently of the reducer (seed ${seed})`, () => {
            const input = randomWorld(seed);
            const keys = input.contributions
                .filter((c) => c.selection.sessionId !== null)
                .map((c) => ({ agent: c.selection.agent, sessionId: c.selection.sessionId as string }));
            const owners = resolveOwnership(input, keys);
            const hidden = { timed: none(), unlocated: none(), observations: 0 };
            const unresolved = { timed: none(), unlocated: none(), observations: 0 };
            const total = { timed: none(), unlocated: none(), observations: 0 };
            for (const c of input.contributions) {
                const owner =
                    c.selection.sessionId === null
                        ? null
                        : owners.get(sessionKeyId(c.selection.agent, c.selection.sessionId));
                const into = (b: typeof total): void => {
                    if (c.kind === 'timed') b.timed = addTokens(b.timed, c.tokens);
                    else if (c.kind === 'unlocated') b.unlocated = addTokens(b.unlocated, c.tokens);
                    else b.observations += 1;
                };
                into(total);
                if (!owner || owner.status === 'excluded') into(hidden);
                else if (owner.status === 'unresolved') into(unresolved);
            }
            const r = reduceUsage(input, ALL);
            const d = r.diagnostics.unresolvedOwnership;
            expect(unresolved).toEqual({
                timed: d.tokens,
                unlocated: d.unlocated,
                observations: d.unresolvedTemporality.observations,
            });
            expect({
                timed: addTokens(addTokens(r.eligible.tokens, d.tokens), hidden.timed),
                unlocated: addTokens(addTokens(r.eligible.unlocated, d.unlocated), hidden.unlocated),
                observations:
                    r.eligible.unresolvedTemporality.observations +
                    d.unresolvedTemporality.observations +
                    hidden.observations,
            }).toEqual(total);
        });

        it(`splits an excluded repo from eligible without losing an amount (seed ${seed})`, () => {
            const input = randomWorld(seed);
            const withRepo = reduceUsage(input, { ...ALL, repos: ['repo-1'] });
            const without = reduceUsage(input, ALL);
            const x = withRepo.diagnostics.excludedRepo;
            expect(addTokens(withRepo.eligible.tokens, x.tokens)).toEqual(without.eligible.tokens);
            expect(addTokens(withRepo.eligible.unlocated, x.unlocated)).toEqual(without.eligible.unlocated);
            expect(withRepo.eligible.unresolvedTemporality.observations + x.unresolvedTemporality.observations).toBe(
                without.eligible.unresolvedTemporality.observations
            );
            expect(withRepo.diagnostics.unresolvedOwnership).toEqual(without.diagnostics.unresolvedOwnership);
        });
    }
});
