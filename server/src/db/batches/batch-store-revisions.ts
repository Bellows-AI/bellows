import { formatRepoRef, TASK_PENDING, TASK_RETRY, type RepoRef } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { refOfRow, type RepoRow } from '../repo-ref-row.js';

/** The head commit of a repository's branch, or null when it cannot be resolved. */
export type RevisionOf = (repo: RepoRef, branch: string) => Promise<string | null>;

export const revisionKey = (target: RepoRow & { branch: string }) =>
    `${formatRepoRef(refOfRow(target))}@${target.branch}`;

/** The revisions of every target, resolved once per reconcile and only when a task is waiting to launch. */
export async function resolveRevisions(
    deps: { sql: Sql; orgId: string; revisionOf?: RevisionOf | undefined },
    id: string
): Promise<Map<string, string | null>> {
    const revisions = new Map<string, string | null>();
    if (!deps.revisionOf) return revisions;
    const { sql, orgId } = deps;
    const [waiting] = await sql`
        select 1 from batch_task
        where org_id = ${orgId} and batch_id = ${id} and execution in (${TASK_PENDING}, ${TASK_RETRY}) limit 1
    `;
    if (!waiting) return revisions;
    const targets = await sql<(RepoRow & { branch: string })[]>`
        select forge, host, repo, branch from batch_target where org_id = ${orgId} and batch_id = ${id} and branch is not null
    `;
    await Promise.all(
        targets.map(async (target) => {
            // An unresolvable revision is recorded as unknown; it never blocks the launch.
            revisions.set(
                revisionKey(target),
                await deps.revisionOf!(refOfRow(target), target.branch).catch(() => null)
            );
        })
    );
    return revisions;
}
