import { ADMIN_ROLE, MEMBER_ROLE } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { recordAudit } from '../db/audit-log.js';
import { SYSTEM_ACTOR } from './member-removal.js';

/**
 * The sign-in's admin promotions (docs/auth.md): the admin bootstrap of an org with no admin, where GitHub gave no
 * membership answer, and the GitHub owner of every org it did answer for. Each promotion writes its `member.role`
 * audit row (the board's own, `system`) in the same transaction; a promotion that changes nothing records nothing.
 */
export function promoteAdmins(
    sql: Sql,
    userId: string,
    plan: { bootstrap: readonly string[]; owners: readonly string[] }
): Promise<void> {
    return sql.begin(async (tx) => {
        const bootstrapped = await tx<{ org_id: string }[]>`
            update org_membership m set role = ${ADMIN_ROLE}
            from unnest(${[...plan.bootstrap]}::text[]) as t(id)
            where m.org_id = t.id and m.user_id = ${userId}::uuid and m.role = ${MEMBER_ROLE}
              and not exists (
                  select 1 from org_membership a where a.org_id = t.id and a.role = ${ADMIN_ROLE}
              )
            returning m.org_id
        `;
        const owned = await tx<{ org_id: string }[]>`
            update org_membership set role = ${ADMIN_ROLE}
            where user_id = ${userId}::uuid and org_id = any(${[...plan.owners]}::text[]) and role <> ${ADMIN_ROLE}
            returning org_id
        `;
        const promotions = [
            ...bootstrapped.map((row) => ({ orgId: row.org_id, reason: 'first-member' })),
            ...owned.map((row) => ({ orgId: row.org_id, reason: 'github-owner' })),
        ];
        for (const { orgId, reason } of promotions) {
            const detail = { from: MEMBER_ROLE, to: ADMIN_ROLE, reason };
            await recordAudit(tx, { orgId, actor: SYSTEM_ACTOR, action: 'member.role', target: userId, detail });
        }
    });
}
