import { describe, expect, it } from 'vitest';
import { taskUsageStats } from '../src/task-usage.js';
import { telemetryStats } from '../src/telemetry.js';
import {
    FIXTURE_NOW,
    FIXTURE_REPO,
    fixturePointSum,
    fixtureReport,
    sampleFixture,
    sampleTelemetry,
} from './fixtures/load.js';

/**
 * Recomputes the headline telemetry figures from the raw fixture without importing anything
 * from telemetry.ts, so a mistake on either side shows up as a mismatch rather than as two
 * agreeing wrong numbers.
 *
 * The aggregation is restated by hand below, deliberately. Importing the helpers would make a
 * wrong number invisible, which is the whole point of this file.
 */

const telemetry = sampleTelemetry();
const stats = telemetryStats(telemetry, {
    repos: [FIXTURE_REPO],
    now: FIXTURE_NOW,
    usage: fixtureReport({ repos: [FIXTURE_REPO] }),
});

const mine = telemetry.sessions.filter((s) => s.repo === FIXTURE_REPO);
const idsOf = (sessions: typeof mine) => sessions.map((s) => s.sessionId);

describe('totals, recomputed by hand', () => {
    it('matches on each token type, summed from the raw points of the in-scope sessions', () => {
        const tokens = stats.usage.totals.tokens;
        expect(tokens.input).toBe(fixturePointSum(idsOf(mine), 'input'));
        expect(tokens.output).toBe(fixturePointSum(idsOf(mine), 'output'));
        expect(tokens.cacheRead).toBe(fixturePointSum(idsOf(mine), 'cacheRead'));
        expect(tokens.cacheCreation).toBe(fixturePointSum(idsOf(mine), 'cacheCreation'));
    });

    it('matches on session count, lines, and active hours', () => {
        // Restated by hand rather than imported from config.ts — see the file-level comment.
        const SECONDS_PER_HOUR = 3600;
        const ASSERTION_PRECISION_DIGITS = 9;
        expect(stats.totals.sessions).toBe(mine.length);
        expect(stats.totals.linesAdded).toBe(mine.reduce((s, x) => s + (x.linesAdded ?? 0), 0));
        expect(stats.totals.linesRemoved).toBe(mine.reduce((s, x) => s + (x.linesRemoved ?? 0), 0));
        const seconds = mine.reduce((s, x) => s + (x.activeSeconds ?? 0), 0);
        expect(stats.totals.activeHours).toBeCloseTo(seconds / SECONDS_PER_HOUR, ASSERTION_PRECISION_DIGITS);
    });

    it('matches on edit acceptance, recomputed by hand', () => {
        const accepted = mine.reduce((s, x) => s + (x.editsAccepted ?? 0), 0);
        const rejected = mine.reduce((s, x) => s + (x.editsRejected ?? 0), 0);
        expect(stats.totals.editAcceptance).toEqual({
            accepted,
            rejected,
            decisions: accepted + rejected,
            ratio: accepted / (accepted + rejected),
        });
    });
});

describe('caller scope, recomputed by hand', () => {
    // Same fixture, scoped to alice: the hand restatement below filters the raw sessions the
    // same way the scope option claims to, so a wrong filter shows as a mismatch.
    const ALICE_ID = 'u-alice';
    const mine = telemetryStats(telemetry, {
        repos: [FIXTURE_REPO],
        now: FIXTURE_NOW,
        user: { id: ALICE_ID },
        usage: fixtureReport({ repos: [FIXTURE_REPO], userId: ALICE_ID }),
    });
    const aliceSessions = mine0();

    function mine0() {
        return telemetry.sessions.filter((s) => s.repo === FIXTURE_REPO && s.user?.id === ALICE_ID);
    }

    it("totals exactly the caller's attributed sessions", () => {
        // Landmark pinned against the fixture: a silent regeneration should fail here too.
        const ALICE_SESSION_COUNT = 9;
        expect(mine.totals.sessions).toBe(aliceSessions.length);
        expect(mine.usage.totals.tokens.input).toBe(fixturePointSum(idsOf(aliceSessions), 'input'));
        expect(mine.usage.totals.tokens.output).toBe(fixturePointSum(idsOf(aliceSessions), 'output'));
        expect(mine.totals.sessions).toBe(ALICE_SESSION_COUNT);
    });

    it('still names the unattributed sessions the scope dropped', () => {
        const UNATTRIBUTED_SESSION_COUNT = 4;
        const unattributed = telemetry.sessions.filter((s) => s.repo === FIXTURE_REPO && s.user === null).length;
        expect(mine.unattributedSessions).toBe(unattributed);
        expect(unattributed).toBe(UNATTRIBUTED_SESSION_COUNT);
    });

    it('leaves coverage untouched', () => {
        expect(mine.coverage).toEqual(telemetry.coverage);
    });
});

describe('landmarks pinned against the fixture', () => {
    it('pins the fixture shape, so a silent regeneration is caught', () => {
        // 21 declared sessions; one is an unresolved conflict and has no rollup, one is another repo.
        const FIXTURE_SESSION_COUNT = 20;
        const FIXTURE_REPO_SESSION_COUNT = 19;
        expect(telemetry.sessions).toHaveLength(FIXTURE_SESSION_COUNT);
        expect(mine).toHaveLength(FIXTURE_REPO_SESSION_COUNT);
        expect(telemetry.coverage.from).toBe('2026-04-15T12:00:00Z');
        expect(telemetry.coverage.to).toBe('2026-08-21T08:20:00Z');
    });

    it('emits a contiguous week series over the whole window', () => {
        // No range passed: the coverage span (about four months) picks weekly buckets.
        const DAYS_PER_WEEK = 7;
        const DAY_MS = 86_400_000;
        const MIN_EXPECTED_WEEKS = 15;
        expect(stats.series.granularity).toBe('week');
        const gaps = stats.series.points
            .map((w) => new Date(w.start).getTime())
            .map((t, i, all) => (i === 0 ? DAYS_PER_WEEK : (t - (all[i - 1] as number)) / DAY_MS));
        expect(gaps.every((g) => g === DAYS_PER_WEEK)).toBe(true);
        expect(stats.series.points.length).toBeGreaterThan(MIN_EXPECTED_WEEKS);
    });
});

describe('per-type token distributions, recomputed by hand', () => {
    const { facts } = sampleFixture();
    const TYPES = ['input', 'output', 'cacheRead', 'cacheCreation'] as const;

    /** One value per canonical task: the sum of its sessions' points, null when no point measured the type. */
    function perTask(type: (typeof TYPES)[number]): number[] {
        const rowsOf = (sessionId: string) => facts.board.filter((row) => row.sessionId === sessionId);
        const sums = new Map<string, number>();
        for (const sessionId of new Set(facts.board.map((row) => row.sessionId))) {
            const rows = rowsOf(sessionId);
            // A session two tasks claim is an unresolved conflict: it belongs to neither.
            if (rows.length !== 1 || rows[0]?.repo !== FIXTURE_REPO) continue;
            const task = rows[0].requestingRootJobId ?? rows[0].rootJobId;
            for (const c of facts.contributions) {
                const value = c.selection.sessionId === sessionId ? c.tokens[type] : null;
                if (value !== null) sums.set(task, (sums.get(task) ?? 0) + value);
            }
        }
        return [...sums.values()].sort((a, b) => a - b);
    }

    const dist = taskUsageStats(fixtureReport({ repos: [FIXTURE_REPO] }).tasks, []).tokens.all;

    it.each(TYPES)('matches on %s: average and nearest-rank p50/p95 over per-task sums', (type) => {
        const values = perTask(type);
        expect(values.length, 'p50 and p95 need more than one task to differ').toBeGreaterThan(1);
        const rank = (p: number) => values[Math.ceil(p * values.length) - 1];
        expect(dist[type].tasks).toBe(values.length);
        expect(dist[type].avg).toBeCloseTo(values.reduce((a, b) => a + b, 0) / values.length, 6);
        expect(dist[type].p50).toBe(rank(0.5));
        expect(dist[type].p95).toBe(rank(0.95));
    });
});
