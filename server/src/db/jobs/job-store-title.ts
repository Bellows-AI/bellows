/**
 * The user's rename of a task title (BEL-252; `125_job_title.sql`). The title lives on the thread ROOT, so a
 * rename by any member's id writes the root. One conditional UPDATE carries every precondition (same org, the
 * revision the caller rendered, the task's author or an org admin) and bumps the revision; the audit row commits
 * with it. On zero rows ONE classification read says why — and a failed read throws, it never answers `missing`.
 */

import type { TaskTitleOrigin } from '@factory-ai/core';
import type { CreatedRef, CreateTarget } from './job-store-action-types.js';
import { insertJobInTx } from './job-store-thread-actions.js';

import type { JobStoreContext } from './job-store-types.js';

export type RenameTaskResult =
    | { ok: true; title: string; origin: 'user'; revision: number }
    | { ok: false; refusal: 'missing' | 'forbidden' }
    | { ok: false; refusal: 'stale'; title: string | null; origin: TaskTitleOrigin | null; revision: number };

export interface RenameTaskInput {
    /** Already normalized by the route. */
    title: string;
    /** The revision the caller rendered. */
    revision: number;
    caller: string | null;
    /** The route's org-admin verdict; ignored for a null caller. */
    admin?: boolean | undefined;
}

/** The store half the board's rename route calls; `JobStore` extends it. */
export interface JobTitleStore {
    /**
     * Sets the root's title with origin `user` when `revision` is still the root's revision and the caller is the task's author or, with `admin`, anyone. A stale revision
     * answers the current title so the caller can show it.
     */
    renameTask(id: string, rename: RenameTaskInput): Promise<RenameTaskResult>;
}

/**
 * The create: one transaction for the root row and, when the request names a title, the title stamped on it
 * (origin `user`, revision 1) with its first audit row. A replayed create changes nothing.
 */
export async function createTitledJob(
    ctx: JobStoreContext,
    command: string,
    createdBy: string | null,
    target: CreateTarget
): Promise<CreatedRef> {
    return ctx.sql.begin(async (tx) => {
        const created = await insertJobInTx(tx, ctx, { command, createdBy, target });
        const { title } = target;
        if (!title || created.replayed) return created;
        await tx`
            update job set title = ${title}, title_origin = 'user', title_revision = 1, title_updated_at = now()
            where org_id = ${ctx.orgId} and id = ${created.id}
        `;
        await tx`
            insert into job_title_event (org_id, root_job_id, revision, title, origin, actor_user_id)
            values (${ctx.orgId}, ${created.id}, 1, ${title}, 'user', ${createdBy})
        `;
        return created;
    });
}

export async function renameTaskRow(
    ctx: JobStoreContext,
    id: string,
    { title, revision: expectedRevision, caller, admin }: RenameTaskInput
): Promise<RenameTaskResult> {
    const { sql, orgId } = ctx;
    const mayAdmin = admin === true && caller !== null;
    return sql.begin(async (tx) => {
        const updated = await tx<{ id: string; title_revision: number }[]>`
            update job r set title = ${title}, title_origin = 'user', title_revision = r.title_revision + 1,
                             title_updated_at = now()
            where r.org_id = ${orgId}
              and r.id = (select n.root_job_id from job n where n.org_id = ${orgId} and n.id = ${id})
              and r.title_revision = ${expectedRevision}
              and (r.created_by is not distinct from ${caller} and ${caller}::uuid is not null or ${mayAdmin}::boolean)
            returning r.id, r.title_revision
        `;
        const row = updated[0];
        if (row) {
            await tx`
                insert into job_title_event (org_id, root_job_id, revision, title, origin, actor_user_id)
                values (${orgId}, ${row.id}, ${row.title_revision}, ${title}, 'user', ${caller})
            `;
            return { ok: true, title, origin: 'user', revision: row.title_revision } as const;
        }
        const [root] = await tx<
            {
                created_by: string | null;
                title: string | null;
                title_origin: TaskTitleOrigin | null;
                title_revision: number;
            }[]
        >`
            select r.created_by, r.title, r.title_origin, r.title_revision
            from job n join job r on r.org_id = n.org_id and r.id = n.root_job_id
            where n.org_id = ${orgId} and n.id = ${id}
        `;
        if (!root) return { ok: false, refusal: 'missing' } as const;
        if (!(root.created_by === caller && caller !== null) && !mayAdmin) {
            return { ok: false, refusal: 'forbidden' } as const;
        }
        return {
            ok: false,
            refusal: 'stale',
            title: root.title,
            origin: root.title_origin,
            revision: root.title_revision,
        } as const;
    });
}
