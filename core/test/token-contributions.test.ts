import { describe, expect, it } from 'vitest';
import {
    bucketTimedContributions,
    normalizeModel,
    normalizeQuerySource,
    partitionByRange,
    reduceTokenObservations,
} from '../src/token-contributions.js';
import type { TokenContribution, TokenObservation, TokenType } from '../src/token-contributions.js';

const T0 = '2026-03-02T10:00:00.000Z';
const T1 = '2026-03-02T10:01:00.000Z';
const T2 = '2026-03-02T10:02:00.000Z';
const T3 = '2026-03-02T10:03:00.000Z';

function obs(over: Partial<TokenObservation> & Pick<TokenObservation, 'time' | 'value'>): TokenObservation {
    return {
        agent: 'claude-code',
        sessionId: 's1',
        source: 'otel',
        metric: 'token.usage',
        field: 'output',
        temporality: 'cumulative',
        startTime: T0,
        attrs: { model: 'm-1', query_source: 'main' },
        ...over,
    };
}

/** Sum of one type over the contributions; null when none carries it. */
function total(cs: readonly TokenContribution[], type: TokenType): number | null {
    let sum: number | null = null;
    for (const c of cs) {
        const v = c.tokens[type];
        if (v !== null) sum = (sum ?? 0) + v;
    }
    return sum;
}

const timed = (cs: readonly TokenContribution[]) => cs.filter((c) => c.kind === 'timed');

describe('series identity', () => {
    it('is insensitive to attribute order, so one counter stays one series', () => {
        const a = obs({ time: T1, value: 10, attrs: { model: 'm-1', query_source: 'main' } });
        const b = obs({ time: T2, value: 25, attrs: { query_source: 'main', model: 'm-1' } });
        const cs = reduceTokenObservations([a, b]);
        expect(total(cs, 'output')).toBe(25);
        expect(new Set(cs.map((c) => c.series.attrsKey)).size).toBe(1);
        expect(cs.map((c) => c.tokens.output)).toEqual([10, 15]);
    });

    it('keeps equal session ids of different agents apart', () => {
        const cs = reduceTokenObservations([
            obs({ time: T1, value: 100, agent: 'claude-code' }),
            obs({ time: T1, value: 40, agent: 'opencode' }),
            obs({ time: T2, value: 130, agent: 'claude-code' }),
        ]);
        expect(
            total(
                cs.filter((c) => c.selection.agent === 'claude-code'),
                'output'
            )
        ).toBe(130);
        expect(
            total(
                cs.filter((c) => c.selection.agent === 'opencode'),
                'output'
            )
        ).toBe(40);
    });

    it('treats model and query_source as part of the series, not as noise on one counter', () => {
        const cs = reduceTokenObservations([
            obs({ time: T1, value: 50, attrs: { model: 'm-1' } }),
            obs({ time: T1, value: 70, attrs: { model: 'm-2' } }),
        ]);
        expect(total(cs, 'output')).toBe(120);
    });
});

describe('delta', () => {
    it('contributes each point at its own time, exactly', () => {
        const cs = reduceTokenObservations([
            obs({ time: T2, value: 7, temporality: 'delta', startTime: null }),
            obs({ time: T1, value: 5, temporality: 'delta', startTime: null }),
        ]);
        expect(cs.map((c) => [c.observedAt, c.tokens.output, c.precision, c.kind])).toEqual([
            [T1, 5, 'exact', 'timed'],
            [T2, 7, 'exact', 'timed'],
        ]);
        expect(cs[0]?.support).toEqual({ from: T1, to: T1 });
    });

    it('keeps the point time when the row arrives late: input order changes nothing', () => {
        const points = [
            obs({ time: T1, value: 5, temporality: 'delta', startTime: null }),
            obs({ time: T2, value: 7, temporality: 'delta', startTime: null }),
            obs({ time: T3, value: 9, temporality: 'delta', startTime: null }),
        ];
        const inOrder = reduceTokenObservations(points);
        const late = reduceTokenObservations([
            points[2] as TokenObservation,
            points[0] as TokenObservation,
            points[1] as TokenObservation,
        ]);
        expect(late).toEqual(inOrder);
        expect(late.map((c) => c.observedAt)).toEqual([T1, T2, T3]);
    });

    it('keeps measured zeros as 0 and unmeasured types as null', () => {
        const cs = reduceTokenObservations([
            obs({ time: T1, value: 0, temporality: 'delta', startTime: null, field: 'cacheRead' }),
        ]);
        expect(cs).toHaveLength(1);
        expect(cs[0]?.tokens).toEqual({ input: null, output: null, cacheRead: 0, cacheCreation: null });
        expect(total(cs, 'cacheRead')).toBe(0);
        expect(total(cs, 'output')).toBeNull();
    });
});

describe('cumulative', () => {
    it('adds high-water increases at the reading that raised them, as estimates with a support interval', () => {
        const cs = reduceTokenObservations([
            obs({ time: T1, value: 100 }),
            obs({ time: T2, value: 160 }),
            obs({ time: T3, value: 160 }),
        ]);
        expect(cs.map((c) => [c.observedAt, c.tokens.output, c.precision])).toEqual([
            [T1, 100, 'estimated'],
            [T2, 60, 'estimated'],
        ]);
        expect(cs[0]?.support).toEqual({ from: T0, to: T1 });
        expect(cs[1]?.support).toEqual({ from: T1, to: T2 });
    });

    it('flags a decline as an anomaly and keeps the high-water: 100, 80, 120 totals 120', () => {
        const cs = reduceTokenObservations([
            obs({ time: T1, value: 100 }),
            obs({ time: T2, value: 80 }),
            obs({ time: T3, value: 120 }),
        ]);
        expect(total(cs, 'output')).toBe(120);
        expect(cs.map((c) => c.tokens.output)).toEqual([100, 0, 20]);
        const anomalies = cs.filter((c) => c.reasons.includes('cumulative-anomaly-decrease'));
        expect(anomalies).toHaveLength(1);
        expect(anomalies[0]?.observedAt).toBe(T2);
        expect(cs[2]?.support).toEqual({ from: T1, to: T3 });
    });

    it('treats a distinct start time as a new series, not a restart inferred from a lower value', () => {
        const T_RESTART = '2026-03-02T10:02:30.000Z';
        const cs = reduceTokenObservations([
            obs({ time: T1, value: 100 }),
            obs({ time: T3, value: 30, startTime: T_RESTART }),
        ]);
        expect(total(cs, 'output')).toBe(130);
        expect(cs.some((c) => c.reasons.includes('cumulative-anomaly-decrease'))).toBe(false);
        expect(new Set(cs.map((c) => c.series.startTime))).toEqual(new Set([T0, T_RESTART]));
    });

    it('collides nothing when two restarts report the same value at the same time', () => {
        const cs = reduceTokenObservations([
            obs({ time: T1, value: 40, startTime: T0 }),
            obs({ time: T1, value: 40, startTime: T1 }),
        ]);
        expect(total(cs, 'output')).toBe(80);
    });

    it('exposes a first reading with no start time as unlocated, then differences later readings from it', () => {
        const cs = reduceTokenObservations([
            obs({ time: T1, value: 90, startTime: null }),
            obs({ time: T2, value: 100, startTime: null }),
        ]);
        expect(cs.map((c) => [c.kind, c.observedAt, c.tokens.output, c.precision])).toEqual([
            ['unlocated', null, 90, 'unlocated'],
            ['timed', T2, 10, 'estimated'],
        ]);
        expect(cs[0]?.support).toBeNull();
        expect(cs[0]?.reasons).toContain('cumulative-first-unlocated');
        expect(cs[1]?.support).toEqual({ from: T1, to: T2 });
        expect(total(timed(cs), 'output')).toBe(10);
    });

    it('keeps a first reading of zero as a measured zero', () => {
        const cs = reduceTokenObservations([obs({ time: T1, value: 0 })]);
        expect(cs.map((c) => c.tokens.output)).toEqual([0]);
    });
});

describe('temporality', () => {
    it('never treats unspecified as delta: it is unresolved, carries its raw value and adds to nothing', () => {
        const cs = reduceTokenObservations([obs({ time: T1, value: 55, temporality: 'unspecified', startTime: null })]);
        expect(cs).toHaveLength(1);
        expect(cs[0]).toMatchObject({ kind: 'unresolved', precision: 'unlocated', observedAt: T1, support: null });
        expect(cs[0]?.tokens.output).toBe(55);
        expect(cs[0]?.reasons).toEqual(['unspecified-temporality']);
        expect(partitionByRange(cs, T0, T3).timed).toEqual([]);
    });

    it('retains both sides of a mixed delta and cumulative session, each flagged', () => {
        const cs = reduceTokenObservations([
            obs({ time: T1, value: 10, temporality: 'delta', startTime: null }),
            obs({ time: T2, value: 100 }),
        ]);
        expect(cs).toHaveLength(2);
        for (const c of cs) expect(c.reasons).toContain('mixed-temporality');
        expect(total(cs, 'output')).toBe(110);
    });

    it('does not flag mixing across different token types', () => {
        const cs = reduceTokenObservations([
            obs({ time: T1, value: 10, temporality: 'delta', startTime: null, field: 'input' }),
            obs({ time: T2, value: 100, field: 'output' }),
        ]);
        for (const c of cs) expect(c.reasons).not.toContain('mixed-temporality');
    });
});

describe('sessions and sources', () => {
    it('handles null sessions explicitly: grouped per agent, flagged, never merged with a real session', () => {
        const cs = reduceTokenObservations([
            obs({ time: T1, value: 10, sessionId: null }),
            obs({ time: T2, value: 25, sessionId: null }),
            obs({ time: T1, value: 99, sessionId: 's1' }),
        ]);
        const orphans = cs.filter((c) => c.selection.sessionId === null);
        expect(total(orphans, 'output')).toBe(25);
        for (const c of orphans) expect(c.reasons).toContain('null-session');
        expect(cs.filter((c) => c.selection.sessionId === 's1').flatMap((c) => c.reasons)).not.toContain(
            'null-session'
        );
    });

    it('prefers OTEL per (agent, session) and keeps the transcript as non-additive diagnostics', () => {
        const cs = reduceTokenObservations([
            obs({ time: T1, value: 100 }),
            obs({ time: T1, value: 300, source: 'transcript', temporality: 'delta', startTime: null }),
            obs({ time: T1, value: 70, source: 'transcript', sessionId: 's2', temporality: 'delta', startTime: null }),
        ]);
        const suppressed = cs.filter((c) => c.kind === 'suppressed');
        expect(suppressed).toHaveLength(1);
        expect(suppressed[0]).toMatchObject({ source: 'transcript', precision: 'unlocated', support: null });
        expect(suppressed[0]?.tokens.output).toBe(300);
        expect(suppressed[0]?.reasons).toEqual(['source-suppressed']);
        expect(total(timed(cs), 'output')).toBe(170);
        expect(partitionByRange(cs, T0, T3).suppressed).toHaveLength(1);
    });
});

describe('ranges and buckets', () => {
    const MIDNIGHT = '2026-03-03T00:00:00.000Z';
    const before = '2026-03-02T23:59:59.999Z';
    const delta = (time: string, value: number) => obs({ time, value, temporality: 'delta', startTime: null });

    it('partitions timed contributions into adjacent [from,to) ranges exactly once', () => {
        const cs = reduceTokenObservations([
            delta(T1, 1),
            delta(before, 2),
            delta(MIDNIGHT, 4),
            delta('2026-03-03T12:00:00.000Z', 8),
        ]);
        const day1 = partitionByRange(cs, '2026-03-02T00:00:00.000Z', MIDNIGHT);
        const day2 = partitionByRange(cs, MIDNIGHT, '2026-03-04T00:00:00.000Z');
        expect(total(day1.timed, 'output')).toBe(3);
        expect(total(day2.timed, 'output')).toBe(12);
        expect(day1.timed.length + day2.timed.length).toBe(cs.length);
    });

    it('splits a day at UTC midnight and a week on Monday', () => {
        const cs = reduceTokenObservations([
            delta(before, 2),
            delta(MIDNIGHT, 4),
            delta('2026-03-08T23:59:59.999Z', 8),
            delta('2026-03-09T00:00:00.000Z', 16),
        ]);
        expect(bucketTimedContributions(cs, 'day').map((b) => [b.start, b.tokens.output])).toEqual([
            ['2026-03-02', 2],
            ['2026-03-03', 4],
            ['2026-03-08', 8],
            ['2026-03-09', 16],
        ]);
        expect(bucketTimedContributions(cs, 'week').map((b) => [b.start, b.tokens.output])).toEqual([
            ['2026-03-02', 14],
            ['2026-03-09', 16],
        ]);
    });

    it('keeps unlocated and unresolved out of every range, whole and identical for each', () => {
        const cs = reduceTokenObservations([
            obs({ time: T1, value: 90, startTime: null }),
            obs({ time: T1, value: 5, temporality: 'unspecified', startTime: null, field: 'input' }),
        ]);
        const a = partitionByRange(cs, T0, T2);
        const b = partitionByRange(cs, T2, T3);
        expect(a.timed).toEqual([]);
        expect(b.timed).toEqual([]);
        expect(a.unlocated).toEqual(b.unlocated);
        expect(a.unlocated).toHaveLength(1);
        expect(a.unresolved).toHaveLength(1);
        expect(bucketTimedContributions([...a.unlocated, ...a.unresolved], 'day')).toEqual([]);
    });

    it('leaves a type with no contribution null in a bucket and keeps a measured zero', () => {
        const cs = reduceTokenObservations([
            obs({ time: T1, value: 0, temporality: 'delta', startTime: null, field: 'cacheRead' }),
            obs({ time: T1, value: 3, temporality: 'delta', startTime: null, field: 'input' }),
        ]);
        expect(bucketTimedContributions(cs, 'day')[0]?.tokens).toEqual({
            input: 3,
            output: null,
            cacheRead: 0,
            cacheCreation: null,
        });
    });
});

describe('determinism', () => {
    it('returns identical output for any permutation of the input', () => {
        const input = [
            obs({ time: T1, value: 100 }),
            obs({ time: T2, value: 80 }),
            obs({ time: T3, value: 120 }),
            obs({ time: T1, value: 4, temporality: 'delta', startTime: null, field: 'input' }),
            obs({ time: T2, value: 9, temporality: 'unspecified', startTime: null }),
            obs({ time: T1, value: 1, source: 'transcript' }),
        ];
        const expected = reduceTokenObservations(input);
        expect(reduceTokenObservations([...input].reverse())).toEqual(expected);
        expect(
            reduceTokenObservations([input[3], input[0], input[5], input[2], input[4], input[1]] as TokenObservation[])
        ).toEqual(expected);
    });

    it('rejects an unparseable timestamp instead of sorting it unpredictably', () => {
        expect(() => reduceTokenObservations([obs({ time: 'not-a-time', value: 1 })])).toThrow(RangeError);
    });
});

describe('model and query source buckets', () => {
    it('strips only one exact terminal [1m]', () => {
        expect(normalizeModel('claude-sonnet-4-5[1m]')).toBe('claude-sonnet-4-5');
        expect(normalizeModel('claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
        expect(normalizeModel('claude[1m][1m]')).toBe('claude[1m]');
        expect(normalizeModel('claude[1M]')).toBe('claude[1M]');
        expect(normalizeModel('claude[1m] ')).toBe('claude[1m] ');
        expect(normalizeModel('claude[1m]-preview')).toBe('claude[1m]-preview');
        expect(normalizeModel('claude[2m]')).toBe('claude[2m]');
    });

    it('preserves case, provider prefixes and raw variants', () => {
        expect(normalizeModel('Anthropic/Claude-Opus[1m]')).toBe('Anthropic/Claude-Opus');
        expect(normalizeModel('bedrock/us.anthropic.claude-x-v1:0')).toBe('bedrock/us.anthropic.claude-x-v1:0');
    });

    it('sends missing and empty values, and a bare suffix, to the unknown bucket', () => {
        for (const raw of [null, undefined, '', '  ', '[1m]']) expect(normalizeModel(raw)).toBe('unknown');
        for (const raw of [null, undefined, '', ' ']) expect(normalizeQuerySource(raw)).toBe('unknown');
        expect(normalizeQuerySource('Some_Odd-Source')).toBe('Some_Odd-Source');
    });

    it('keeps raw values on contributions and reports the missing ones', () => {
        const [c] = reduceTokenObservations([obs({ time: T1, value: 1, attrs: { model: 'm[1m]', query_source: '' } })]);
        expect(c?.model).toBe('m[1m]');
        expect(c?.querySource).toBeNull();
        expect(c?.reasons).toContain('unknown-query-source');
        const [d] = reduceTokenObservations([obs({ time: T1, value: 1, attrs: {} })]);
        expect(d?.model).toBeNull();
        expect(d?.reasons).toEqual(expect.arrayContaining(['unknown-model', 'unknown-query-source']));
    });

    it('reduces on the raw model first: [1m] and plain variants stay separate series until grouped', () => {
        const cs = reduceTokenObservations([
            obs({ time: T1, value: 60, attrs: { model: 'm[1m]' } }),
            obs({ time: T1, value: 40, attrs: { model: 'm' } }),
        ]);
        expect(cs).toHaveLength(2);
        const byModel = new Map<string, number>();
        for (const c of cs)
            byModel.set(normalizeModel(c.model), (byModel.get(normalizeModel(c.model)) ?? 0) + (c.tokens.output ?? 0));
        expect(byModel).toEqual(new Map([['m', 100]]));
    });
});
