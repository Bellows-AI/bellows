import type { Fragment, Sql, TransactionSql } from 'postgres';

/**
 * The staged-conclusion reads every settle shares (issue #821; `076_job_conclusions.sql`): a row
 * whose attempt staged its final envelope under its current lease belongs to that conclusion — the
 * board commits it, and no retirement, stop, claim or other settle takes the attempt instead.
 * Imports nothing of the store, so the claim, the rows and the settles can all read it.
 */

/** Whether the `job` row `alias` names has a conclusion staged under its current lease token. */
export const stagedUnderLease = (sql: Sql | TransactionSql, alias: string): Fragment =>
    sql`exists (
        select 1 from job_conclusion c
        where c.org_id = ${sql(alias)}.org_id and c.job_id = ${sql(alias)}.id
          and c.lease_token = ${sql(alias)}.lease_token
    )`;

/**
 * The fingerprint staged under one attempt's lease token, or null when it staged none — read under
 * the job row's lock, which a stage holds until it commits: a settle that raced a stage waits it out
 * and reads its conclusion, never deciding on a snapshot that predates it.
 */
export async function stagedFingerprint(
    tx: TransactionSql,
    key: { orgId: string; jobId: string; leaseToken: string }
): Promise<string | null> {
    await tx`select id from job where org_id = ${key.orgId} and id = ${key.jobId} for update`;
    const [row] = await tx<{ fingerprint: string }[]>`
        select fingerprint from job_conclusion
        where org_id = ${key.orgId} and job_id = ${key.jobId} and lease_token = ${key.leaseToken}
    `;
    return row?.fingerprint ?? null;
}
