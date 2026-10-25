import type { Sql } from 'postgres';
import type { JobRun } from '@factory-ai/core';
import type { TelemetryClient, TelemetryFetch, TelemetryHealth } from './client.js';
import { TelemetryError } from './errors.js';
import { bucketizeActivity, type ActivityBucket } from './run-activity.js';
import { readUsageFacts } from './usage-facts.js';
import { rollupsFromFacts } from './usage-rollups.js';

interface RunRow {
    root_job_id: string;
    repo: string | null;
    created_by: string | null;
    created_at: Date;
    agent_turns: number | null;
    /** bigint reads back as a string; converted where the rows map to JobRun. */
    wall_clock_ms: string | null;
}

export interface PostgresTelemetryDeps {
    sql: Sql;
    /** The organization whose sessions this client reports. Bound once; see the stores. */
    orgId: string;
    /**
     * Resolves when migrations have been applied. Awaited per query rather than at
     * construction so the process can start serving before the database is up — the HTTP
     * surface needs no database, and must not wait for one.
     */
    ready?: Promise<unknown>;
    /** Receives the size of each usage-facts read (rows per query, contributions per kind). */
    log?: (message: string) => void;
}

interface ActivityRow {
    agent: string;
    metric: string;
    field: string;
    temporality: string;
    start_time: Date | null;
    attrs: unknown;
    value: number;
    time: Date;
}

export function createPostgresTelemetryClient({ sql, orgId, ready, log }: PostgresTelemetryDeps): TelemetryClient {
    return {
        async runActivity({ sessionId, from, to, bucketMs }): Promise<ActivityBucket[]> {
            if (ready) await ready;
            // Keyed by session id alone — metric_point has no org column by design, and the
            // session arrived here through the caller's own org's job row, the same trust path
            // every other metric_point read leans on. `metric_point_used`, never `metric_point`:
            // the double-count rule (002_views.repeatable.sql). The window and the field filter
            // bound the scan; the session index serves the rest. Cumulative points from before
            // the window ride along: a follow-up run shares its session's counters, and the
            // total reached before `from` is the baseline its own increments difference from.
            const rows = await sql<ActivityRow[]>`
                select agent, metric, field, temporality, start_time, attrs, value, time
                from metric_point_used
                where session_id = ${sessionId}
                  and field in ('tokens_input', 'tokens_output', 'tokens_cacheRead', 'tokens_cacheCreation',
                                'edits_accept', 'edits_reject')
                  and time <= ${to}
                  and (time >= ${from} or temporality = 'cumulative')
            `;
            // Nothing measured is not a quiet run: [] is what the UI renders its muted
            // "no telemetry for this run" state from, never a fabricated zero line.
            // Pre-window cumulative points only set a baseline: with none of the run's own, the
            // run measured nothing, and its zero buckets would read as a measured zero.
            const fromMs = Date.parse(from);
            if (!rows.some((row) => new Date(row.time).getTime() >= fromMs)) return [];
            return bucketizeActivity(
                rows.map((row) => ({
                    field: row.field,
                    temporality: row.temporality,
                    startTime: row.start_time === null ? null : new Date(row.start_time).toISOString(),
                    attrs: (row.attrs ?? {}) as Record<string, string>,
                    metric: row.metric,
                    agent: row.agent,
                    value: Number(row.value),
                    time: new Date(row.time).toISOString(),
                })),
                { from, to, bucketMs }
            );
        },

        async fetchRollups(): Promise<TelemetryFetch> {
            try {
                if (ready) await ready;
                // ONE repeatable-read snapshot for the board's provenance, the telemetry points and
                // the run rows: a thread removal or a new claim committing between independent reads
                // would leave a session owned by a task whose runs no longer exist. Read-only:
                // nothing here writes, and the mode is the database's to enforce.
                //
                // Not filtered by repo here: telemetryStats() applies the filter, and the counts of
                // other-repo and hook-less sessions are what diagnose a bad setup. Ownership is
                // decided by readUsageFacts from board and branch evidence of THIS organization; a
                // session nobody owns, or two organizations claim, is in no tenant's read.
                return sql.begin('isolation level repeatable read, read only', async (tx): Promise<TelemetryFetch> => {
                    const facts = await readUsageFacts(tx, orgId);
                    log?.(
                        `usage facts org=${orgId} rows=${JSON.stringify(facts.stats.rows)} ` +
                            `contributions=${JSON.stringify(facts.stats.contributions)} ms=${facts.stats.ms}`
                    );
                    // The org's own run rows, cached beside the rollups for the per-task statistics.
                    const runRows = await tx<RunRow[]>`
                        select root_job_id, repo, created_by, created_at, agent_turns, wall_clock_ms
                        from job
                        where org_id = ${orgId}
                    `;
                    const runs: JobRun[] = runRows.map((r) => ({
                        rootJobId: r.root_job_id,
                        repo: r.repo,
                        createdBy: r.created_by,
                        createdAt: r.created_at.toISOString(),
                        agentTurns: r.agent_turns,
                        wallClockMs: r.wall_clock_ms == null ? null : Number(r.wall_clock_ms),
                    }));
                    return { input: rollupsFromFacts(facts), runs, facts };
                });
            } catch (e) {
                // A migration failure keeps its own code: "the schema is not there" and "the
                // query is wrong" want different fixes.
                if (e instanceof TelemetryError) throw e;
                throw new TelemetryError((e as Error).message, 'QUERY');
            }
        },

        async health(): Promise<TelemetryHealth> {
            try {
                if (ready) await ready;
                // Deliberately NOT org-scoped. This answers "is the ingest pipeline alive", which
                // is a property of the deployment, not of an organization — and metric_point has
                // no org column anyway, so scoping it would mean joining through session_branch
                // and thereby reporting `empty` for a pipeline that is receiving data from a
                // session the hook never reported. That is the exact state `empty` exists to
                // distinguish itself from.
                const [row] = await sql<{ n: number }[]>`select count(*)::int as n from metric_point`;
                if ((row?.n ?? 0) === 0) {
                    return { status: 'empty', reason: 'No telemetry datapoints have arrived yet' };
                }
                return { status: 'ok', reason: null };
            } catch (e) {
                return { status: 'unreachable', reason: (e as Error).message };
            }
        },
    };
}
