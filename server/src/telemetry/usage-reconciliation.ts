import type { TransactionSql } from 'postgres';
import {
    addTokens,
    reduceTokenObservations,
    reduceUsage,
    resolveOwnership,
    unmeasuredTokens,
    type BranchEvidence,
    type ExecutionEvidence,
    type TokenContribution,
    type TokenObservation,
    type Tokens,
    type UnassignedReason,
    type UsageInput,
} from '@factory-ai/core';

/** Where every timed or unlocated token of the store lands, across all organizations. */
export interface OrgReconciliation {
    assigned: Tokens;
    unassigned: Partial<Record<UnassignedReason, Tokens>>;
    /** Located usage with a resolved owner (assigned + every unassigned reason). */
    eligible: Tokens;
    /** Cumulative amounts with no start, owned by this organization. */
    unlocated: Tokens;
    /** Tenant-bound conflicting owners (timed + unlocated). */
    unresolved: Tokens;
}
export interface GlobalReconciliation {
    perOrg: Map<string, OrgReconciliation>;
    /** Session ids two organizations both have evidence for. */
    foreign: Tokens;
    /** No board or branch evidence anywhere, or no session at all. */
    unowned: Tokens;
    /** Every destination added: what an independent sum of the stored series must equal. */
    total: Tokens;
}

interface Stored {
    agent: string;
    session_id: string | null;
    source: TokenObservation['source'];
    metric: string;
    field: string;
    temporality: TokenObservation['temporality'];
    start_time: Date | null;
    time: Date;
    value: number;
    attrs: Record<string, string>;
}

const iso = (d: Date): string => new Date(d).toISOString();
const sumOf = (list: readonly Tokens[]): Tokens => list.reduce((acc, t) => addTokens(acc, t), unmeasuredTokens());

/**
 * Test-only (`server/test-db/token-reconciliation.test.ts`), never a route: classifies every
 * located or unlocated contribution of the whole store with the same ownership rule the tenant
 * reads use, and sums where each landed. The tenant payloads cannot show cross-organization or
 * unowned usage - this is the one place that does, so a conservation check has somewhere to stand.
 */
export async function readGlobalReconciliation(tx: TransactionSql, now = new Date()): Promise<GlobalReconciliation> {
    const [stored, executions, branches] = await Promise.all([
        tx<Stored[]>`
            select agent, session_id, source, metric, field, temporality, start_time, time, value, attrs
            from metric_point where field like 'tokens\\_%'
        `,
        tx<{ org_id: string; job_id: string; claim_seq: string; session_id: string; agent: string | null }[]>`
            select e.org_id, e.job_id, e.claim_seq, s.session_id, coalesce(s.agent, e.agent) as agent
            from job_execution e
            join job_execution_session s on s.org_id = e.org_id and s.job_id = e.job_id and s.claim_seq = e.claim_seq
        `,
        tx<{ org_id: string; agent: string; session_id: string; repo: string }[]>`
            select distinct org_id, agent, session_id, repo from session_branch where org_id <> '__unclaimed__'
        `,
    ]);
    const detail = await tx<
        {
            org_id: string;
            job_id: string;
            claim_seq: string;
            root_job_id: string;
            requesting_job_id: string | null;
            requesting_root_job_id: string | null;
            author_id: string | null;
            repo: string | null;
            launch: ExecutionEvidence['launch'];
            adopts_claim_seq: string | null;
            origin: ExecutionEvidence['origin'];
            created_at: Date | null;
            ended_at: Date | null;
            live: boolean;
            removed: boolean;
            operational: boolean;
        }[]
    >`
        select e.org_id, e.job_id, e.claim_seq, e.root_job_id, e.requesting_job_id, e.requesting_root_job_id,
               e.author_id, e.repo, e.launch, e.adopts_claim_seq, e.origin, e.created_at, e.ended_at,
               (e.ended_at is null and j.claim_seq = e.claim_seq and j.status = 'running') as live,
               (e.removed_at is not null or rj.id is null) as removed, (j.id is not null) as operational
        from job_execution e
        left join job j on j.org_id = e.org_id and j.id = e.job_id
        left join job rj on rj.org_id = e.org_id and rj.id = e.root_job_id
    `;
    const detailOf = new Map(detail.map((d) => [`${d.org_id}\u0000${d.job_id}\u0000${d.claim_seq}`, d]));
    const board = executions.map((x): ExecutionEvidence => {
        const d = detailOf.get(`${x.org_id}\u0000${x.job_id}\u0000${x.claim_seq}`) as (typeof detail)[number];
        return {
            orgId: x.org_id,
            jobId: x.job_id,
            claimSeq: Number(x.claim_seq),
            sessionId: x.session_id,
            agent: x.agent,
            rootJobId: d.root_job_id,
            requestingJobId: d.requesting_job_id,
            requestingRootJobId: d.requesting_root_job_id,
            authorId: d.author_id,
            repo: d.repo,
            launch: d.launch,
            adoptsClaimSeq: d.adopts_claim_seq === null ? null : Number(d.adopts_claim_seq),
            origin: d.origin,
            startedAt: d.created_at === null ? null : iso(d.created_at),
            endedAt: d.ended_at === null ? null : iso(d.ended_at),
            live: d.live,
            removed: d.removed,
            operational: d.operational,
        };
    });
    const branch: (BranchEvidence & { orgId: string })[] = branches.map((b) => ({
        orgId: b.org_id,
        agent: b.agent,
        sessionId: b.session_id,
        repo: b.repo,
    }));

    const observations: TokenObservation[] = stored.map((r) => ({
        agent: r.agent,
        sessionId: r.session_id,
        source: r.source,
        metric: r.metric,
        field: r.field.slice('tokens_'.length) as TokenObservation['field'],
        temporality: r.temporality,
        startTime: r.start_time === null ? null : iso(r.start_time),
        time: iso(r.time),
        value: Number(r.value),
        attrs: r.attrs,
    }));
    const contributions = reduceTokenObservations(observations).filter(
        (c) => c.kind === 'timed' || c.kind === 'unlocated'
    );
    return reconcile(board, branch, contributions, now);
}

function reconcile(
    board: readonly ExecutionEvidence[],
    branch: readonly BranchEvidence[],
    contributions: readonly TokenContribution[],
    now: Date
): GlobalReconciliation {
    const orgs = [...new Set([...board.map((e) => e.orgId), ...branch.map((b) => b.orgId)])].sort();
    const orgsOf = new Map<string, Set<string>>();
    for (const row of [...board, ...branch]) {
        orgsOf.set(row.sessionId, (orgsOf.get(row.sessionId) ?? new Set()).add(row.orgId));
    }
    const inputOf = (orgId: string): UsageInput => ({
        orgId,
        board: board.filter((e) => e.orgId === orgId),
        branch: branch.filter((b) => b.orgId === orgId),
        foreignSessionIds: new Set([...orgsOf].filter(([, o]) => [...o].some((x) => x !== orgId)).map(([id]) => id)),
        contributions,
        spans: [],
    });

    const perOrg = new Map<string, OrgReconciliation>();
    const inputs = new Map(orgs.map((o) => [o, inputOf(o)]));
    for (const [orgId, input] of inputs) {
        const { eligible, diagnostics } = reduceUsage(input, { range: null, now });
        perOrg.set(orgId, {
            assigned: eligible.assigned,
            unassigned: Object.fromEntries(eligible.unassigned.map((u) => [u.reason, u.tokens])),
            eligible: eligible.tokens,
            unlocated: eligible.unlocated,
            unresolved: addTokens(diagnostics.unresolvedOwnership.tokens, diagnostics.unresolvedOwnership.unlocated),
        });
    }

    const foreign: Tokens[] = [];
    const unowned: Tokens[] = [];
    for (const c of contributions) {
        const { agent, sessionId } = c.selection;
        if (sessionId === null) {
            unowned.push(c.tokens);
            continue;
        }
        const owned = [...inputs.values()].some((input) => {
            const owner = resolveOwnership(input, [{ agent, sessionId }]).values().next().value;
            return owner !== undefined && owner.status !== 'excluded';
        });
        if (owned) continue;
        ((orgsOf.get(sessionId)?.size ?? 0) > 1 ? foreign : unowned).push(c.tokens);
    }
    const parts = [...perOrg.values()].flatMap((o) => [o.eligible, o.unlocated, o.unresolved]);
    return {
        perOrg,
        foreign: sumOf(foreign),
        unowned: sumOf(unowned),
        total: sumOf([...parts, sumOf(foreign), sumOf(unowned)]),
    };
}
