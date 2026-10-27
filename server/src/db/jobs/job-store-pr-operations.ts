/**
 * PR operations (issue #983; `088_job_pr_operation.sql`): one row per managed publish operation of an
 * attempt, written by the driver under its lease when the operation ran. Idempotent on the operation
 * id the driver minted, so a replayed write adds nothing.
 */

import { exists } from './job-store-rows.js';
import type { JobStoreContext } from './job-store-types.js';

export const PR_OPERATIONS = ['created', 'reused'] as const;
export type PrOperationKind = (typeof PR_OPERATIONS)[number];

/** One operation as the driver records it. */
export interface PrOperationWrite {
    operationId: string;
    operation: PrOperationKind;
    repo: string;
    prNumber: number;
    prUrl: string;
    branch: string;
}

/** The store half the board's PR-operation route calls; `JobStore` extends it. */
export interface PrOperationStore {
    /**
     * Records one operation under the attempt's lease. Idempotent on `operationId`: the first write
     * wins and a replay changes nothing.
     */
    writePrOperation(
        id: string,
        leaseToken: string,
        operation: PrOperationWrite
    ): Promise<{ result: 'ok' | 'lost' | 'missing' }>;
}

export async function writePrOperation(
    ctx: JobStoreContext,
    attempt: { id: string; leaseToken: string },
    op: PrOperationWrite
): ReturnType<PrOperationStore['writePrOperation']> {
    const { sql, orgId } = ctx;
    const { id, leaseToken } = attempt;
    return sql.begin(async (tx) => {
        const [row] = await tx<{ claim_seq: string }[]>`
            select claim_seq from job
            where org_id = ${orgId} and id = ${id} and status = 'running' and lease_token = ${leaseToken}
            for update
        `;
        if (!row) return { result: (await exists(tx, orgId, id)) ? 'lost' : 'missing' };
        await tx`
            insert into job_pr_operation (org_id, job_id, operation_id, claim_seq, operation, repo, pr_number, pr_url, branch)
            values (
                ${orgId}, ${id}, ${op.operationId}, ${row.claim_seq}, ${op.operation}, ${op.repo},
                ${op.prNumber}, ${op.prUrl}, ${op.branch}
            )
            on conflict (org_id, job_id, operation_id) do nothing
        `;
        return { result: 'ok' };
    });
}
