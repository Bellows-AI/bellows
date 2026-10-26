/**
 * Gate runs (issue #983; `087_job_gate_run.sql`): one row per gate execution of an attempt, written
 * under its lease — `running` before the gate starts, the terminal outcome after — and read back by the
 * driver's completion pass, which reuses a verified pass instead of running the gate again.
 */

import { exists } from './job-store-rows.js';
import type { JobStoreContext } from './job-store-types.js';

export const GATE_RUN_SOURCES = ['adhoc', 'completion'] as const;
export type GateRunSource = (typeof GATE_RUN_SOURCES)[number];
export const GATE_RUN_OUTCOMES = ['running', 'passed', 'failed', 'setup_failed', 'not_started', 'incomplete'] as const;
export type GateRunOutcome = (typeof GATE_RUN_OUTCOMES)[number];

/** The most gates one run answers: far above any declared list, so a truncated answer only costs a re-run. */
const READ_LIMIT = 200;

/** One execution as the driver records it. */
export interface GateRunWrite {
    runClaimSeq: number;
    executionId: string;
    gate: string;
    identity: string;
    filtered: boolean;
    source: GateRunSource;
    outcome: GateRunOutcome;
    exitCode: number | null;
    treeBefore: string | null;
    treeAfter: string | null;
    mutatedSince: boolean | null;
    startedAt: string | null;
    finishedAt: string | null;
}

/** A stored row: what was written, and the claim of the driver that wrote it. */
export interface GateRunRow extends GateRunWrite {
    claimSeq: number;
}

/** The store half the board's gate-run routes call; `JobStore` extends it. */
export interface GateRunStore {
    /**
     * Records one execution under the attempt's lease. Idempotent on `executionId`: a row only moves
     * `running` -> terminal, the first terminal row wins, and a replay changes nothing. `conflict` is a
     * run claim sequence the job never reached.
     */
    writeGateRun(
        id: string,
        leaseToken: string,
        run: GateRunWrite
    ): Promise<{ result: 'ok' | 'lost' | 'missing' | 'conflict' }>;
    /**
     * The latest row per gate of the run `runClaimSeq` started, of any scope, oldest first, under the
     * attempt's lease.
     */
    readGateRuns(
        id: string,
        leaseToken: string,
        runClaimSeq: number
    ): Promise<{ result: 'lost' | 'missing' } | { result: 'ok'; runs: GateRunRow[] }>;
}

interface StoredRow {
    run_claim_seq: string;
    claim_seq: string;
    execution_id: string;
    gate: string;
    identity: string;
    filtered: boolean;
    source: GateRunSource;
    outcome: GateRunOutcome;
    exit_code: number | null;
    tree_before: string | null;
    tree_after: string | null;
    mutated_since: boolean | null;
    started_at: Date | null;
    finished_at: Date | null;
}

export async function writeGateRun(
    ctx: JobStoreContext,
    attempt: { id: string; leaseToken: string },
    run: GateRunWrite
): ReturnType<GateRunStore['writeGateRun']> {
    const { sql, orgId } = ctx;
    const { id, leaseToken } = attempt;
    return sql.begin(async (tx) => {
        const [row] = await tx<{ claim_seq: string }[]>`
            select claim_seq from job
            where org_id = ${orgId} and id = ${id} and status = 'running' and lease_token = ${leaseToken}
            for update
        `;
        if (!row) return { result: (await exists(tx, orgId, id)) ? 'lost' : 'missing' };
        if (run.runClaimSeq < 1 || run.runClaimSeq > Number(row.claim_seq)) return { result: 'conflict' };
        // Only `running` moves, and only to a terminal outcome of the same execution: a replay or a late
        // `running` write never reverts or overwrites a row that already ended.
        await tx`
            insert into job_gate_run (
                org_id, job_id, execution_id, run_claim_seq, claim_seq, gate, identity, filtered, source,
                outcome, exit_code, tree_before, tree_after, mutated_since, started_at, finished_at
            )
            values (
                ${orgId}, ${id}, ${run.executionId}, ${run.runClaimSeq}, ${row.claim_seq}, ${run.gate},
                ${run.identity}, ${run.filtered}, ${run.source}, ${run.outcome}, ${run.exitCode},
                ${run.treeBefore}, ${run.treeAfter}, ${run.mutatedSince}, ${run.startedAt}, ${run.finishedAt}
            )
            on conflict (org_id, job_id, execution_id) do update set
                claim_seq = excluded.claim_seq, outcome = excluded.outcome, exit_code = excluded.exit_code,
                tree_before = excluded.tree_before, tree_after = excluded.tree_after,
                mutated_since = excluded.mutated_since, started_at = excluded.started_at,
                finished_at = excluded.finished_at
            where job_gate_run.outcome = 'running' and excluded.outcome <> 'running'
              and job_gate_run.run_claim_seq = excluded.run_claim_seq and job_gate_run.gate = excluded.gate
        `;
        return { result: 'ok' };
    });
}

export async function readGateRuns(
    ctx: JobStoreContext,
    attempt: { id: string; leaseToken: string },
    runClaimSeq: number
): ReturnType<GateRunStore['readGateRuns']> {
    const { sql, orgId } = ctx;
    const { id, leaseToken } = attempt;
    const [row] = await sql<{ lease_token: string | null; status: string }[]>`
        select lease_token, status from job where org_id = ${orgId} and id = ${id}
    `;
    if (!row) return { result: 'missing' };
    if (row.status !== 'running' || row.lease_token !== leaseToken) return { result: 'lost' };
    const rows = await sql<(StoredRow & { seq: string })[]>`
        select * from (
            select distinct on (gate) *
            from job_gate_run
            where org_id = ${orgId} and job_id = ${id} and run_claim_seq = ${runClaimSeq}
            order by gate, seq desc
        ) latest
        order by seq
        limit ${READ_LIMIT}
    `;
    return {
        result: 'ok',
        runs: rows.map((r) => ({
            runClaimSeq: Number(r.run_claim_seq),
            claimSeq: Number(r.claim_seq),
            executionId: r.execution_id,
            gate: r.gate,
            identity: r.identity,
            filtered: r.filtered,
            source: r.source,
            outcome: r.outcome,
            exitCode: r.exit_code,
            treeBefore: r.tree_before,
            treeAfter: r.tree_after,
            mutatedSince: r.mutated_since,
            startedAt: r.started_at ? r.started_at.toISOString() : null,
            finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
        })),
    };
}
