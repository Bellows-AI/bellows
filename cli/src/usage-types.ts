/**
 * The token-usage wire shapes of `GET /api/jobs/:id/activity`, copied from core/src/usage.ts (the CLI
 * imports nothing from core). Four token types travel side by side and are never totalled; `null` is
 * "not measured", a measured zero stays 0.
 */
export type TokenType = 'input' | 'output' | 'cacheRead' | 'cacheCreation';
export type Tokens = Record<TokenType, number | null>;
export type PerType<T> = Record<TokenType, T>;
export type UsagePrecision = 'exact' | 'estimated' | 'mixed';
export type UnassignedReason =
    | 'no-task'
    | 'no-segment'
    | 'overlap'
    | 'unconfirmed-launch'
    | 'refused-launch'
    | 'unknown-boundary'
    | 'cumulative-spans-runs';

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
