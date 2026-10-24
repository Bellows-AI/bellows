import { randomUUID } from 'node:crypto';
import { nextObservationDelayMs, OBSERVE_INTERVAL_MS, type ReadErrorKind } from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';
import { OBSERVATION_LEASE_MS } from './batches/batch-store-observation.js';

/**
 * The PR follower's cadence rows (082; docs/workflows.md): which PRs are due for a read. Nothing
 * here says what a PR looked like — the follower applies what it reads to the wait, ledger and
 * thread rows — so a row can be lost and rebuilt. A reader leases a row while it reads GitHub with
 * no lock held, and commits only while the lease stands, the shape of the batch observation.
 */

/**
 * How often a followed PR is read. The webhook is the fast path; this is the backstop, and a read
 * is several REST calls, so it is a quarter of an hour rather than the batch observer's minute.
 */
const FOLLOW_EVERY_N_OBSERVATIONS = 15;
export const PR_FOLLOW_INTERVAL_MS = FOLLOW_EVERY_N_OBSERVATIONS * OBSERVE_INTERVAL_MS;
/** A PR seen closed unmerged is read less often, but never dropped while a thread or wait follows it. */
const CLOSED_SLOWDOWN = 4;
export const PR_FOLLOW_CLOSED_INTERVAL_MS = CLOSED_SLOWDOWN * PR_FOLLOW_INTERVAL_MS;

export interface PrFollowDeps {
    sql: Sql;
    orgId: string;
    now?: (() => Date) | undefined;
}

export interface PrFollowClaim {
    repo: string;
    prNumber: number;
    token: string;
}

export type PrFollowResult =
    | { kind: 'seen'; closed: boolean }
    | { kind: 'failed'; error: ReadErrorKind; retryAfterMs: number | null };

const nowOf = (deps: PrFollowDeps): Date => (deps.now ? deps.now() : new Date());

/**
 * The PRs worth reading: the PR of every open wait, and the PR a live non-batch thread published
 * that no merge has been recorded for. A batch task's PR is the batch observer's, a done thread has
 * nothing left to close, and a removed thread's orphaned publication row is not counted.
 */
const candidates = (tx: TransactionSql, orgId: string) => tx`
    select w.repo, w.pr_number from workflow_wait w
    where w.org_id = ${orgId} and w.completed_at is null and w.cancelled_at is null
    union
    select p.repo, p.pr_number from job_pr p
    where p.org_id = ${orgId}
      and exists (select 1 from job j where j.org_id = p.org_id and j.id = p.root_job_id)
      and not exists (select 1 from pr_merge m
                      where m.org_id = p.org_id and m.repo = p.repo and m.pr_number = p.pr_number)
      and not exists (select 1 from batch_task t where t.org_id = p.org_id and t.root_job_id = p.root_job_id)
      and not exists (select 1 from job d
                      where d.org_id = p.org_id and d.root_job_id = p.root_job_id and d.done_at is not null)
`;

interface DueRow {
    repo: string;
    pr_number: number;
}

/**
 * Forgets rows nothing follows, adds rows for new candidates (due within `spreadMs`, so a backlog
 * does not read at once), then leases the due ones. Short transactions only: GitHub is read after
 * this commits.
 */
export async function claimDue(deps: PrFollowDeps, limit: number, spreadMs: number): Promise<PrFollowClaim[]> {
    const { sql, orgId } = deps;
    const now = nowOf(deps);
    return sql.begin(async (tx) => {
        await tx`
            delete from pr_follow f
            where f.org_id = ${orgId} and (f.repo, f.pr_number) not in (${candidates(tx, orgId)})
        `;
        await tx`
            insert into pr_follow (org_id, repo, pr_number, next_poll_at)
            select ${orgId}, c.repo, c.pr_number,
                   ${now}::timestamptz + random() * ${spreadMs}::double precision * interval '1 millisecond'
            from (${candidates(tx, orgId)}) c
            on conflict do nothing
        `;
        const due = await tx<DueRow[]>`
            select f.repo, f.pr_number from pr_follow f
            where f.org_id = ${orgId}
              and f.next_poll_at <= ${now}
              and (f.claimed_until is null or f.claimed_until <= ${now})
            order by f.next_poll_at, f.repo, f.pr_number
            limit ${limit}
            for update skip locked
        `;
        const claimedUntil = new Date(now.getTime() + OBSERVATION_LEASE_MS);
        const claims: PrFollowClaim[] = [];
        for (const row of due) {
            const token = randomUUID();
            await tx`
                update pr_follow set claim_token = ${token}::uuid, claimed_until = ${claimedUntil}
                where org_id = ${orgId} and repo = ${row.repo} and pr_number = ${row.pr_number}
            `;
            claims.push({ repo: row.repo, prNumber: row.pr_number, token });
        }
        return claims;
    });
}

/**
 * Runs `work` and records its result as one transaction, if the claim still stands. The follow row
 * is locked first and its token checked, so a superseded owner (its lease lapsed and another
 * replica claimed) applies nothing, and no other owner can claim the row while `work` runs. Every
 * effect of a read therefore belongs to the current claim; `work` gets the transaction for the
 * ones that can join it. False when the claim no longer stands.
 */
export async function withFollowClaim(
    deps: PrFollowDeps,
    claim: PrFollowClaim,
    work: (tx: TransactionSql) => Promise<PrFollowResult>
): Promise<boolean> {
    const { sql, orgId } = deps;
    const now = nowOf(deps);
    return sql.begin(async (tx) => {
        const [row] = await tx<{ failures: number }[]>`
            select failures from pr_follow
            where org_id = ${orgId} and repo = ${claim.repo} and pr_number = ${claim.prNumber}
              and claim_token = ${claim.token}::uuid
            for update
        `;
        if (row === undefined) return false;
        const result = await work(tx);
        if (result.kind === 'seen') {
            const interval = result.closed ? PR_FOLLOW_CLOSED_INTERVAL_MS : PR_FOLLOW_INTERVAL_MS;
            await tx`
                update pr_follow set
                    failures = 0, error_code = null, observed_at = ${now},
                    next_poll_at = ${new Date(now.getTime() + interval)},
                    claim_token = null, claimed_until = null, updated_at = ${now}
                where org_id = ${orgId} and repo = ${claim.repo} and pr_number = ${claim.prNumber}
            `;
            return true;
        }
        const failures = row.failures + 1;
        const delay = nextObservationDelayMs({ ok: false, failures, retryAfterMs: result.retryAfterMs });
        await tx`
            update pr_follow set
                failures = ${failures}, error_code = ${result.error},
                next_poll_at = ${new Date(now.getTime() + delay)},
                claim_token = null, claimed_until = null, updated_at = ${now}
            where org_id = ${orgId} and repo = ${claim.repo} and pr_number = ${claim.prNumber}
        `;
        return true;
    });
}
