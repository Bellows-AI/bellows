/**
 * The per-run activity read (issues #339, #847): one run's assigned token contributions bucketed over
 * the run's segment span into figures a small chart can draw, beside the run's usage block and the
 * canonical task it belongs to. A flat line means stuck; a steady bar means working.
 *
 * The ownership, run assignment and token reduction are core's (`taskUsageOf`, `runContributionsOf`);
 * this file only places the run's already-assigned amounts into time buckets, so the buckets sum to
 * the run's usage by construction. A token type the run never measured stays null in every bucket.
 */
import {
    TOKEN_TYPE_LIST,
    runContributionsOf,
    taskUsageOf,
    type TaskUsage,
    type TokenContribution,
    type TokenType,
    type Tokens,
    type UsageBlock,
} from '@factory-ai/core';
import type { UsageFacts } from './usage-facts.js';

/** One bucket of the run's span: tokens by type (null: type not measured) and edit decisions (null: none measured). */
export interface ActivityBucket {
    start: string;
    tokens: Tokens;
    edits: number | null;
}

/** The run half of the activity answer; `buckets` is empty when the run measured nothing. */
export interface RunActivity {
    from: string | null;
    to: string | null;
    bucketMs: number | null;
    buckets: ActivityBucket[];
    usage: UsageBlock;
}

export interface RunActivityRead {
    /** Null when no evidence names the task. */
    task: TaskUsage | null;
    /** Null when the job is not among the task's runs. */
    run: RunActivity | null;
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

/** Index of the bucket a point falls in, clamped: an amount assigned to the run is never dropped for an edge. */
function indexOf(contribution: TokenContribution, fromMs: number, bucketMs: number, count: number): number {
    const at = Date.parse(contribution.observedAt as string);
    return Math.min(count - 1, Math.max(0, Math.floor((at - fromMs) / bucketMs)));
}

/** Seeds every bucket of the span (a measured type at 0, an unmeasured one null) and places each amount. */
function placeInBuckets(
    measuredTokens: Tokens,
    amounts: { tokens: readonly TokenContribution[]; edits: readonly TokenContribution[] },
    span: { fromMs: number; spanMs: number; bucketMs: number }
): ActivityBucket[] {
    const { fromMs, spanMs, bucketMs } = span;
    const tokenContribs = amounts.tokens;
    const editContribs = amounts.edits;
    const count = Math.max(1, Math.ceil(spanMs / bucketMs));
    const zeroOrNull = (type: TokenType): number | null => (measuredTokens[type] === null ? null : 0);
    const buckets: ActivityBucket[] = Array.from({ length: count }, (_, i) => ({
        start: new Date(fromMs + i * bucketMs).toISOString(),
        tokens: {
            input: zeroOrNull('input'),
            output: zeroOrNull('output'),
            cacheRead: zeroOrNull('cacheRead'),
            cacheCreation: zeroOrNull('cacheCreation'),
        },
        edits: editContribs.length === 0 ? null : 0,
    }));
    for (const c of tokenContribs) {
        const bucket = buckets[indexOf(c, fromMs, bucketMs, count)]!;
        for (const type of TOKEN_TYPE_LIST) {
            const value = c.tokens[type];
            if (value !== null) bucket.tokens[type] = (bucket.tokens[type] ?? 0) + value;
        }
    }
    for (const c of editContribs) {
        const bucket = buckets[indexOf(c, fromMs, bucketMs, count)]!;
        bucket.edits = (bucket.edits ?? 0) + (c.tokens.input ?? 0);
    }
    return buckets;
}

export function buildRunActivity(facts: UsageFacts, taskId: string, jobId: string, now: Date): RunActivityRead {
    const task = taskUsageOf(facts, taskId, now);
    const run = task?.runs.find((r) => r.jobId === jobId);
    if (!task || !run) return { task, run: null };
    if (run.startedAt === null)
        return { task, run: { from: null, to: null, bucketMs: null, buckets: [], usage: run.usage } };

    const from = run.startedAt;
    const to = run.endedAt ?? now.toISOString();
    const fromMs = Date.parse(from);
    const spanMs = Math.max(0, Date.parse(to) - fromMs);
    const bucketMs = pickBucketMs(spanMs);
    const tokenContribs = runContributionsOf(facts, taskId, jobId, now);
    const editContribs = runContributionsOf({ ...facts, contributions: facts.edits }, taskId, jobId, now);
    const base = { from, to, bucketMs, usage: run.usage };
    if (tokenContribs.length === 0 && editContribs.length === 0) return { task, run: { ...base, buckets: [] } };

    const buckets = placeInBuckets(
        run.usage.tokens,
        { tokens: tokenContribs, edits: editContribs },
        { fromMs, spanMs, bucketMs }
    );
    return { task, run: { ...base, buckets } };
}
