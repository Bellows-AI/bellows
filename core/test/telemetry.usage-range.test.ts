import { describe, expect, it } from 'vitest';
import type { DateRange } from '../src/range.js';
import { filterTelemetryInput } from '../src/range.js';
import { seriesGranularity, telemetryStats, usageRangeOf } from '../src/telemetry.js';
import type { TokenContribution } from '../src/token-contributions.js';
import type { UsageInput } from '../src/usage.js';
import { reduceUsage } from '../src/usage-reduce.js';
import { rollupsFromFacts } from '../src/usage-rollups.js';
import { branch, ev, world } from './usage-fixtures.js';

const NOW = new Date('2026-08-21T12:00:00.000Z');
const REPO = 'repo-1';

/** An exact output delta of one session at an absolute instant. */
function point(session: string, observedAt: string, value: number): TokenContribution {
    return {
        selection: { agent: 'claude-code', sessionId: session },
        source: 'otel',
        series: {
            agent: 'claude-code',
            sessionId: session,
            metric: 'token.usage',
            field: 'output',
            temporality: 'delta',
            startTime: null,
            attrsKey: '[]',
        },
        model: 'm-1',
        querySource: 'main',
        tokens: { input: null, output: value, cacheRead: null, cacheCreation: null },
        observedAt,
        support: { from: observedAt, to: observedAt },
        kind: 'timed',
        precision: 'exact',
        reasons: [],
    };
}

/** One session on the board, alive from `from` to `to`, with the given points. */
function sessionWorld(id: string, from: string, to: string, points: TokenContribution[]): UsageInput {
    return world({
        board: [ev({ sessionId: id, jobId: `j-${id}`, rootJobId: `j-${id}`, startedAt: from, endedAt: null })],
        branch: [branch({ sessionId: id })],
        spans: [{ agent: 'claude-code', sessionId: id, firstSeen: from, lastSeen: to }],
        contributions: points,
    });
}

/** What the server does at read time for one request: re-reduce the cached facts under the range. */
function payload(facts: UsageInput, range: DateRange) {
    const input = rollupsFromFacts({ ...facts, users: [], fields: [] });
    const usage = reduceUsage(facts, {
        range: usageRangeOf(range),
        repos: [REPO],
        now: NOW,
        granularity: seriesGranularity(range, input, NOW),
    });
    return telemetryStats(filterTelemetryInput(input, range), { repos: [REPO], now: NOW, range, usage });
}

const custom = (from: string | null, to: string | null): DateRange => ({ preset: 'custom', from, to });
const week = custom('2026-08-10T00:00:00.000Z', '2026-08-17T00:00:00.000Z');

// One session alive for six months, with points inside and far outside the one-week range.
const longSession = sessionWorld('s-long', '2026-02-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', [
    point('s-long', '2026-03-01T00:00:00.000Z', 1000),
    point('s-long', '2026-08-12T12:00:00.000Z', 7),
    point('s-long', '2026-08-19T12:00:00.000Z', 2000),
]);

describe('tokens partition by point time', () => {
    it('does not let a six-month session inflate a one-week range', () => {
        const stats = payload(longSession, week);
        // The session overlaps the week, so it still counts as a session; only the point inside the week is tokens.
        expect(stats.totals.sessions).toBe(1);
        expect(stats.usage.totals.tokens.output).toBe(7);
    });

    it('includes a point at `from` and excludes a point at `to`', () => {
        const edge = sessionWorld('s-e', '2026-08-01T00:00:00.000Z', '2026-08-20T00:00:00.000Z', [
            point('s-e', '2026-08-10T00:00:00.000Z', 3),
            point('s-e', '2026-08-17T00:00:00.000Z', 5),
        ]);
        const next = custom('2026-08-17T00:00:00.000Z', '2026-08-24T00:00:00.000Z');
        expect(payload(edge, week).usage.totals.tokens.output).toBe(3);
        // Adjacent ranges partition exactly once.
        expect(payload(edge, next).usage.totals.tokens.output).toBe(5);
    });

    it('reads an open edge as the epoch or the far future, and all time as no window', () => {
        expect(usageRangeOf({ preset: 'all', from: null, to: null })).toBeNull();
        expect(usageRangeOf(custom('2026-08-10T00:00:00.000Z', null))).toEqual({
            from: '2026-08-10T00:00:00.000Z',
            to: '9999-12-31T00:00:00.000Z',
        });
        expect(usageRangeOf(custom(null, '2026-08-10T00:00:00.000Z'))?.from).toBe('1970-01-01T00:00:00.000Z');
        expect(payload(longSession, custom('2026-08-10T00:00:00.000Z', null)).usage.totals.tokens.output).toBe(2007);
    });

    it('buckets the usage series by the instant of each point', () => {
        const stats = payload(longSession, custom('2026-08-10T00:00:00.000Z', '2026-08-21T00:00:00.000Z'));
        const days = stats.usage.series.points.filter((p) => p.usage.tokens.output !== null);
        expect(days.map((p) => [p.start, p.usage.tokens.output])).toEqual([
            ['2026-08-12', 7],
            ['2026-08-19', 2000],
        ]);
    });
});
