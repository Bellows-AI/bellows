import type { Sql } from 'postgres';
import { rollupsFromFacts, type JobRun } from '@factory-ai/core';
import type { TaskFacts, TelemetryClient, TelemetryFetch, TelemetryHealth } from './client.js';
import { TelemetryError } from './errors.js';
import { readUsageFacts } from './usage-facts.js';

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

export function createPostgresTelemetryClient({ sql, orgId, ready, log }: PostgresTelemetryDeps): TelemetryClient {
    return {
        async fetchTaskFacts({ jobId, rootJobId, edits }): Promise<TaskFacts> {
            try {
                if (ready) await ready;
                // One snapshot for the task lookup and the facts: a claim committing between the two
                // reads would otherwise name a task whose runs the facts no longer hold.
                return await sql.begin('isolation level repeatable read, read only', async (tx) => {
                    const [row] = await tx<{ task_id: string }[]>`
                        select coalesce(requesting_root_job_id, root_job_id)::text as task_id
                        from job_execution where org_id = ${orgId} and job_id = ${jobId}
                        order by claim_seq desc limit 1
                    `;
                    const taskId = row?.task_id ?? rootJobId;
                    return {
                        taskId,
                        facts: await readUsageFacts(tx, orgId, { taskIds: [taskId], edits: edits === true }),
                    };
                });
            } catch (e) {
                if (e instanceof TelemetryError) throw e;
                throw new TelemetryError((e as Error).message, 'QUERY');
            }
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
