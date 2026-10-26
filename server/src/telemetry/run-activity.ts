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

/** The outcome words of a gate execution: the board's, plus `unknown` for a transcript call whose result proved nothing. */
export const GATE_OUTCOME_KEYS = [
    'passed',
    'failed',
    'setup_failed',
    'not_started',
    'incomplete',
    'running',
    'unknown',
] as const;
export type GateOutcomeKey = (typeof GATE_OUTCOME_KEYS)[number];
export type GateOutcomeCounts = Record<GateOutcomeKey, number>;

/** `null`: nothing was recorded, so nothing is claimed. `partial`: some figure is missing or unconfirmed. */
export type ActivityCoverage = 'complete' | 'partial' | null;

/** One `job_gate_run` row, as the activity read needs it. */
export interface GateRunRecord {
    jobId: string;
    executionId: string;
    gate: string;
    source: 'adhoc' | 'completion';
    filtered: boolean;
    outcome: Exclude<GateOutcomeKey, 'unknown'>;
    startedAt: string | null;
    finishedAt: string | null;
}

/** A completion check that was served from an earlier pass (`GateReport.reused` of the job's gate list). */
export interface ReusedGateRecord {
    jobId: string;
    gate: string;
    /** The execution whose result the check reused. */
    executionId: string;
    finishedAt: string | null;
    reason: string;
}

/** One `job_pr_operation` row. */
export interface PrOperationRecord {
    jobId: string;
    operationId: string;
    operation: 'created' | 'reused';
    repo: string;
    prNumber: number;
    prUrl: string;
}

/**
 * One transcript tool call, its call and result halves merged. `callId` is the call's coordinate
 * (executor, session, call id): unique per call, so two events of it are one observation.
 */
export interface ToolEventRecord {
    jobId: string;
    callId: string;
    kind: 'gate' | 'pr';
    operation: 'run' | 'create' | 'publish';
    outcome: 'passed' | 'failed' | 'unknown';
    executionId: string | null;
    operationId: string | null;
    prRepo: string | null;
    prNumber: number | null;
    prUrl: string | null;
    startedAt: string | null;
    endedAt: string | null;
}

/** Everything the board and the transcripts recorded for a set of jobs. */
export interface ActivityRecords {
    gateRuns: GateRunRecord[];
    reusedGates: ReusedGateRecord[];
    prOperations: PrOperationRecord[];
    toolEvents: ToolEventRecord[];
}

export interface GateActivity {
    coverage: ActivityCoverage;
    /** Managed executions, each once however many records name it; null when nothing was recorded. */
    executions: number | null;
    byOutcome: GateOutcomeCounts | null;
    /** Sum over the executions whose start and end are both known; null when none is. */
    measuredMs: number | null;
    measuredCount: number;
    unmeasuredCount: number;
    reused: { jobId: string; gate: string; executionId: string; finishedAt: string | null; reason: string }[];
    /** Gate calls the transcript shows that no managed record covers: agent activity, never in `executions`. */
    observed: { executions: number; byOutcome: GateOutcomeCounts } | null;
}

export interface PrOperationView {
    jobId: string;
    operationId: string | null;
    /** `unknown`: a confirmed transcript publish whose managed operation row is missing; created versus reused is not invented. */
    kind: 'created' | 'reused' | 'agent_created' | 'unknown';
    repo: string;
    number: number;
    url: string;
}

export interface PrActivity {
    coverage: ActivityCoverage;
    /** Operations and the distinct PRs they touched are different counts; null when nothing was recorded. */
    counts: { operations: number; distinct: number } | null;
    operations: PrOperationView[];
    distinct: { repo: string; number: number; url: string }[];
}

const zeroOutcomes = (): GateOutcomeCounts => ({
    passed: 0,
    failed: 0,
    setup_failed: 0,
    not_started: 0,
    incomplete: 0,
    running: 0,
    unknown: 0,
});

const durationOf = (start: string | null, end: string | null): number | null => {
    if (start === null || end === null) return null;
    const ms = Date.parse(end) - Date.parse(start);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

const EMPTY_GATES: GateActivity = {
    coverage: null,
    executions: null,
    byOutcome: null,
    measuredMs: null,
    measuredCount: 0,
    unmeasuredCount: 0,
    reused: [],
    observed: null,
};

/** The first record of each execution id among `jobs`. */
function managedRuns(records: ActivityRecords, jobs: ReadonlySet<string>): Map<string, GateRunRecord> {
    const runs = new Map<string, GateRunRecord>();
    for (const r of records.gateRuns) if (jobs.has(r.jobId) && !runs.has(r.executionId)) runs.set(r.executionId, r);
    return runs;
}

/** The transcript's gate calls: those of a managed execution (by id) and those no record covers (once per execution id, or call). */
function splitGateEvents(records: ActivityRecords, jobs: ReadonlySet<string>, runs: ReadonlyMap<string, unknown>) {
    const eventOf = new Map<string, ToolEventRecord>();
    const observed = new Map<string, ToolEventRecord>();
    for (const e of records.toolEvents) {
        if (!jobs.has(e.jobId) || e.kind !== 'gate') continue;
        const [into, key] =
            e.executionId !== null && runs.has(e.executionId)
                ? [eventOf, e.executionId]
                : [observed, e.executionId ?? e.callId];
        if (!into.has(key)) into.set(key, e);
    }
    return { eventOf, observed };
}

/** The gate half of the activity read for `jobIds` (one run, or every run of a task). */
export function gateActivityOf(records: ActivityRecords, jobIds: readonly string[]): GateActivity {
    const jobs = new Set(jobIds);
    const runs = managedRuns(records, jobs);
    const { eventOf, observed } = splitGateEvents(records, jobs, runs);
    const reused = records.reusedGates.filter((r) => jobs.has(r.jobId));
    if (runs.size === 0 && observed.size === 0 && reused.length === 0) return EMPTY_GATES;

    const byOutcome = zeroOutcomes();
    let measuredMs = 0;
    let measuredCount = 0;
    for (const run of runs.values()) {
        byOutcome[run.outcome] += 1;
        const event = eventOf.get(run.executionId);
        const ms = durationOf(run.startedAt ?? event?.startedAt ?? null, run.finishedAt ?? event?.endedAt ?? null);
        if (ms === null) continue;
        measuredCount += 1;
        measuredMs += ms;
    }
    const unmeasuredCount = runs.size - measuredCount;
    const observedByOutcome = zeroOutcomes();
    for (const e of observed.values()) observedByOutcome[e.outcome] += 1;
    const unsettled = byOutcome.running + byOutcome.incomplete > 0;
    return {
        coverage: unmeasuredCount > 0 || observed.size > 0 || unsettled ? 'partial' : 'complete',
        executions: runs.size,
        byOutcome,
        measuredMs: measuredCount > 0 ? measuredMs : null,
        measuredCount,
        unmeasuredCount,
        reused: reused.map(({ jobId, gate, executionId, finishedAt, reason }) => ({
            jobId,
            gate,
            executionId,
            finishedAt,
            reason,
        })),
        observed: { executions: observed.size, byOutcome: observedByOutcome },
    };
}

/**
 * What one unmanaged transcript PR call shows: the PR it confirmed (none for a failed or unconfirmed call),
 * and whether the figures are short of the truth because of it. A confirmed publish here has no managed
 * operation row: the PR is real, how it was made is not known, so it is `unknown`, never invented.
 */
function prFromCall(e: ToolEventRecord): { pr: PrOperationView | null; unconfirmed: boolean } {
    if (e.outcome === 'unknown') return { pr: null, unconfirmed: true };
    if (e.outcome !== 'passed' || e.operation === 'run') return { pr: null, unconfirmed: false };
    const publish = e.operation === 'publish';
    if (e.prRepo === null || e.prNumber === null || e.prUrl === null) return { pr: null, unconfirmed: true };
    const pr: PrOperationView = {
        jobId: e.jobId,
        operationId: null,
        kind: publish ? 'unknown' : 'agent_created',
        repo: e.prRepo,
        number: e.prNumber,
        url: e.prUrl,
    };
    return { pr, unconfirmed: publish };
}

/** The transcript's PR calls no managed operation covers: the PRs they confirm, and whether any call went unconfirmed. */
function observedPrCalls(records: ActivityRecords, jobs: ReadonlySet<string>, managed: ReadonlyMap<string, unknown>) {
    const created: PrOperationView[] = [];
    const seen = new Set<string>();
    let observed = false;
    let unconfirmed = false;
    for (const e of records.toolEvents) {
        if (!jobs.has(e.jobId) || e.kind !== 'pr' || seen.has(e.callId)) continue;
        seen.add(e.callId);
        if (e.operationId !== null && managed.has(e.operationId)) continue;
        observed = true;
        const call = prFromCall(e);
        if (call.unconfirmed) unconfirmed = true;
        if (call.pr) created.push(call.pr);
    }
    return { created, observed, unconfirmed };
}

/** The PR half of the activity read for `jobIds`: managed operations, plus PRs the agent created per the transcript. */
export function prActivityOf(records: ActivityRecords, jobIds: readonly string[]): PrActivity {
    const jobs = new Set(jobIds);
    const managed = new Map<string, PrOperationRecord>();
    for (const o of records.prOperations) {
        if (jobs.has(o.jobId) && !managed.has(o.operationId)) managed.set(o.operationId, o);
    }
    const { created, observed, unconfirmed } = observedPrCalls(records, jobs, managed);
    const operations: PrOperationView[] = [
        ...[...managed.values()].map((o) => ({
            jobId: o.jobId,
            operationId: o.operationId,
            kind: o.operation,
            repo: o.repo,
            number: o.prNumber,
            url: o.prUrl,
        })),
        ...created,
    ];
    if (operations.length === 0 && !observed) return { coverage: null, counts: null, operations: [], distinct: [] };
    const distinct = new Map<string, { repo: string; number: number; url: string }>();
    for (const o of operations) {
        const key = `${o.repo}#${o.number}`;
        if (!distinct.has(key)) distinct.set(key, { repo: o.repo, number: o.number, url: o.url });
    }
    return {
        coverage: unconfirmed ? 'partial' : 'complete',
        counts: { operations: operations.length, distinct: distinct.size },
        operations,
        distinct: [...distinct.values()],
    };
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
