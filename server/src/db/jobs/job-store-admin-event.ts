import type { Sql, TransactionSql } from 'postgres';
import type { AdminAction } from '@factory-ai/core';
import type { JobStorePrs } from './job-store-types.js';

/**
 * Emits `task.admin_action` in the action's own transaction, after the write it records succeeded, so the
 * action never commits without its event. Nothing is written when the actor is the thread's owner (the root's
 * `execution_user_id`), so an owner's own action and a replay that reaches no insert emit nothing. `subject` is the
 * dedupe key: the created job id, or the root plus the transaction id for a wait cancel.
 */
export async function insertAdminActionEvent(
    tx: TransactionSql,
    input: { orgId: string; jobId: string; action: AdminAction; actorId: string | null; subject?: string }
): Promise<void> {
    const { orgId, jobId, action, actorId } = input;
    if (!actorId) return;
    const rows = await tx<{ org_id: string; id: string }[]>`
        insert into notification_event (org_id, id, kind, job_id, root_job_id, repo, workflow, command, reason, pr_url,
                                        action, actor_user_id, actor_login, author_user_id, author_login, occurred_at)
        select j.org_id,
               md5(${input.subject ?? jobId}::text || '/task.admin_action')::uuid,
               'task.admin_action',
               j.id,
               j.root_job_id,
               j.repo,
               j.workflow_name,
               j.command,
               null,
               null,
               ${action},
               ${actorId}::uuid,
               (select a.github_login from app_user a where a.id = ${actorId}::uuid),
               r.execution_user_id,
               (select o.github_login from app_user o where o.id = r.execution_user_id),
               now()
        from job j
        join job r on r.org_id = j.org_id and r.id = j.root_job_id
        where j.org_id = ${orgId} and j.id = ${jobId}
          and r.execution_user_id is distinct from ${actorId}::uuid
        on conflict (org_id, id) do nothing
        returning org_id, id
    `;
    if (rows[0]) await tx`select notification_event_fan_out(${rows[0].org_id}, ${rows[0].id})`;
}

/**
 * The user's wait cancel and, when an admin cancelled another member's wait, its event, in one transaction. A cancel
 * that found no wait (or has no PR store) emits nothing; each cancelling transaction is its own event (the dedupe subject).
 */
export async function cancelWaitsWithEvent(
    ctx: { sql: Sql; orgId: string; prs?: JobStorePrs | undefined },
    root: string,
    cancelledBy: string | null
): Promise<number> {
    const { sql, orgId, prs } = ctx;
    if (!prs) return 0;
    return sql.begin(async (tx) => {
        const count = await prs.cancelWaitsForRoot(root, 'cancelled by user', tx, cancelledBy);
        if (count > 0) {
            const [txn] = await tx<{ id: string }[]>`select txid_current()::text as id`;
            await insertAdminActionEvent(tx, {
                orgId,
                jobId: root,
                action: 'wait-cancel',
                actorId: cancelledBy,
                subject: `${root}/${txn!.id}`,
            });
        }
        return count;
    });
}
