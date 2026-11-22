/**
 * Finish passes (`163_job_finish_pass.sql`): one row per finish pass the driver answered inside an attempt, written
 * under its lease, and the count of the failed ones the driver reads before the next pass. The count is the JOB
 * ROW's, across every claim of it: a takeover reads what its predecessor spent, and a follow-up starts at none.
 */

import { leaseRefusal, lockRunningAttempt } from './job-store-rows.js';
import type { JobStoreContext } from './job-store-types.js';

export const FINISH_PASS_VERDICTS = ['passed', 'failed'] as const;
export type FinishPassVerdict = (typeof FINISH_PASS_VERDICTS)[number];

/** One answered pass as the driver records it. */
export interface FinishPassWrite {
    passId: string;
    runClaimSeq: number;
    verdict: FinishPassVerdict;
    /** The first gate that failed; null on a passed pass. */
    gate: string | null;
}

/**
 * What the job row holds for one pass id: its verdict and, for a failed one, the round it spent (its place among the
 * failed rows, oldest first). A request the driver answered but whose answer never reached the agent is retried
 * under the same id; this is how the next holder replays that round instead of spending another.
 */
export type RecordedPass = { verdict: 'passed' } | { verdict: 'failed'; round: number };

/** The store half the board's finish-pass routes call; `GateRunStore` extends it. */
export interface FinishPassStore {
    /**
     * Records one answered pass under the attempt's lease. Idempotent on `passId`: a replay changes nothing.
     * `conflict` is a run claim sequence the job never reached.
     */
    writeFinishPass(
        id: string,
        leaseToken: string,
        pass: FinishPassWrite
    ): Promise<{ result: 'ok' | 'lost' | 'missing' | 'conflict' }>;
    /**
     * The failed passes of the job row, every claim of it, under the attempt's lease; with `passId`, also what the row
     * holds for that pass (`pass`, null when none).
     */
    readFinishRounds(
        id: string,
        leaseToken: string,
        passId?: string
    ): Promise<{ result: 'lost' | 'missing' } | { result: 'ok'; failedRounds: number; pass?: RecordedPass | null }>;
}

export async function writeFinishPass(
    ctx: JobStoreContext,
    attempt: { id: string; leaseToken: string },
    pass: FinishPassWrite
): ReturnType<FinishPassStore['writeFinishPass']> {
    const { sql, orgId } = ctx;
    const { id, leaseToken } = attempt;
    return sql.begin(async (tx) => {
        const row = await lockRunningAttempt(tx, orgId, id, leaseToken);
        if ('result' in row) return row;
        if (pass.runClaimSeq < 1 || pass.runClaimSeq > Number(row.claim_seq)) return { result: 'conflict' };
        await tx`
            insert into job_finish_pass (org_id, job_id, pass_id, run_claim_seq, claim_seq, verdict, gate)
            values (${orgId}, ${id}, ${pass.passId}, ${pass.runClaimSeq}, ${row.claim_seq}, ${pass.verdict}, ${pass.gate})
            on conflict (org_id, job_id, pass_id) do nothing
        `;
        return { result: 'ok' };
    });
}

export async function readFinishRounds(
    ctx: JobStoreContext,
    attempt: { id: string; leaseToken: string },
    passId?: string
): ReturnType<FinishPassStore['readFinishRounds']> {
    const { sql, orgId } = ctx;
    const { id, leaseToken } = attempt;
    const refused = await leaseRefusal(sql, orgId, id, leaseToken);
    if (refused) return refused;
    const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from job_finish_pass
        where org_id = ${orgId} and job_id = ${id} and verdict = 'failed'
    `;
    if (passId === undefined) return { result: 'ok', failedRounds: row!.n };
    return { result: 'ok', failedRounds: row!.n, pass: await recordedPass(ctx, id, passId) };
}

/** What the job row holds for one pass id; a failed one's round is its place among the failed rows, oldest first. */
async function recordedPass(ctx: JobStoreContext, id: string, passId: string): Promise<RecordedPass | null> {
    const { sql, orgId } = ctx;
    const [row] = await sql<{ verdict: FinishPassVerdict; round: number }[]>`
        select p.verdict, (
            select count(*)::int from job_finish_pass f
            where f.org_id = p.org_id and f.job_id = p.job_id and f.verdict = 'failed'
              and (f.created_at, f.pass_id) <= (p.created_at, p.pass_id)
        ) as round
        from job_finish_pass p
        where p.org_id = ${orgId} and p.job_id = ${id} and p.pass_id = ${passId}
    `;
    if (!row) return null;
    return row.verdict === 'failed' ? { verdict: 'failed', round: row.round } : { verdict: 'passed' };
}
