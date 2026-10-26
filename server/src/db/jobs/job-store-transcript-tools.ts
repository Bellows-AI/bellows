/**
 * Transcript tool events (issue #983; `089_transcript_tool_event.sql`): the gate runs and PR
 * operations an executor's transcript shows, classified and filed under the run that owns the
 * session the record names. Idempotent on (executor, session, call id, half): a chunk put twice, an
 * export taken again or a resumed session replaying its history inserts nothing.
 */

import type { TransactionSql } from 'postgres';
import {
    readTranscript,
    type PendingResult,
    resolveResult,
    type ToolCall,
    type ToolResult,
    type TranscriptChunk,
} from '../../telemetry/transcript-tools.js';
import type { JobStoreContext } from './job-store-types.js';

/** What the artifact routes hand over: the stream's coordinates and the chunks to read. */
export interface TranscriptIngest {
    executor: string;
    stream: string;
    /** The artifact's own session coordinate: provenance, and distinct from the session a record names. */
    session: string;
    /** The claim of the stream being read: provenance, and the run only as a last resort. */
    claimSeq: number;
    chunks: readonly TranscriptChunk[];
}

/** The store half the artifact routes call; `JobStore` extends it. */
export interface TranscriptToolStore {
    /**
     * Files the classified calls and results of `chunks`. A result is filed against its call, which
     * may have been stored by an earlier chunk, and waits for it when the call has not landed. A
     * session the job has no execution for is dropped. Stores only classified fields. `missing`
     * when the org holds no such job.
     */
    ingestTranscriptTools(
        id: string,
        input: TranscriptIngest
    ): Promise<{ result: 'ok'; written: number } | { result: 'missing' }>;
}

interface Holder {
    claim: number;
    reported: boolean;
    from: number;
    until: number;
}

/**
 * The run of a call: fixed once, when its call half is first stored, and never moved by who delivers
 * a later copy. Among the claims holding the session, the one whose window holds the call's own time
 * (the latest, should windows overlap); with no time, or none holding it, the claim whose runner
 * REPORTED the session (a retained pointer a later claim merely inherited, `inferred_at_claim`, never
 * takes earlier history): the ingesting claim when it reported it, else the earliest reporter, else
 * the earliest holder. A session no claim holds has no run and is dropped.
 */
function runOf(held: readonly Holder[], claimSeq: number, startedAt: string | null): number | undefined {
    if (held.length === 0) return undefined;
    const at = startedAt === null ? Number.NaN : Date.parse(startedAt);
    const inWindow = held.filter((h) => h.from <= at && at < h.until).map((h) => h.claim);
    if (inWindow.length > 0) return Math.max(...inWindow);
    const reported = held.filter((h) => h.reported);
    const claims = (reported.length > 0 ? reported : held).map((h) => h.claim);
    return claims.includes(claimSeq) ? claimSeq : Math.min(...claims);
}

interface StoredCall {
    session_id: string;
    tool_call_id: string;
    kind: ToolCall['kind'];
    operation: ToolCall['operation'];
    gate: string | null;
    filtered: boolean | null;
    compound: boolean;
    run_claim_seq: string;
}

/** A call as later halves read it: what its result is classified against, and the run it holds. */
type Known = Pick<StoredCall, 'kind' | 'operation' | 'gate' | 'filtered' | 'compound'> & { run: number };

const keyOf = (session: string, id: string) => `${session}\0${id}`;

type Tx = TransactionSql;

/** The calls of the job already filed for these ids, by key. */
async function storedCalls(
    tx: Tx,
    at: { orgId: string; id: string; executor: string },
    sessions: string[],
    ids: string[]
): Promise<Map<string, Known>> {
    const rows = await tx<StoredCall[]>`
        select session_id, tool_call_id, kind, operation, gate, filtered, compound, run_claim_seq::text
        from transcript_tool_event
        where org_id = ${at.orgId} and job_id = ${at.id} and executor = ${at.executor} and part = 'call'
          and session_id in ${tx(sessions)} and tool_call_id in ${tx(ids)}
    `;
    return new Map(rows.map((s) => [keyOf(s.session_id, s.tool_call_id), { ...s, run: Number(s.run_claim_seq) }]));
}

/** The claims holding each session, with the window each ran in. */
async function holdersOf(
    tx: Tx,
    at: { orgId: string; id: string },
    sessions: string[]
): Promise<Map<string, Holder[]>> {
    const owned = await tx<
        { session_id: string; claim_seq: string; origin: string; created_at: Date; ended_at: Date | null }[]
    >`
        select s.session_id, s.claim_seq::text, s.origin, e.created_at, e.ended_at
        from job_execution_session s
        join job_execution e on e.org_id = s.org_id and e.job_id = s.job_id and e.claim_seq = s.claim_seq
        where s.org_id = ${at.orgId} and s.job_id = ${at.id} and s.session_id in ${tx(sessions)}
        order by s.claim_seq
    `;
    const holders = new Map<string, Holder[]>();
    for (const o of owned) {
        const held = holders.get(o.session_id) ?? [];
        held.push({
            claim: Number(o.claim_seq),
            reported: o.origin !== 'inferred_at_claim',
            from: o.created_at.getTime(),
            until: o.ended_at?.getTime() ?? Number.POSITIVE_INFINITY,
        });
        holders.set(o.session_id, held);
    }
    return holders;
}

export async function ingestTranscriptTools(
    ctx: JobStoreContext,
    id: string,
    input: TranscriptIngest
): ReturnType<TranscriptToolStore['ingestTranscriptTools']> {
    return ctx.sql.begin(async (tx) => {
        const [job] = await tx<{ repo: string | null }[]>`
            select repo from job where org_id = ${ctx.orgId} and id = ${id}
        `;
        if (!job) return { result: 'missing' } as const;
        return { result: 'ok', written: await fileTools(tx, { orgId: ctx.orgId, id, repo: job.repo }, input) } as const;
    });
}

/** Files the calls of the chunks that are new, and the results of every call the job holds. */
async function fileTools(
    tx: Tx,
    job: { orgId: string; id: string; repo: string | null },
    input: TranscriptIngest
): Promise<number> {
    const { executor, claimSeq } = input;
    const { calls, results } = readTranscript({ executor, chunks: input.chunks });
    const batch = calls.filter((c) => c.operation !== 'lookup');
    const sessions = [...new Set([...batch, ...results].map((r) => r.session))];
    if (sessions.length === 0) return 0;
    const ids = [...new Set([...batch.map((c) => c.toolCallId), ...results.map((r) => r.toolCallId)])];
    const whose = { orgId: job.orgId, id: job.id, executor };
    // Every call known by its key: the one stored first keeps its run; a new one gets its run now.
    const known = await storedCalls(tx, whose, sessions, ids);
    const holders = await holdersOf(tx, whose, sessions);
    const at = { ...whose, stream: input.stream, artifactSession: input.session, claimSeq };
    let written = 0;
    for (const call of batch) {
        const k = keyOf(call.session, call.toolCallId);
        const run = known.has(k) ? undefined : runOf(holders.get(call.session) ?? [], claimSeq, call.startedAt);
        if (run === undefined) continue;
        known.set(k, { ...call, compound: !call.lone, run });
        written += await insertCall(tx, { ...at, run }, call);
    }
    for (const result of results) {
        const call = known.get(keyOf(result.session, result.toolCallId));
        if (call) written += await insertResult(tx, at, call, resolved(call, result, job.repo));
    }
    return written;
}

const resolved = (call: Known, result: PendingResult, repo: string | null) => ({
    ...result,
    ...resolveResult({ operation: call.operation, lone: !call.compound }, result, repo),
});

type At = {
    orgId: string;
    id: string;
    executor: string;
    stream: string;
    artifactSession: string;
    claimSeq: number;
    run: number;
};

async function insertCall(tx: TransactionSql, at: At, call: ToolCall): Promise<number> {
    const inserted = await tx`
        insert into transcript_tool_event (
            org_id, job_id, executor, session_id, tool_call_id, part, run_claim_seq, kind, operation, gate,
            filtered, compound, started_at, artifact_session, stream, claim_seq, byte_offset
        ) values (
            ${at.orgId}, ${at.id}, ${at.executor}, ${call.session}, ${call.toolCallId}, 'call', ${at.run},
            ${call.kind}, ${call.operation}, ${call.gate}, ${call.filtered}, ${!call.lone}, ${call.startedAt},
            ${at.artifactSession}, ${at.stream}, ${at.claimSeq}, ${call.offset}
        )
        on conflict do nothing
        returning 1
    `;
    return inserted.length;
}

async function insertResult(
    tx: TransactionSql,
    at: Omit<At, 'run'>,
    call: Known,
    r: ToolResult & { session: string; toolCallId: string }
): Promise<number> {
    const inserted = await tx`
        insert into transcript_tool_event (
            org_id, job_id, executor, session_id, tool_call_id, part, run_claim_seq, kind, operation, gate,
            filtered, compound, outcome, exit_code, execution_id, operation_id, pr_repo, pr_number, pr_url,
            started_at, ended_at, artifact_session, stream, claim_seq, byte_offset
        ) values (
            ${at.orgId}, ${at.id}, ${at.executor}, ${r.session}, ${r.toolCallId}, 'result', ${call.run},
            ${call.kind}, ${call.operation}, ${call.gate}, ${call.filtered}, ${call.compound}, ${r.outcome},
            ${r.exitCode}, ${r.executionId}, ${r.operationId}, ${r.repo}, ${r.prNumber}, ${r.prUrl},
            ${r.startedAt}, ${r.endedAt}, ${at.artifactSession}, ${at.stream}, ${at.claimSeq}, ${r.offset}
        )
        on conflict do nothing
        returning 1
    `;
    return inserted.length;
}
