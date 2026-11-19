/**
 * The claim acquisition's locks: the candidate row, then its thread root's advisory lock, timed as one `claim.lock_wait`
 * step. See `acquireCandidate` in job-store-claim.ts for why the root lock is tried, never waited for.
 */

import type { TransactionSql } from 'postgres';
import { rootRowFree } from './job-store-claim-row.js';

/** The reserved candidate, as far as its locks read it. */
interface LockedCandidate {
    id: string;
    root_job_id: string;
    /** The deferral the reservation overwrote, restored when the thread lock is busy. */
    prior_deferral: Date | null;
}

/**
 * Try, never wait: the acquire holds the candidate's row, and every thread-wide writer holds the root row and then
 * waits on the advisory lock or on a member row. So a member also tries the root row
 * (`skip locked`; the fence locks it while the claim holds the advisory lock). Busy or gone is not an answer about the
 * row, so the reservation's deferral goes back and the poll moves on. Only an explicit boolean is an answer.
 */
async function tryThreadLock(tx: TransactionSql, orgId: string, reserved: LockedCandidate): Promise<boolean> {
    if (await rootRowFree(tx, orgId, reserved.id, reserved.root_job_id)) {
        const [lock] = await tx<{ locked: boolean }[]>`
            select pg_try_advisory_xact_lock(hashtextextended(${reserved.root_job_id}::text, 0)) as locked
        `;
        if (typeof lock?.locked !== 'boolean') throw new Error('thread lock probe answered nothing');
        if (lock.locked) return true;
    }
    await tx`update job set claim_deferred_until = ${reserved.prior_deferral}
             where org_id = ${orgId} and id = ${reserved.id}`;
    return false;
}

/**
 * The candidate row locked, then its thread lock tried. `gone` (the thread was removed while this claim prepared):
 * nothing to acquire, and no row is left to carry a deferral. `busy`: the thread lock is held, the deferral restored.
 * `queued_since` is where queued-to-claimed starts: the later of the row's creation, its release to the queue and the
 * end of the deferral the reservation overwrote. The wait itself is read at the acquisition (`queue_age`), after the
 * locks, so the lock wait is part of it.
 */
export async function lockCandidate(
    tx: TransactionSql,
    orgId: string,
    reserved: LockedCandidate
): Promise<{ status: string; queued_since: Date } | 'gone' | 'busy'> {
    const [locked] = await tx<{ status: string; queued_since: Date }[]>`
        select status,
               greatest(created_at, lease_expires_at, coalesce(${reserved.prior_deferral}::timestamptz, created_at))
                   as queued_since
        from job where org_id = ${orgId} and id = ${reserved.id} for update
    `;
    if (!locked) return 'gone';
    if (!(await tryThreadLock(tx, orgId, reserved))) return 'busy';
    return locked;
}
