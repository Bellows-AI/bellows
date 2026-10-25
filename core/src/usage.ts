/**
 * Types and small helpers of the usage reducer: who owns a session's tokens, which run a point
 * belongs to, and the one block shape every surface renders. Four token types are carried side by
 * side and never totalled; `null` is "not measured", a measured zero stays 0.
 */
import type { TokenContribution, TokenFields, TokenType } from './token-contributions.js';

export type Tokens = TokenFields;
export type PerType<T> = Record<TokenType, T>;
export type Launch = 'requested' | 'observed' | 'refused' | 'unknown' | 'adopted';
/** Stable display order of the reasons an eligible amount has no run. */
export const UNASSIGNED_REASONS = [
    'no-task',
    'no-segment',
    'overlap',
    'unconfirmed-launch',
    'refused-launch',
    'unknown-boundary',
    'cumulative-spans-runs',
] as const;
export type UnassignedReason = (typeof UNASSIGNED_REASONS)[number];
export type UsagePrecision = 'exact' | 'estimated' | 'mixed';

/** One (execution, session) pair; the reader fills it from `job_execution` x `job_execution_session`. */
export interface ExecutionEvidence {
    orgId: string;
    jobId: string;
    claimSeq: number;
    sessionId: string;
    /** Null for driver-path reports: matches every agent of the session id. */
    agent: string | null;
    rootJobId: string;
    requestingJobId: string | null;
    requestingRootJobId: string | null;
    authorId: string | null;
    repo: string | null;
    launch: Launch;
    adoptsClaimSeq: number | null;
    origin: 'claim' | 'backfill';
    startedAt: string;
    /** Null while the claim is live or its end was lost: open to +infinity. */
    endedAt: string | null;
    live: boolean;
    removed: boolean;
    /** The job row still exists. */
    operational: boolean;
}
export interface BranchEvidence {
    orgId: string;
    agent: string;
    sessionId: string;
    repo: string;
}
export interface SessionSpan {
    agent: string;
    sessionId: string;
    firstSeen: string;
    lastSeen: string;
}

export type Owner =
    | {
          status: 'resolved';
          taskId: string | null;
          removed: boolean;
          authorId: string | null;
          /** More than one distinct board author: the task stays resolved, the author is unknown. */
          authorConflict: boolean;
          repo: string | null;
          hook: boolean;
      }
    | { status: 'unresolved'; reason: 'task-conflict' | 'repo-conflict' }
    | { status: 'excluded'; reason: 'foreign-org' | 'unowned' };

export interface UsageRow {
    model: string;
    rawModels: string[];
    querySource: string | null;
    tokens: Tokens;
    children?: UsageRow[];
}

export interface UsageBlock {
    state: 'measured' | 'unmeasured' | 'unavailable';
    provisional: boolean;
    tokens: Tokens;
    assigned: Tokens;
    unassigned: { reason: UnassignedReason; tokens: Tokens }[];
    unlocated: Tokens;
    unresolvedTemporality: { observations: number };
    precision: PerType<UsagePrecision | null>;
    coverage: PerType<{ measured: number; contributors: number }>;
    rows: UsageRow[];
    counts: { sessions: number; runs: number; tasks: number };
}

export interface RunUsage {
    jobId: string;
    kind: 'run' | 'follow-up' | 'review';
    reviewOf: string | null;
    live: boolean;
    operational: boolean;
    startedAt: string | null;
    endedAt: string | null;
    usage: UsageBlock;
}
/** `usage` equals the sum of `runs[].usage` and `taskOwned`, per type, null-aware. */
export interface TaskUsage {
    taskId: string;
    removed: boolean;
    usage: UsageBlock;
    runs: RunUsage[];
    taskOwned: UsageBlock | null;
}
export interface UserUsage {
    /** Null: unknown author. */
    userId: string | null;
    usage: UsageBlock;
}

export interface UsageInput {
    orgId: string;
    board: readonly ExecutionEvidence[];
    branch: readonly BranchEvidence[];
    /** Session ids any other org has evidence for. No other detail crosses. */
    foreignSessionIds: ReadonlySet<string>;
    contributions: readonly TokenContribution[];
    spans: readonly SessionSpan[];
}
export interface UsageOptions {
    range: { from: string; to: string } | null;
    repos?: readonly string[];
    userId?: string;
    now: Date;
    granularity?: 'day' | 'week';
}
/** Usage kept out of `eligible`: timed `tokens`, `unlocated` amounts and unresolved-temporality observations stay apart. */
export interface DiagnosticBucket {
    sessions: number;
    tokens: Tokens;
    unlocated: Tokens;
    unresolvedTemporality: { observations: number };
}
export interface UsageReport {
    eligible: UsageBlock;
    tasks: TaskUsage[];
    byUser: UserUsage[];
    series: { start: string; partial: boolean; usage: UsageBlock }[];
    diagnostics: {
        sessionsWithoutHook: number;
        unresolvedOwnership: DiagnosticBucket;
        excludedRepo: DiagnosticBucket;
    };
}

export const TOKEN_TYPE_LIST: readonly TokenType[] = ['input', 'output', 'cacheRead', 'cacheCreation'];

export function unmeasuredTokens(): Tokens {
    return { input: null, output: null, cacheRead: null, cacheCreation: null };
}

/** Null-aware per type: null only when neither side measured the type. */
export function addTokens(a: Tokens, b: Tokens): Tokens {
    const sum = unmeasuredTokens();
    for (const type of TOKEN_TYPE_LIST) {
        const x = a[type];
        const y = b[type];
        sum[type] = x === null ? y : y === null ? x : x + y;
    }
    return sum;
}

export function perType<T>(make: (type: TokenType) => T): PerType<T> {
    return {
        input: make('input'),
        output: make('output'),
        cacheRead: make('cacheRead'),
        cacheCreation: make('cacheCreation'),
    };
}

export function emptyBlock(state: UsageBlock['state']): UsageBlock {
    return {
        state,
        provisional: false,
        tokens: unmeasuredTokens(),
        assigned: unmeasuredTokens(),
        unassigned: [],
        unlocated: unmeasuredTokens(),
        unresolvedTemporality: { observations: 0 },
        precision: perType(() => null),
        coverage: perType(() => ({ measured: 0, contributors: 0 })),
        rows: [],
        counts: { sessions: 0, runs: 0, tasks: 0 },
    };
}

export function epochMs(iso: string): number {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) throw new RangeError(`invalid timestamp: ${iso}`);
    return ms;
}

export function compareText(a: string, b: string): number {
    if (a < b) return -1;
    return a > b ? 1 : 0;
}
