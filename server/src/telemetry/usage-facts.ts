import type { TransactionSql } from 'postgres';
import {
    reduceTokenObservations,
    type BranchEvidence,
    type ExecutionEvidence,
    type Launch,
    type SessionSpan,
    type TokenObservation,
    type TokenSource,
    type TokenTemporality,
    type TokenType,
    type UsageInput,
    type UserRef,
} from '@factory-ai/core';
import type { CanonicalField } from './metric-map.js';

export { readGlobalReconciliation } from './usage-reconciliation.js';

/** A non-token field total of one owned session (lines, edits, commits, active seconds, and the legacy token scalar). */
export interface SessionFieldRow {
    agent: string;
    sessionId: string;
    field: CanonicalField;
    value: number;
}

/** Rows read per query and contributions per kind. Logged for sizing (fork F1); never part of a response. */
export interface FactsStats {
    rows: {
        evidence: number;
        branch: number;
        observations: number;
        spans: number;
        fields: number;
        users: number;
    };
    contributions: { timed: number; unlocated: number; unresolved: number; suppressed: number };
    /** Session ids another organization also has evidence for, dropped before they reached memory as evidence. */
    foreignSessions: number;
    ms: number;
}

export interface UsageFacts extends UsageInput {
    users: UserRef[];
    fields: SessionFieldRow[];
    stats: FactsStats;
}

export interface UsageFactsOptions {
    /** Canonical task ids; omitted means the whole organization. */
    taskIds?: readonly string[];
}

/** The placeholder org of a session_branch row no organization claimed (005_organizations.sql): evidence for nobody. */
export const UNCLAIMED_ORG = '__unclaimed__';

const TOKEN_FIELDS = ['tokens_input', 'tokens_output', 'tokens_cacheRead', 'tokens_cacheCreation'] as const;
const TOKEN_FIELD_PREFIX = 'tokens_';

interface EvidenceRow {
    job_id: string;
    claim_seq: string;
    session_id: string;
    agent: string | null;
    root_job_id: string;
    requesting_job_id: string | null;
    requesting_root_job_id: string | null;
    author_id: string | null;
    repo: string | null;
    launch: Launch;
    adopts_claim_seq: string | null;
    origin: 'claim' | 'backfill';
    created_at: Date | null;
    ended_at: Date | null;
    live: boolean;
    removed: boolean;
    operational: boolean;
}

interface ObservationRow {
    agent: string;
    session_id: string;
    source: TokenSource;
    metric: string;
    field: string;
    temporality: TokenTemporality;
    start_time: Date | null;
    time: Date;
    value: number;
    attrs: Record<string, string>;
}

const iso = (d: Date): string => new Date(d).toISOString();

function evidenceOf(orgId: string, r: EvidenceRow): ExecutionEvidence {
    return {
        orgId,
        jobId: r.job_id,
        claimSeq: Number(r.claim_seq),
        sessionId: r.session_id,
        agent: r.agent,
        rootJobId: r.root_job_id,
        requestingJobId: r.requesting_job_id,
        requestingRootJobId: r.requesting_root_job_id,
        authorId: r.author_id,
        repo: r.repo,
        launch: r.launch,
        adoptsClaimSeq: r.adopts_claim_seq === null ? null : Number(r.adopts_claim_seq),
        origin: r.origin,
        startedAt: r.created_at === null ? null : iso(r.created_at),
        endedAt: r.ended_at === null ? null : iso(r.ended_at),
        live: r.live,
        removed: r.removed,
        operational: r.operational,
    };
}

const observationOf = (r: ObservationRow): TokenObservation => ({
    agent: r.agent,
    sessionId: r.session_id,
    source: r.source,
    metric: r.metric,
    field: r.field.slice(TOKEN_FIELD_PREFIX.length) as TokenType,
    temporality: r.temporality,
    startTime: r.start_time === null ? null : iso(r.start_time),
    time: iso(r.time),
    value: Number(r.value),
    attrs: r.attrs,
});

/**
 * Everything the usage reducer needs for one organization, read inside the CALLER's transaction so
 * the board's provenance, the telemetry points and the run rows share one snapshot (callers open
 * `repeatable read, read only`; this never opens a transaction of its own).
 *
 * Every read is bound to the tenant before it reaches memory: a session id is read only when the
 * organization has board or branch evidence for it, and a session id any OTHER organization also
 * has evidence for is dropped whole (evidence, points, spans) - it appears in no tenant payload,
 * not even as a count. A session with no evidence anywhere is never read.
 */
export async function readUsageFacts(
    tx: TransactionSql,
    orgId: string,
    options: UsageFactsOptions = {}
): Promise<UsageFacts> {
    const started = Date.now();
    const { taskIds } = options;
    const sessionIds = taskIds
        ? tx`select distinct s.session_id
             from job_execution_session s
             join job_execution e on e.org_id = s.org_id and e.job_id = s.job_id and e.claim_seq = s.claim_seq
             where e.org_id = ${orgId}
               and coalesce(e.requesting_root_job_id, e.root_job_id) = any(${tx.array([...taskIds])}::uuid[])`
        : tx`select session_id from job_execution_session where org_id = ${orgId}
             union
             select session_id from session_branch where org_id = ${orgId}`;

    const [evidenceRows, branchRows, foreignRows] = await Promise.all([
        tx<EvidenceRow[]>`
            select e.job_id, e.claim_seq, s.session_id, coalesce(s.agent, e.agent) as agent, e.root_job_id,
                   e.requesting_job_id, e.requesting_root_job_id, e.author_id, e.repo, e.launch,
                   e.adopts_claim_seq, e.origin, e.created_at, e.ended_at,
                   (e.ended_at is null and j.claim_seq = e.claim_seq and j.status = 'running') as live,
                   (e.removed_at is not null or rj.id is null) as removed,
                   (j.id is not null) as operational
            from job_execution e
            join job_execution_session s on s.org_id = e.org_id and s.job_id = e.job_id and s.claim_seq = e.claim_seq
            left join job j on j.org_id = e.org_id and j.id = e.job_id
            left join job rj on rj.org_id = e.org_id and rj.id = e.root_job_id
            where e.org_id = ${orgId} and s.session_id in (${sessionIds})
        `,
        tx<{ agent: string; session_id: string; repo: string }[]>`
            select distinct agent, session_id, repo from session_branch
            where org_id = ${orgId} and session_id in (${sessionIds})
        `,
        tx<{ session_id: string }[]>`
            select session_id from job_execution_session
            where org_id <> ${orgId} and session_id in (${sessionIds})
            union
            select session_id from session_branch
            where org_id not in (${orgId}, ${UNCLAIMED_ORG}) and session_id in (${sessionIds})
        `,
    ]);

    const foreign = new Set(foreignRows.map((r) => r.session_id));
    const foreignList = tx.array([...foreign]);
    const [observationRows, spanRows, fieldRows] = await Promise.all([
        tx<ObservationRow[]>`
            select agent, session_id, source, metric, field, temporality, start_time, time, value, attrs
            from metric_point
            where session_id in (${sessionIds}) and session_id <> all(${foreignList}::text[])
              and field in ${tx(TOKEN_FIELDS)}
        `,
        tx<{ agent: string; session_id: string; first_seen: Date; last_seen: Date }[]>`
            select agent, session_id, min(time) as first_seen, max(time) as last_seen
            from metric_point_used
            where session_id in (${sessionIds}) and session_id <> all(${foreignList}::text[])
            group by agent, session_id
        `,
        tx<{ agent: string; session_id: string; field: CanonicalField; value: number }[]>`
            select agent, session_id, field, value from session_field_total
            where session_id in (${sessionIds}) and session_id <> all(${foreignList}::text[])
        `,
    ]);

    const board = evidenceRows.filter((r) => !foreign.has(r.session_id)).map((r) => evidenceOf(orgId, r));
    const branch: BranchEvidence[] = branchRows
        .filter((r) => !foreign.has(r.session_id))
        .map((r) => ({ orgId, agent: r.agent, sessionId: r.session_id, repo: r.repo }));
    const authorIds = [...new Set(board.map((e) => e.authorId).filter((a): a is string => a !== null))];
    const userRows = authorIds.length
        ? await tx<{ id: string; github_login: string; display_name: string | null; avatar_url: string | null }[]>`
              select id, github_login, display_name, avatar_url from app_user where id = any(${tx.array(authorIds)}::uuid[])
          `
        : [];

    const contributions = reduceTokenObservations(observationRows.map(observationOf));
    const spans: SessionSpan[] = spanRows.map((r) => ({
        agent: r.agent,
        sessionId: r.session_id,
        firstSeen: iso(r.first_seen),
        lastSeen: iso(r.last_seen),
    }));
    const count = (kind: string): number => contributions.filter((c) => c.kind === kind).length;
    return {
        orgId,
        board,
        branch,
        // Dropped above, not carried: a foreign id never reaches the reducer or any payload.
        foreignSessionIds: new Set<string>(),
        contributions,
        spans,
        users: userRows.map((u) => ({
            id: u.id,
            login: u.github_login,
            name: u.display_name,
            avatarUrl: u.avatar_url,
        })),
        fields: fieldRows.map((r) => ({
            agent: r.agent,
            sessionId: r.session_id,
            field: r.field,
            value: Number(r.value),
        })),
        stats: {
            rows: {
                evidence: evidenceRows.length,
                branch: branchRows.length,
                observations: observationRows.length,
                spans: spanRows.length,
                fields: fieldRows.length,
                users: userRows.length,
            },
            contributions: {
                timed: count('timed'),
                unlocated: count('unlocated'),
                unresolved: count('unresolved'),
                suppressed: count('suppressed'),
            },
            foreignSessions: foreign.size,
            ms: Date.now() - started,
        },
    };
}

/** No evidence, no points: what a client with nothing to read (the offline fixture, until D3) answers. */
export function emptyUsageFacts(orgId: string): UsageFacts {
    return {
        orgId,
        board: [],
        branch: [],
        foreignSessionIds: new Set<string>(),
        contributions: [],
        spans: [],
        users: [],
        fields: [],
        stats: {
            rows: { evidence: 0, branch: 0, observations: 0, spans: 0, fields: 0, users: 0 },
            contributions: { timed: 0, unlocated: 0, unresolved: 0, suppressed: 0 },
            foreignSessions: 0,
            ms: 0,
        },
    };
}
