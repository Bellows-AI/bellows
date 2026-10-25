import type { TokenContribution, TokenType } from '../src/token-contributions.js';
import type { BranchEvidence, ExecutionEvidence, Tokens, UsageInput, UsageOptions } from '../src/usage.js';

export const ORG = 'org-a';
const BASE = Date.UTC(2026, 2, 2, 10, 0, 0);
/** ISO instant `minutes` after 2026-03-02T10:00Z. */
export const at = (minutes: number): string => new Date(BASE + minutes * 60_000).toISOString();

export function ev(over: Partial<ExecutionEvidence> = {}): ExecutionEvidence {
    return {
        orgId: ORG,
        jobId: 'j1',
        claimSeq: 1,
        sessionId: 's1',
        agent: 'claude-code',
        rootJobId: 'j1',
        requestingJobId: null,
        requestingRootJobId: null,
        authorId: 'u1',
        repo: 'repo-1',
        launch: 'observed',
        adoptsClaimSeq: null,
        origin: 'claim',
        startedAt: at(0),
        endedAt: at(10),
        live: false,
        removed: false,
        operational: true,
        ...over,
    };
}

export const branch = (over: Partial<BranchEvidence> = {}): BranchEvidence => ({
    orgId: ORG,
    agent: 'claude-code',
    sessionId: 's1',
    repo: 'repo-1',
    ...over,
});

interface PointOptions {
    session?: string | null;
    agent?: string;
    type?: TokenType;
    model?: string | null;
    querySource?: string | null;
}

function tokensOf(type: TokenType, value: number): Tokens {
    return { input: null, output: null, cacheRead: null, cacheCreation: null, [type]: value };
}

function series(o: PointOptions, temporality: 'delta' | 'cumulative') {
    return {
        agent: o.agent ?? 'claude-code',
        sessionId: o.session === undefined ? 's1' : o.session,
        metric: 'token.usage',
        field: o.type ?? 'output',
        temporality,
        startTime: null,
        attrsKey: '[]',
    } as const;
}

/** An exact delta point `minute` minutes in. */
export function delta(minute: number, value: number, o: PointOptions = {}): TokenContribution {
    return {
        selection: { agent: o.agent ?? 'claude-code', sessionId: o.session === undefined ? 's1' : o.session },
        source: 'otel',
        series: series(o, 'delta'),
        model: o.model === undefined ? 'm-1' : o.model,
        querySource: o.querySource === undefined ? 'main' : o.querySource,
        tokens: tokensOf(o.type ?? 'output', value),
        observedAt: at(minute),
        support: { from: at(minute), to: at(minute) },
        kind: 'timed',
        precision: 'exact',
        reasons: [],
    };
}

/** A cumulative increment of `value` supported by `[from, to]` and observed at `to`. */
export function cumulative(from: number, to: number, value: number, o: PointOptions = {}): TokenContribution {
    return {
        ...delta(to, value, o),
        series: series(o, 'cumulative'),
        support: { from: at(from), to: at(to) },
        precision: 'estimated',
        reasons: ['cumulative-increase'],
    };
}

export function unlocated(value: number, o: PointOptions = {}): TokenContribution {
    return {
        ...delta(0, value, o),
        series: series(o, 'cumulative'),
        observedAt: null,
        support: null,
        kind: 'unlocated',
        precision: 'unlocated',
        reasons: ['cumulative-first-unlocated'],
    };
}

export function unresolvedPoint(minute: number, value: number, o: PointOptions = {}): TokenContribution {
    return {
        ...delta(minute, value, o),
        series: series(o, 'delta'),
        support: null,
        kind: 'unresolved',
        precision: 'unlocated',
        reasons: ['unspecified-temporality'],
    };
}

export function world(over: Partial<UsageInput> = {}): UsageInput {
    return {
        orgId: ORG,
        board: [],
        branch: [],
        foreignSessionIds: new Set(),
        contributions: [],
        spans: [],
        ...over,
    };
}

export const NOW = new Date(Date.UTC(2026, 2, 9, 0, 0, 0));
export const ALL: UsageOptions = { range: null, now: NOW };
export const none = (): Tokens => ({ input: null, output: null, cacheRead: null, cacheCreation: null });
export const out = (value: number | null): Tokens => ({ ...none(), output: value });
