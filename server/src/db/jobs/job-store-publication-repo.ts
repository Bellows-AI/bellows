import { parseChangeRequestUrl, type RepoRef } from '@factory-ai/core';
import type { TransactionSql } from 'postgres';
import { refOfNullableRow } from '../repo-ref-row.js';

/** The refusal of a verdict or staged conclusion whose publication is not on the leased task's own repository. */
export type WrongRepo = { result: 'wrong_repo' };

/** Whether the url names a change request on `task`: forge and host exactly, the path as GitHub treats it. */
export function changeRequestOnRepo(url: string, task: RepoRef | null): boolean {
    const parsed = parseChangeRequestUrl(url);
    if (parsed === null || task === null) return false;
    const { ref } = parsed;
    return ref.forge === task.forge && ref.host === task.host && ref.path.toLowerCase() === task.path.toLowerCase();
}

/**
 * Whether a publication would record a url that is not on the task's repository, read in the settle's own
 * transaction from the attempt's row. Only a row still running under the lease can be refused: any other
 * request is a replay or a lost lease, which the settle's receipt answers, never this check.
 */
export async function publicationOffTask(
    tx: TransactionSql,
    attempt: { orgId: string; id: string; leaseToken: string },
    publication: { prUrl: string } | null | undefined
): Promise<boolean> {
    if (!publication) return false;
    const [row] = await tx<{ forge: string; host: string; repo: string | null }[]>`
        select forge, host, repo from job
        where org_id = ${attempt.orgId} and id = ${attempt.id} and status = 'running' and lease_token = ${attempt.leaseToken}
    `;
    return row !== undefined && !changeRequestOnRepo(publication.prUrl, refOfNullableRow(row));
}
