/**
 * What the board's PR route reads and writes under an attempt's lease (docs/connections.md): the task the PR belongs to
 * and its starter, and the forge requirement a grant that cannot serve opens. The route holds no transaction across
 * its GitHub calls: the lease is read before them and checked again, with the lock, only when a requirement opens.
 */

import { lockThreadRootInTx } from '../connection-bindings.js';
import { openForgeRequirement, type ForgeRequirementReason } from '../forge-requirement.js';
import { leaseRefusal, lockRunningAttempt } from './job-store-rows.js';
import type { JobStoreContext } from './job-store-types.js';

/** The running attempt a PR write is for. `executionUserId` is the thread's STARTER, whose grant writes the PR. */
export interface PrWriteContext {
    orgId: string;
    rootJobId: string;
    repo: string | null;
    rootRepo: string | null;
    executionUserId: string | null;
}

export type PrWriteContextResult = ({ result: 'ok' } & PrWriteContext) | { result: 'lost' | 'missing' };

/** The store half the board's PR route calls; `JobStore` extends it. */
export interface PrWriteStore {
    /** The attempt's task and starter, or `lost`/`missing` when the lease no longer holds a running attempt. */
    prWriteContext(id: string, leaseToken: string): Promise<PrWriteContextResult>;
    /**
     * Opens the thread's forge requirement because the starter's grant cannot serve, but only while the attempt still
     * holds a running lease: a superseded lease opens nothing.
     */
    openPrForgeWait(
        id: string,
        leaseToken: string,
        wait: { forge: string; reason: ForgeRequirementReason }
    ): Promise<{ result: 'ok' | 'lost' | 'missing' }>;
}

export async function prWriteContext(
    ctx: JobStoreContext,
    attempt: { id: string; leaseToken: string }
): Promise<PrWriteContextResult> {
    const { sql, orgId } = ctx;
    const refused = await leaseRefusal(sql, orgId, attempt.id, attempt.leaseToken);
    if (refused) return refused;
    const [row] = await sql<
        { root_job_id: string; repo: string | null; root_repo: string | null; execution_user_id: string | null }[]
    >`
        select j.root_job_id, j.repo, root.repo as root_repo, root.execution_user_id
        from job j join job root on root.org_id = j.org_id and root.id = j.root_job_id
        where j.org_id = ${orgId} and j.id = ${attempt.id}
    `;
    if (!row) return { result: 'missing' };
    return {
        result: 'ok',
        orgId,
        rootJobId: row.root_job_id,
        repo: row.repo,
        rootRepo: row.root_repo,
        executionUserId: row.execution_user_id,
    };
}

export async function openPrForgeWait(
    ctx: JobStoreContext,
    attempt: { id: string; leaseToken: string },
    wait: { forge: string; reason: ForgeRequirementReason }
): ReturnType<PrWriteStore['openPrForgeWait']> {
    const { sql, orgId } = ctx;
    // The asker's own running row, then the thread root and its lock, then the requirement: the order every
    // requirement writer takes (`requireConnectionRow`). No grant row is locked.
    return sql.begin(async (tx) => {
        const held = await lockRunningAttempt(tx, orgId, attempt.id, attempt.leaseToken);
        if ('result' in held) return held;
        const [row] = await tx<{ root_job_id: string }[]>`
            select root_job_id from job where org_id = ${orgId} and id = ${attempt.id}
        `;
        if (!row || !(await lockThreadRootInTx(tx, orgId, row.root_job_id))) return { result: 'lost' } as const;
        await openForgeRequirement(tx, { orgId, rootJobId: row.root_job_id, ...wait });
        return { result: 'ok' } as const;
    });
}
