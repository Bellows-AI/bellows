import type { Sql } from 'postgres';
import type { MetricRow } from './otlp.js';
import { UNCLAIMED_ORG } from './usage-facts.js';

export interface SessionBranchReport {
    agent: string;
    sessionId: string;
    repo: string;
    branch: string | null;
    headSha: string | null;
    at: string;
}

/**
 * The write side. Kept separate from the flattener so the wire-format parsing stays testable
 * without a database.
 */
/** Who writes a session's telemetry: the credential's org, and the attempt (job id) when the credential is one. */
export interface SessionClaimant {
    orgId: string;
    jobId: string | null;
}

export interface TelemetryStore {
    insertMetrics(rows: MetricRow[], orgId: string): Promise<number>;
    recordBranch(report: SessionBranchReport, orgId: string): Promise<void>;
    /**
     * The ids among `sessionIds` the claimant may not write. An attempt may write a session bound to it
     * (`job_execution_session`) or one bound to nothing yet (the run's own session before its first report);
     * never one bound to another attempt, nor one another organization's branch report names. A personal
     * credential may write any session no other organization holds. A failed lookup throws: unconfirmed is
     * never "allowed", and never "refused" either.
     */
    foreignSessions(claimant: SessionClaimant, sessionIds: readonly string[]): Promise<Set<string>>;
}

/**
 * WHERE THE ORG COMES FROM — the credential verified at the ingest boundary, never the report's
 * repo or a point's attributes. A report's `repo` is caller-controlled payload, and matching its
 * owner against the installation orgs let any caller write telemetry into another organization by
 * naming its repository (CWE-862). The routes record with `orgOf(request)`: the attempt's org for
 * the runner's credential, the membership's org for the laptop plugin's personal bearer; each
 * `metric_point` row stores it, and `foreignSessions` keeps a credential off a session it does not hold.
 */
export function createPostgresStore({ sql }: { sql: Sql }): TelemetryStore {
    return {
        async insertMetrics(rows, orgId) {
            if (!rows.length) return 0;

            const payload = rows.map((row) => ({
                org_id: orgId,
                agent: row.agent,
                metric: row.metric,
                field: row.field,
                session_id: row.sessionId,
                value: row.value,
                temporality: row.temporality,
                start_time: row.startTime ? new Date(row.startTime) : null,
                time: new Date(row.time),
                attrs: row.attrs,
            }));

            // DO NOTHING, never DO UPDATE. OTLP delivery is at-least-once, so an identical
            // retry must be a no-op; an update would move received_at and destroy the only
            // way to tell a retry from a genuine second export.
            const inserted = await sql`
                insert into metric_point ${sql(payload)}
                on conflict do nothing
            `;
            return inserted.count;
        },

        async foreignSessions({ orgId, jobId }, sessionIds) {
            const ids = [...new Set(sessionIds)];
            if (!ids.length) return new Set();
            // Bound to this attempt wins; otherwise any binding to another attempt (another org's included) or another
            // organization's branch report refuses. A personal claimant has no attempt, so only another org binds.
            const rows = await sql<{ session_id: string }[]>`
                select a.session_id
                from unnest(${sql.array(ids)}::text[]) as a(session_id)
                cross join lateral (
                    select
                        exists (
                            select 1 from job_execution_session s
                            where s.session_id = a.session_id and s.org_id = ${orgId} and s.job_id = ${jobId}::uuid
                        ) as mine,
                        exists (
                            select 1 from job_execution_session s
                            where s.session_id = a.session_id
                              and (s.org_id <> ${orgId} or (${jobId}::uuid is not null and s.job_id <> ${jobId}::uuid))
                        ) as bound_elsewhere,
                        exists (
                            select 1 from session_branch b
                            where b.session_id = a.session_id and b.org_id not in (${orgId}, ${UNCLAIMED_ORG})
                        ) as branched_elsewhere
                ) f
                where not f.mine and (f.bound_elsewhere or f.branched_elsewhere)
            `;
            return new Set(rows.map((row) => row.session_id));
        },

        async recordBranch(report, orgId) {
            const { agent, sessionId, repo, branch, headSha, at } = report;
            const when = new Date(at);
            // Widen the interval rather than overwrite it: each report is one sample of a
            // branch that was held for some span, and the span is what the attribution join
            // intersects against.
            await sql`
                insert into session_branch (org_id, agent, session_id, repo, branch, head_sha, first_seen, last_seen, samples)
                values (${orgId}, ${agent}, ${sessionId}, ${repo}, ${branch}, ${headSha}, ${when}, ${when}, 1)
                on conflict (org_id, agent, session_id, repo, branch) do update
                    set first_seen = least(session_branch.first_seen, excluded.first_seen),
                        last_seen  = greatest(session_branch.last_seen, excluded.last_seen),
                        head_sha   = coalesce(excluded.head_sha, session_branch.head_sha),
                        samples    = session_branch.samples + 1
            `;
        },
    };
}
