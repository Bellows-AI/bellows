import { describe, expect, it } from 'vitest';
import { bucketizeActivity, pickBucketMs, totalTokens } from '../src/telemetry/run-activity.js';
import type { ActivityPoint, TokenTypes } from '../src/telemetry/run-activity.js';

/**
 * The run-activity bucket reduction (issue #339): metric_point rows for ONE session reduced into
 * per-bucket token and edit figures over the run's wall clock. A flat line means stuck, a steady
 * bar means working — but only if the reduction is honest, which is where the double-count trap
 * lives: a delta counter sums, a cumulative counter must be differenced, and `sum(value)` over a
 * cumulative series produces a plausible, wildly wrong number (docs/metrics.md, 002's header).
 */

const FROM = '2026-09-22T10:00:00.000Z';
const FIFTEEN_MIN = 900_000;

const delta = (over: Partial<ActivityPoint>): ActivityPoint => ({
    field: 'tokens_input',
    temporality: 'delta',
    startTime: null,
    attrs: {},
    metric: 'claude_code.token.usage',
    agent: 'claude-code',
    value: 1,
    time: FROM,
    ...over,
});

const tokens = (over: Partial<TokenTypes> = {}): TokenTypes => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    ...over,
});

describe('pickBucketMs', () => {
    it('picks the smallest bucket width that keeps the chart at 16 bars or fewer', () => {
        // A 2h run → 15-minute buckets, 8 of them — the issue's own example.
        expect(pickBucketMs(7_200_000)).toBe(FIFTEEN_MIN);
        expect(pickBucketMs(30 * 60_000)).toBe(300_000);
        expect(pickBucketMs(5 * 60_000)).toBe(60_000);
    });

    it('caps at the hour width for runs too long for the ladder', () => {
        expect(pickBucketMs(20 * 3_600_000)).toBe(3_600_000);
    });
});

describe('bucketizeActivity', () => {
    it('sums delta points into the bucket that contains them', () => {
        const points: ActivityPoint[] = [
            delta({ field: 'tokens_input', value: 2_000_000, time: '2026-09-22T10:05:00.000Z' }),
            delta({ field: 'tokens_output', value: 500_000, time: '2026-09-22T10:07:00.000Z' }),
            delta({ field: 'edits_accept', value: 3, time: '2026-09-22T10:20:00.000Z' }),
        ];
        const buckets = bucketizeActivity(points, {
            from: FROM,
            to: '2026-09-22T10:45:00.000Z',
            bucketMs: FIFTEEN_MIN,
        });
        expect(buckets).toHaveLength(3);
        expect(buckets[0]).toEqual({ start: FROM, tokens: tokens({ input: 2_000_000, output: 500_000 }), edits: 0 });
        expect(buckets[1]).toEqual({ start: '2026-09-22T10:15:00.000Z', tokens: tokens(), edits: 3 });
        expect(buckets[2]).toEqual({ start: '2026-09-22T10:30:00.000Z', tokens: tokens(), edits: 0 });
    });

    it('keeps the four token types apart', () => {
        const points: ActivityPoint[] = [
            delta({ field: 'tokens_input', value: 1 }),
            delta({ field: 'tokens_output', value: 2 }),
            delta({ field: 'tokens_cacheRead', value: 3 }),
            delta({ field: 'tokens_cacheCreation', value: 4 }),
        ];
        const [bucket] = bucketizeActivity(points, {
            from: FROM,
            to: '2026-09-22T10:10:00.000Z',
            bucketMs: FIFTEEN_MIN,
        });
        expect(bucket!.tokens).toEqual({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4 });
        expect(totalTokens([bucket!, bucket!])).toEqual({ input: 2, output: 4, cacheRead: 6, cacheCreation: 8 });
    });

    it('differences a follow-up run from the total its shared session had already reached', () => {
        // The follow-up shares the session's counters: 500 were reached during the first run, and
        // only the 120 more it reports are this run's — counting from 0 would double-count 500.
        const SERIES = { temporality: 'cumulative', startTime: '2026-09-22T09:00:00.000Z', field: 'tokens_input' };
        const points: ActivityPoint[] = [
            delta({ ...SERIES, value: 300, time: '2026-09-22T09:30:00.000Z' }),
            delta({ ...SERIES, value: 500, time: '2026-09-22T09:59:00.000Z' }),
            delta({ ...SERIES, value: 560, time: '2026-09-22T10:05:00.000Z' }),
            delta({ ...SERIES, value: 620, time: '2026-09-22T10:20:00.000Z' }),
        ];
        const buckets = bucketizeActivity(points, {
            from: FROM,
            to: '2026-09-22T10:30:00.000Z',
            bucketMs: FIFTEEN_MIN,
        });
        expect(buckets.map((b) => b.tokens.input)).toEqual([60, 60]);
        expect(totalTokens(buckets).input).toBe(120);
    });

    it('differences cumulative series instead of summing them', () => {
        // A cumulative counter reports the running total since start_time: 100 then 150 then 200
        // means 100 in the first bucket and 50 in each of the next two — a naive sum would read
        // 450 tokens in one bucket and invent the rest.
        const points: ActivityPoint[] = [
            delta({
                temporality: 'cumulative',
                startTime: FROM,
                field: 'tokens_input',
                value: 100,
                time: '2026-09-22T10:05:00.000Z',
            }),
            delta({
                temporality: 'cumulative',
                startTime: FROM,
                field: 'tokens_input',
                value: 150,
                time: '2026-09-22T10:20:00.000Z',
            }),
            delta({
                temporality: 'cumulative',
                startTime: FROM,
                field: 'tokens_input',
                value: 200,
                time: '2026-09-22T10:40:00.000Z',
            }),
        ];
        const buckets = bucketizeActivity(points, {
            from: FROM,
            to: '2026-09-22T10:45:00.000Z',
            bucketMs: FIFTEEN_MIN,
        });
        expect(buckets.map((b) => b.tokens.input)).toEqual([100, 50, 50]);
    });

    it('differences each cumulative series separately, so a counter reset starts over', () => {
        // Two start_times are two series: the second process's totals are NOT an increment on
        // the first's — differencing across them would go negative and lie about the shape.
        const points: ActivityPoint[] = [
            delta({
                temporality: 'cumulative',
                startTime: FROM,
                field: 'tokens_output',
                value: 100,
                time: '2026-09-22T10:05:00.000Z',
            }),
            delta({
                temporality: 'cumulative',
                startTime: '2026-09-22T10:30:00.000Z',
                field: 'tokens_output',
                value: 40,
                time: '2026-09-22T10:35:00.000Z',
            }),
        ];
        const buckets = bucketizeActivity(points, {
            from: FROM,
            to: '2026-09-22T10:45:00.000Z',
            bucketMs: FIFTEEN_MIN,
        });
        expect(buckets.map((b) => b.tokens.output)).toEqual([100, 0, 40]);
    });

    describe('cumulative reduction', () => {
        const window = { from: FROM, to: '2026-09-22T10:45:00.000Z', bucketMs: FIFTEEN_MIN };
        const cum = (over: Partial<ActivityPoint>): ActivityPoint =>
            delta({ temporality: 'cumulative', startTime: FROM, field: 'tokens_input', ...over });
        const total = (points: ActivityPoint[]): number => totalTokens(bucketizeActivity(points, window)).input;

        it('skips a negative or non-finite value instead of failing the whole reduction', () => {
            const points = [
                cum({ value: -5, time: '2026-09-22T10:05:00.000Z' }),
                cum({ value: Number.NaN, time: '2026-09-22T10:10:00.000Z' }),
                cum({ value: 30, time: '2026-09-22T10:20:00.000Z' }),
            ];
            expect(total(points)).toBe(30);
        });

        it('leaves a first cumulative reading without a start time unlocated, but counts a later rise', () => {
            const unlocated = [cum({ value: 100, startTime: null, time: '2026-09-22T10:05:00.000Z' })];
            expect(total(unlocated)).toBe(0);
            const rising = [...unlocated, cum({ value: 130, startTime: null, time: '2026-09-22T10:20:00.000Z' })];
            expect(total(rising)).toBe(30);
        });

        it('counts a rebound from the running maximum: 100, 80, 120 is 120, not 140', () => {
            const points = [
                cum({ value: 100, time: '2026-09-22T10:05:00.000Z' }),
                cum({ value: 80, time: '2026-09-22T10:20:00.000Z' }),
                cum({ value: 120, time: '2026-09-22T10:40:00.000Z' }),
            ];
            expect(bucketizeActivity(points, window).map((b) => b.tokens.input)).toEqual([100, 0, 20]);
            expect(total(points)).toBe(120);
        });

        it('gives the same answer whatever order the points arrive in', () => {
            const points = [
                cum({ value: 100, time: '2026-09-22T10:05:00.000Z' }),
                cum({ value: 80, time: '2026-09-22T10:20:00.000Z' }),
                cum({ value: 120, time: '2026-09-22T10:40:00.000Z' }),
            ];
            expect(bucketizeActivity([...points].reverse(), window)).toEqual(bucketizeActivity(points, window));
        });

        it('treats reordered attributes as one series', () => {
            const points = [
                cum({ value: 100, time: '2026-09-22T10:05:00.000Z', attrs: { model: 'm', query_source: 'q' } }),
                cum({ value: 150, time: '2026-09-22T10:20:00.000Z', attrs: { query_source: 'q', model: 'm' } }),
            ];
            expect(total(points)).toBe(150);
        });

        it('starts a new series on a distinct start time, so a restart adds its own total', () => {
            const points = [
                cum({ value: 100, time: '2026-09-22T10:05:00.000Z' }),
                cum({ value: 40, startTime: '2026-09-22T10:30:00.000Z', time: '2026-09-22T10:35:00.000Z' }),
            ];
            expect(total(points)).toBe(140);
        });

        it('never sums an unspecified temporality as a delta', () => {
            const points = [
                delta({ temporality: 'unspecified', value: 500, time: '2026-09-22T10:05:00.000Z' }),
                delta({ value: 7, time: '2026-09-22T10:06:00.000Z' }),
            ];
            expect(total(points)).toBe(7);
        });

        it('folds a counter written before the series digest existed into its digest series, counting it once', () => {
            const points = [
                cum({ value: 100, time: '2026-09-22T10:05:00.000Z', attrs: { model: 'm' } }),
                cum({ value: 150, time: '2026-09-22T10:20:00.000Z', attrs: { model: 'm', series: 'abc' } }),
            ];
            expect(total(points)).toBe(150);
        });

        it('keeps equal session counters of two agents apart', () => {
            const points = [
                cum({ value: 100, time: '2026-09-22T10:05:00.000Z' }),
                cum({ value: 60, agent: 'opencode', time: '2026-09-22T10:06:00.000Z' }),
                cum({ value: 130, time: '2026-09-22T10:20:00.000Z' }),
            ];
            expect(total(points)).toBe(190);
        });

        it('does not count the baseline reached before the window, across adjacent windows', () => {
            const points = [
                cum({ value: 100, time: '2026-09-22T09:50:00.000Z' }),
                cum({ value: 160, time: '2026-09-22T10:20:00.000Z' }),
                cum({ value: 200, time: '2026-09-22T10:50:00.000Z' }),
            ];
            const next = { from: '2026-09-22T10:45:00.000Z', to: '2026-09-22T11:30:00.000Z', bucketMs: FIFTEEN_MIN };
            expect(total(points)).toBe(60);
            expect(totalTokens(bucketizeActivity(points, next)).input).toBe(40);
        });
    });

    it('drops points outside the run window', () => {
        const points: ActivityPoint[] = [
            delta({ value: 5, time: '2026-09-22T09:55:00.000Z' }),
            delta({ value: 7, time: '2026-09-22T10:50:00.000Z' }),
            delta({ value: 3, time: '2026-09-22T10:05:00.000Z' }),
        ];
        const buckets = bucketizeActivity(points, {
            from: FROM,
            to: '2026-09-22T10:30:00.000Z',
            bucketMs: FIFTEEN_MIN,
        });
        expect(buckets.map((b) => b.tokens.input)).toEqual([3, 0]);
    });

    it('seeds every bucket in the window, so a quiet stretch renders as a quiet stretch', () => {
        const buckets = bucketizeActivity([], { from: FROM, to: '2026-09-22T11:00:00.000Z', bucketMs: FIFTEEN_MIN });
        expect(buckets).toHaveLength(4);
        expect(buckets.every((b) => totalTokens([b]).input === 0 && b.edits === 0)).toBe(true);
    });
});
