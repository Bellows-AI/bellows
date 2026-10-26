/**
 * The records the activity read reduces (issue #983 S4): every gate execution, reused completion
 * check, managed PR operation and classified transcript call of a set of jobs, read in one pass.
 * The counting, the dedupe by execution id and the coverage are `telemetry/run-activity.ts`'s; this
 * file only reads.
 */

import type { ActivityRecords, ToolEventRecord } from '../../telemetry/run-activity.js';
import type { GateReport, JobStoreContext } from './job-store-types.js';

type GateOutcome = ActivityRecords['gateRuns'][number]['outcome'];

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

interface EventRow {
    job_id: string;
    executor: string;
    session_id: string;
    tool_call_id: string;
    part: 'call' | 'result';
    kind: 'gate' | 'pr';
    operation: 'run' | 'create' | 'publish';
    outcome: 'passed' | 'failed' | 'unknown' | null;
    execution_id: string | null;
    operation_id: string | null;
    pr_repo: string | null;
    pr_number: number | null;
    pr_url: string | null;
    started_at: Date | null;
    ended_at: Date | null;
}

/** One record per call: the result half carries the outcome and ids, either half may carry the times. */
function mergeCalls(rows: EventRow[]): ToolEventRecord[] {
    const calls = new Map<string, { call?: EventRow; result?: EventRow }>();
    for (const r of rows) {
        const key = `${r.job_id}\0${r.executor}\0${r.session_id}\0${r.tool_call_id}`;
        const held = calls.get(key) ?? {};
        held[r.part] = r;
        calls.set(key, held);
    }
    const out: ToolEventRecord[] = [];
    for (const [callId, { call, result }] of calls) {
        // A call with no result yet has no outcome to count; it is not an observation of anything finished.
        if (!result) continue;
        out.push({
            jobId: result.job_id,
            callId,
            kind: result.kind,
            operation: result.operation,
            outcome: result.outcome ?? 'unknown',
            executionId: result.execution_id,
            operationId: result.operation_id,
            prRepo: result.pr_repo,
            prNumber: result.pr_number,
            prUrl: result.pr_url,
            startedAt: iso(call?.started_at ?? result.started_at),
            endedAt: iso(result.ended_at ?? call?.ended_at ?? null),
        });
    }
    return out;
}

export async function activityRecordsOf(ctx: JobStoreContext, jobIds: readonly string[]): Promise<ActivityRecords> {
    const { sql, orgId } = ctx;
    if (jobIds.length === 0) return { gateRuns: [], reusedGates: [], prOperations: [], toolEvents: [] };
    const ids = [...jobIds];
    const [gateRows, gateLists, opRows, eventRows] = await Promise.all([
        sql<
            {
                job_id: string;
                execution_id: string;
                gate: string;
                source: 'adhoc' | 'completion';
                filtered: boolean;
                outcome: GateOutcome;
                started_at: Date | null;
                finished_at: Date | null;
            }[]
        >`
            select job_id, execution_id, gate, source, filtered, outcome, started_at, finished_at
            from job_gate_run where org_id = ${orgId} and job_id in ${sql(ids)} order by seq
        `,
        sql<{ id: string; gates: GateReport[] | null }[]>`
            select id, gates from job where org_id = ${orgId} and id in ${sql(ids)} and gates is not null
        `,
        sql<
            {
                job_id: string;
                operation_id: string;
                operation: 'created' | 'reused';
                repo: string;
                pr_number: number;
                pr_url: string;
            }[]
        >`
            select job_id, operation_id, operation, repo, pr_number, pr_url
            from job_pr_operation where org_id = ${orgId} and job_id in ${sql(ids)} order by created_at, operation_id
        `,
        sql<EventRow[]>`
            select job_id, executor, session_id, tool_call_id, part, kind, operation, outcome, execution_id,
                   operation_id, pr_repo, pr_number, pr_url, started_at, ended_at
            from transcript_tool_event where org_id = ${orgId} and job_id in ${sql(ids)}
            order by byte_offset, tool_call_id
        `,
    ]);
    return {
        gateRuns: gateRows.map((r) => ({
            jobId: r.job_id,
            executionId: r.execution_id,
            gate: r.gate,
            source: r.source,
            filtered: r.filtered,
            outcome: r.outcome,
            startedAt: iso(r.started_at),
            finishedAt: iso(r.finished_at),
        })),
        reusedGates: gateLists.flatMap((row) =>
            (row.gates ?? []).flatMap((g) =>
                g.reused
                    ? [
                          {
                              jobId: row.id,
                              gate: g.name,
                              executionId: g.reused.executionId,
                              finishedAt: g.reused.finishedAt,
                              reason: g.reused.reason,
                          },
                      ]
                    : []
            )
        ),
        prOperations: opRows.map((r) => ({
            jobId: r.job_id,
            operationId: r.operation_id,
            operation: r.operation,
            repo: r.repo,
            prNumber: r.pr_number,
            prUrl: r.pr_url,
        })),
        toolEvents: mergeCalls(eventRows),
    };
}
