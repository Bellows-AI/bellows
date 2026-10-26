/**
 * Transcript tool events (issue #983; `089_transcript_tool_event.sql`): the gate runs and PR
 * operations an executor's transcript shows, classified and filed under the run that owns the
 * session the record names. Idempotent on (executor, session, call id, half): a chunk put twice, an
 * export taken again or a resumed session replaying its history inserts nothing.
 */

import type { TransactionSql } from 'postgres';
import { classifyTranscript, type ToolActivity, type TranscriptChunk } from '../../telemetry/transcript-tools.js';
import type { JobStoreContext } from './job-store-types.js';

/** What the artifact routes hand over: the stream's coordinates and the chunks to read. */
export interface TranscriptIngest {
    executor: string;
    stream: string;
    /** The claim of the stream being read: provenance, and the run when it owns the session. */
    claimSeq: number;
    chunks: readonly TranscriptChunk[];
}

/** The store half the artifact routes call; `JobStore` extends it. */
export interface TranscriptToolStore {
    /**
     * Files the classified calls and results of `chunks`. A session the job has no execution for is
     * dropped. Stores only classified fields. `missing` when the org holds no such job.
     */
    ingestTranscriptTools(
        id: string,
        input: TranscriptIngest
    ): Promise<{ result: 'ok'; written: number } | { result: 'missing' }>;
}

/**
 * The run of each session: the claim whose runner REPORTED it, so a retained pointer a later claim
 * merely inherited (`inferred_at_claim`) never takes a session's earlier history. The ingesting
 * claim when it reported the session; else the earliest claim that did; else, with no report, the
 * earliest claim holding it. A session no claim holds has no run and is dropped.
 */
function runsOfSessions(
    owned: readonly { session_id: string; claim_seq: string; origin: string }[],
    claimSeq: number
): Map<string, number> {
    const bySession = new Map<string, { claim: number; reported: boolean }[]>();
    for (const o of owned) {
        const held = bySession.get(o.session_id) ?? [];
        held.push({ claim: Number(o.claim_seq), reported: o.origin !== 'inferred_at_claim' });
        bySession.set(o.session_id, held);
    }
    const runs = new Map<string, number>();
    for (const [session, held] of bySession) {
        const reported = held.filter((h) => h.reported);
        const claims = (reported.length > 0 ? reported : held).map((h) => h.claim);
        runs.set(session, claims.includes(claimSeq) ? claimSeq : Math.min(...claims));
    }
    return runs;
}

export async function ingestTranscriptTools(
    ctx: JobStoreContext,
    id: string,
    input: TranscriptIngest
): ReturnType<TranscriptToolStore['ingestTranscriptTools']> {
    const { sql, orgId } = ctx;
    const { executor, stream, claimSeq, chunks } = input;
    return sql.begin(async (tx) => {
        const [job] = await tx<{ repo: string | null }[]>`select repo from job where org_id = ${orgId} and id = ${id}`;
        if (!job) return { result: 'missing' } as const;
        const activities = classifyTranscript({ executor, chunks, repo: job.repo }).filter(
            (a) => a.operation !== 'lookup'
        );
        const sessions = [...new Set(activities.map((a) => a.session))];
        if (sessions.length === 0) return { result: 'ok', written: 0 } as const;
        const owned = await tx<{ session_id: string; claim_seq: string; origin: string }[]>`
            select session_id, claim_seq::text, origin
            from job_execution_session
            where org_id = ${orgId} and job_id = ${id} and session_id in ${tx(sessions)}
            order by claim_seq
        `;
        const runOf = runsOfSessions(owned, claimSeq);
        let written = 0;
        for (const activity of activities) {
            const run = runOf.get(activity.session);
            if (run === undefined) continue;
            const at = { orgId, id, executor, stream, claimSeq, run };
            written += await insertHalf(tx, at, activity, 'call');
            if (activity.result) written += await insertHalf(tx, at, activity, 'result');
        }
        return { result: 'ok', written } as const;
    });
}

async function insertHalf(
    tx: TransactionSql,
    at: { orgId: string; id: string; executor: string; stream: string; claimSeq: number; run: number },
    activity: ToolActivity,
    part: 'call' | 'result'
): Promise<number> {
    const r = part === 'result' ? activity.result : null;
    const inserted = await tx`
        insert into transcript_tool_event (
            org_id, job_id, executor, session_id, tool_call_id, part, run_claim_seq, kind, operation, gate,
            filtered, outcome, exit_code, execution_id, operation_id, pr_repo, pr_number, pr_url,
            stream, claim_seq, byte_offset
        ) values (
            ${at.orgId}, ${at.id}, ${at.executor}, ${activity.session}, ${activity.toolCallId}, ${part}, ${at.run},
            ${activity.kind}, ${activity.operation}, ${activity.gate}, ${activity.filtered}, ${r?.outcome ?? null},
            ${r?.exitCode ?? null}, ${r?.executionId ?? null}, ${r?.operationId ?? null}, ${r?.repo ?? null},
            ${r?.prNumber ?? null}, ${r?.prUrl ?? null}, ${at.stream}, ${at.claimSeq},
            ${(r ?? activity).offset}
        )
        on conflict do nothing
        returning 1
    `;
    return inserted.length;
}
