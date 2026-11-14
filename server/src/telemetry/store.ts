import type { Sql } from 'postgres';
import { type InsertedPoint, recordTokenUsage } from '../db/plan-allowances.js';
import { orgSql } from '../db/org-sql.js';
import type { MetricRow } from './otlp.js';

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
     * credential may write any session no other organization holds. A session the claimant may write is
     * reserved to its org (`telemetry_session_owner`) if no org owns it yet, and refused if another org does:
     * one owner per session, on both routes. A failed lookup throws: unconfirmed is never "allowed", and
     * never "refused" either.
     */
    claimSessions(claimant: SessionClaimant, sessionIds: readonly string[]): Promise<Set<string>>;
}

/**
 * WHERE THE ORG COMES FROM — the credential verified at the ingest boundary, never the report's
 * repo or a point's attributes. A report's `repo` is caller-controlled payload, and matching its
 * owner against the installation orgs let any caller write telemetry into another organization by
 * naming its repository (CWE-862). The routes record with `orgOf(request)`: the attempt's org for
 * the runner's credential, the membership's org for the laptop plugin's personal bearer; each
 * `metric_point` row stores it, and `claimSessions` keeps a credential off a session it does not hold.
 */
export function createPostgresStore({ sql: pool }: { sql: Sql }): TelemetryStore {
    return {
        async insertMetrics(rows, orgId) {
            const sql = orgSql(pool, orgId);
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
            // way to tell a retry from a genuine second export. The token allowance's rollup
            // adds only the rows this insert returned, in its transaction, so a retry adds nothing.
            return sql.begin(async (tx) => {
                const inserted = await tx<InsertedPoint[]>`
                    insert into metric_point ${tx(payload)}
                    on conflict do nothing
                    returning org_id, field, temporality, value
                `;
                await recordTokenUsage(tx, inserted);
                return inserted.length;
            });
        },

        async claimSessions({ orgId, jobId }, sessionIds) {
            const ids = [...new Set(sessionIds)];
            if (!ids.length) return new Set();
            const sql = orgSql(pool, orgId);
            // Bound to this attempt wins; otherwise any binding to another attempt (another org's included), another
            // organization's branch report or another organization's ownership refuses. A personal claimant has no
            // attempt, so only another org binds. The other orgs' rows are past this org's policy: a definer function
            // answers one boolean per id (151_row_level_security.sql).
            const refusedOf = async (asked: string[]): Promise<string[]> => {
                const [row] = await sql<{ refused: boolean[] }[]>`
                    select bellows_sessions_refused(${jobId}::uuid, ${sql.array(asked)}::text[]) as refused
                `;
                return asked.filter((_, i) => row!.refused[i] === true);
            };
            const refused = new Set(await refusedOf(ids));
            // The rest are this org's to write only if it owns them: the first org to write a session reserves it,
            // and the primary key makes that one org even when two write at once (the loser's insert waits on the
            // winner's row, then does nothing, and the check below sees the winner). Sorted, so two claims lock in
            // one order.
            const candidates = ids.filter((id) => !refused.has(id)).sort();
            if (!candidates.length) return refused;
            await sql`
                insert into telemetry_session_owner (session_id, org_id)
                select session_id, ${orgId} from unnest(${sql.array(candidates)}::text[]) as c(session_id)
                order by session_id
                on conflict (session_id) do nothing
            `;
            for (const id of await refusedOf(candidates)) refused.add(id);
            return refused;
        },

        async recordBranch(report, orgId) {
            const sql = orgSql(pool, orgId);
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
