/**
 * What the board's change-request read routes need of a task (docs/gitlab.md): its thread root's repository and
 * starter (whose grant reads) and the one change request the thread recorded. A confirmed read: a throw is the caller's
 * to answer as unavailable, never as "no change request".
 */

import { parseChangeRequestUrl, sameRepo, type RepoRef } from '@factory-ai/core';
import { refOfNullableRow } from '../repo-ref-row.js';
import type { JobStoreContext } from './job-store-types.js';

export interface ChangeRequestContext {
    orgId: string;
    rootJobId: string;
    /** The thread root's repository; null for a command-only task. */
    ref: RepoRef | null;
    /** The thread's STARTER: the grant a read is made with. */
    executionUserId: string | null;
    /** The change request the thread recorded, or null when it never published one. */
    publication: { number: number; url: string } | null;
}

export type ChangeRequestContextResult = ({ result: 'ok' } & ChangeRequestContext) | { result: 'missing' };

export interface ChangeRequestStore {
    /** The task's thread: any member of it names the root's repository, starter and recorded change request. */
    changeRequestContext(id: string): Promise<ChangeRequestContextResult>;
}

export async function changeRequestContext(ctx: JobStoreContext, id: string): Promise<ChangeRequestContextResult> {
    const { sql, orgId } = ctx;
    const [row] = await sql<
        {
            root_job_id: string;
            forge: string;
            host: string;
            repo: string | null;
            execution_user_id: string | null;
            pr_number: number | null;
            pr_url: string | null;
        }[]
    >`
        select root.id as root_job_id, root.forge, root.host, root.repo, root.execution_user_id,
               pr.pr_number, pr.pr_url
        from job j
        join job root on root.org_id = j.org_id and root.id = j.root_job_id
        left join job_pr pr on pr.org_id = root.org_id and pr.root_job_id = root.id
        where j.org_id = ${orgId} and j.id = ${id}
    `;
    if (!row) return { result: 'missing' };
    const ref = refOfNullableRow(row);
    let publication: ChangeRequestContext['publication'] = null;
    if (row.pr_number !== null && row.pr_url !== null) {
        // The recorded url must name the root's own repository and number: a row that does not is no change request to
        // read as the starter (an unconfirmed state, a throw), never a number the starter's token may be sent to.
        const parsed = parseChangeRequestUrl(row.pr_url);
        if (!ref || !parsed || parsed.number !== row.pr_number || !sameRepo(parsed.ref, ref)) {
            throw new Error('the recorded change request does not name the task repository');
        }
        publication = { number: row.pr_number, url: row.pr_url };
    }
    return {
        result: 'ok',
        orgId,
        rootJobId: row.root_job_id,
        ref,
        executionUserId: row.execution_user_id,
        publication,
    };
}
