/**
 * The per-run activity reduction (issue #339): the `metric_point` rows of ONE session, bucketed
 * over the run's wall clock into token and edit figures a small chart can draw. A flat line means
 * stuck; a steady bar means working — the "was the run making progress" answer, read off data the
 * ingest already holds.
 *
 * The reduction lives here rather than in SQL for the same reason the week bucketing lives in
 * core (docs/metrics.md): the temporality-aware rule is the one correctness hazard in the feature,
 * and it is unit-testable only as plain code. The rule itself is core's `reduceTokenObservations`;
 * this file maps points to observations and drops the contributions into the run's buckets.
 */
import { partitionByRange, reduceTokenObservations } from '@factory-ai/core';
import type { TokenContribution, TokenObservation, TokenType } from '@factory-ai/core';

/** One raw `metric_point_used` row, as the SQL read lifts it. */
export interface ActivityPoint {
    field: string;
    temporality: string;
    /** The cumulative counter's series start; null on a delta point. */
    startTime: string | null;
    attrs: Record<string, string>;
    metric: string;
    agent: string;
    value: number;
    time: string;
}

/** The four token types the executors report, kept apart — one total would hide the cache split. */
export interface TokenTypes {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
}

/** One bucket of the run's wall clock: tokens processed by type, and edit decisions made inside it. */
export interface ActivityBucket {
    start: string;
    tokens: TokenTypes;
    edits: number;
}

/** The bucket-width ladder, narrow to wide. */
const MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 300_000;
const FIFTEEN_MINUTES_MS = 900_000;
const THIRTY_MINUTES_MS = 1_800_000;
const HOUR_MS = 3_600_000;
const LADDER_MS = [MINUTE_MS, FIVE_MINUTES_MS, FIFTEEN_MINUTES_MS, THIRTY_MINUTES_MS, HOUR_MS] as const;
/** The chart's bar budget: beyond ~16 bars a run-activity chart renders hairlines, not shapes. */
const MAX_BUCKETS = 16;

/** Smallest ladder width giving at most `MAX_BUCKETS` bars over the run; the hour beyond it. */
export function pickBucketMs(runMs: number): number {
    for (const width of LADDER_MS) {
        if (Math.ceil(runMs / width) <= MAX_BUCKETS) return width;
    }
    return LADDER_MS[LADDER_MS.length - 1]!;
}

/** The token fields this reduction charts, and the reducer type each one is. */
const TOKEN_OF_FIELD: Readonly<Record<string, TokenType>> = {
    tokens_input: 'input',
    tokens_output: 'output',
    tokens_cacheRead: 'cacheRead',
    tokens_cacheCreation: 'cacheCreation',
};

/**
 * Edit decisions ride the same reducer; the `decision` attribute already keeps accept and reject
 * apart, so the reducer's type slot only carries the count, never tokens.
 */
const EDIT_SLOT_OF_FIELD: Readonly<Record<string, TokenType>> = { edits_accept: 'input', edits_reject: 'input' };

const emptyTokens = (): TokenTypes => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });

/** The points of ONE session, so the session id is a constant; the agent still keeps agents apart. */
function toObservations(points: readonly ActivityPoint[], slots: Readonly<Record<string, TokenType>>) {
    const observations: TokenObservation[] = [];
    for (const point of points) {
        const field = slots[point.field];
        if (field === undefined || !Number.isFinite(Date.parse(point.time))) continue;
        if (!Number.isFinite(point.value) || point.value < 0) continue;
        const startTime =
            point.startTime !== null && Number.isFinite(Date.parse(point.startTime)) ? point.startTime : null;
        observations.push({
            agent: point.agent,
            sessionId: 'run',
            source: 'otel',
            metric: point.metric,
            field,
            temporality:
                point.temporality === 'delta' || point.temporality === 'cumulative' ? point.temporality : 'unspecified',
            startTime,
            time: point.time,
            value: point.value,
            attrs: point.attrs,
        });
    }
    return observations;
}

/**
 * Buckets the points over `[from, to]` at `bucketMs`, seeding every bucket in the window — a
 * quiet stretch renders as a quiet stretch, never a gap. The points go through the shared token
 * reducer whole, readings before `from` included: a cumulative series' running maximum already
 * reached then is the baseline, so a follow-up run counts only what it added. Only timed
 * contributions inside the window are added (unlocated and unspecified ones never are); fields
 * this reduction does not chart fall out.
 */
export function bucketizeActivity(
    points: readonly ActivityPoint[],
    opts: { from: string; to: string; bucketMs: number }
): ActivityBucket[] {
    const fromMs = Date.parse(opts.from);
    const toMs = Date.parse(opts.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || opts.bucketMs <= 0) return [];
    const count = Math.max(1, Math.ceil((toMs - fromMs) / opts.bucketMs));
    const buckets: ActivityBucket[] = Array.from({ length: count }, (_, i) => ({
        start: new Date(fromMs + i * opts.bucketMs).toISOString(),
        tokens: emptyTokens(),
        edits: 0,
    }));
    // The window is closed at `to`; the partition's range is half-open.
    const place = (observations: TokenObservation[], add: (bucket: ActivityBucket, c: TokenContribution) => void) => {
        const { timed } = partitionByRange(
            reduceTokenObservations(observations),
            opts.from,
            new Date(toMs + 1).toISOString()
        );
        for (const c of timed) {
            const index = Math.floor((Date.parse(c.observedAt as string) - fromMs) / opts.bucketMs);
            add(buckets[Math.min(index, count - 1)]!, c);
        }
    };
    place(toObservations(points, TOKEN_OF_FIELD), (bucket, c) => {
        for (const type of Object.keys(bucket.tokens) as TokenType[]) bucket.tokens[type] += c.tokens[type] ?? 0;
    });
    place(toObservations(points, EDIT_SLOT_OF_FIELD), (bucket, c) => {
        bucket.edits += c.tokens.input ?? 0;
    });
    return buckets;
}

/** The run's token totals by type, summed over its buckets. */
export function totalTokens(buckets: readonly ActivityBucket[]): TokenTypes {
    const total = emptyTokens();
    for (const bucket of buckets) {
        total.input += bucket.tokens.input;
        total.output += bucket.tokens.output;
        total.cacheRead += bucket.tokens.cacheRead;
        total.cacheCreation += bucket.tokens.cacheCreation;
    }
    return total;
}
