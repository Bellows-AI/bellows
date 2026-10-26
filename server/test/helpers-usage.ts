import type {
    BranchEvidence,
    ExecutionEvidence,
    SessionSpan,
    TokenContribution,
    TokenType,
    UserRef,
} from '@factory-ai/core';
import { emptyUsageFacts, type UsageFacts } from '../src/telemetry/usage-facts.js';
import { TEST_REPO } from './helpers-config.js';

export interface UsageSessionSpec {
    sessionId: string;
    /** The canonical task (job thread); null: only the hook knows the session. */
    taskId: string | null;
    /** The member who queued the task; null: unknown author. */
    authorId?: string | null;
    repo?: string;
    /** One delta point per measured type at `at`; null or absent: the type was never measured. */
    input?: number | null;
    output?: number | null;
    at: string;
    /** Default true; false: a board-owned session no branch report named. */
    hook?: boolean;
}

export function point(sessionId: string, type: TokenType, value: number, at: string): TokenContribution {
    return {
        selection: { agent: 'claude-code', sessionId },
        source: 'otel',
        series: {
            agent: 'claude-code',
            sessionId,
            metric: 'token.usage',
            field: type,
            temporality: 'delta',
            startTime: null,
            attrsKey: '[]',
        },
        model: 'm-1',
        querySource: 'main',
        tokens: { input: null, output: null, cacheRead: null, cacheCreation: null, [type]: value },
        observedAt: at,
        support: { from: at, to: at },
        kind: 'timed',
        precision: 'exact',
        reasons: [],
    };
}

/** Synthetic usage facts for hand-built stats scenarios: the board evidence, hook reports, points and spans of each session. */
export function usageFactsOf(
    specs: readonly UsageSessionSpec[],
    users: readonly UserRef[] = [],
    foreignSessionIds: readonly string[] = []
): UsageFacts {
    const base = emptyUsageFacts('stub');
    const facts = {
        spans: [] as SessionSpan[],
        branch: [] as BranchEvidence[],
        board: [] as ExecutionEvidence[],
        contributions: [] as TokenContribution[],
    };
    for (const spec of specs) {
        const repo = spec.repo ?? TEST_REPO;
        facts.spans.push({ agent: 'claude-code', sessionId: spec.sessionId, firstSeen: spec.at, lastSeen: spec.at });
        if (spec.hook !== false)
            facts.branch.push({ orgId: base.orgId, agent: 'claude-code', sessionId: spec.sessionId, repo });
        if (spec.taskId !== null) {
            facts.board.push({
                orgId: base.orgId,
                jobId: spec.taskId,
                claimSeq: 1,
                sessionId: spec.sessionId,
                agent: 'claude-code',
                rootJobId: spec.taskId,
                requestingJobId: null,
                requestingRootJobId: null,
                authorId: spec.authorId ?? null,
                repo,
                launch: 'observed',
                adoptsClaimSeq: null,
                origin: 'claim',
                startedAt: '2026-08-01T00:00:00.000Z',
                endedAt: null,
                live: false,
                removed: false,
                operational: true,
            });
        }
        for (const type of ['input', 'output'] as const) {
            const value = spec[type];
            if (value !== undefined && value !== null)
                facts.contributions.push(point(spec.sessionId, type, value, spec.at));
        }
    }
    return { ...base, ...facts, users: [...users], foreignSessionIds: new Set(foreignSessionIds) };
}
