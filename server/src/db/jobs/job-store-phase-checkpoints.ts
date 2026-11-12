/**
 * Phase checkpoints (`080_job_phase_checkpoints.sql`): the outcome of each post-run
 * phase of an attempt, written under its lease after the phase returns and read back by the
 * driver that adopts or takes over the run.
 */

import { lockRunningAttempt, leaseRefusal } from './job-store-rows.js';
import type { JobStoreContext } from './job-store-types.js';

/** The phases that leave a checkpoint, in the order they run: the pre-agent setup, then the post-run phases. */
export type PhaseCheckpointPhase = 'setup' | 'gates' | 'post' | 'publish';

/** One stored phase checkpoint: the claim that wrote it, the tree its phase ran against, its outcome. */
export interface PhaseCheckpointRow {
    phase: PhaseCheckpointPhase;
    claimSeq: number;
    tree: string | null;
    result: unknown;
}

/** The store half the board's phase-checkpoint routes call; `JobStore` extends it. */
export interface PhaseCheckpointStore {
    /**
     * Records the outcome of a post-run phase of the run that claim `runClaimSeq` started, under the
     * attempt's lease, and drops the later phases of the same run. `conflict` is a run claim
     * sequence the job never reached.
     */
    writePhaseCheckpoint(
        id: string,
        leaseToken: string,
        checkpoint: { runClaimSeq: number; phase: PhaseCheckpointPhase; tree: string | null; result: unknown }
    ): Promise<{ result: 'ok' | 'lost' | 'missing' | 'conflict' }>;
    /** The phase checkpoints of one run, in phase order, under the attempt's lease. */
    readPhaseCheckpoints(
        id: string,
        leaseToken: string,
        runClaimSeq: number
    ): Promise<{ result: 'lost' | 'missing' } | { result: 'ok'; checkpoints: PhaseCheckpointRow[] }>;
}

const ORDER = ['setup', 'gates', 'post', 'publish'] as const;

export async function writePhaseCheckpoint(
    ctx: JobStoreContext,
    attempt: { id: string; leaseToken: string },
    checkpoint: Parameters<PhaseCheckpointStore['writePhaseCheckpoint']>[2]
): ReturnType<PhaseCheckpointStore['writePhaseCheckpoint']> {
    const { sql, orgId } = ctx;
    const { id, leaseToken } = attempt;
    const { runClaimSeq, phase, tree, result } = checkpoint;
    return sql.begin(async (tx) => {
        const row = await lockRunningAttempt(tx, orgId, id, leaseToken);
        if ('result' in row) return row;
        if (runClaimSeq < 1 || runClaimSeq > Number(row.claim_seq)) return { result: 'conflict' };
        const later = ORDER.slice(ORDER.indexOf(phase) + 1);
        if (later.length > 0) {
            await tx`
                delete from job_phase_checkpoint
                where org_id = ${orgId} and job_id = ${id} and run_claim_seq = ${runClaimSeq}
                  and phase in ${tx(later)}
            `;
        }
        // Text cast, not `tx.json`: a phase whose outcome is the JSON null (no helper failed) is a value.
        await tx`
            insert into job_phase_checkpoint (org_id, job_id, run_claim_seq, phase, claim_seq, tree, result)
            values (${orgId}, ${id}, ${runClaimSeq}, ${phase}, ${row.claim_seq}, ${tree}, ${JSON.stringify(result)}::text::jsonb)
            on conflict (org_id, job_id, run_claim_seq, phase) do update set
                claim_seq = excluded.claim_seq, tree = excluded.tree, result = excluded.result, created_at = now()
        `;
        return { result: 'ok' };
    });
}

export async function readPhaseCheckpoints(
    ctx: JobStoreContext,
    attempt: { id: string; leaseToken: string },
    runClaimSeq: number
): ReturnType<PhaseCheckpointStore['readPhaseCheckpoints']> {
    const { sql, orgId } = ctx;
    const { id, leaseToken } = attempt;
    const refused = await leaseRefusal(sql, orgId, id, leaseToken);
    if (refused) return refused;
    const rows = await sql<{ phase: PhaseCheckpointPhase; claim_seq: string; tree: string | null; result: unknown }[]>`
        select phase, claim_seq, tree, result from job_phase_checkpoint
        where org_id = ${orgId} and job_id = ${id} and run_claim_seq = ${runClaimSeq}
    `;
    rows.sort((a, b) => ORDER.indexOf(a.phase) - ORDER.indexOf(b.phase));
    return {
        result: 'ok',
        checkpoints: rows.map((r) => ({
            phase: r.phase,
            claimSeq: Number(r.claim_seq),
            tree: r.tree,
            result: r.result,
        })),
    };
}
