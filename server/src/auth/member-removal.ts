import { ADMIN_ROLE } from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';
import { type AuditEntry, recordAudit, userActor } from '../db/audit-log.js';
import type { AuthStore } from './store.js';

/**
 * How a membership ends and an admin's removal outlives it (docs/auth.md): the shared deletion, the block row
 * (`org_membership_removal`) an admin writes and lifts, and what the invitation read needs to know about who is
 * already accounted for. Both the auth store and the membership re-check's store run this SQL.
 */

/** Why a membership ended: an admin, GitHub's answer at a re-check or a webhook, or a sign-in that no longer reaches the org. */
export type MembershipEnd = 'admin-removal' | 'github-not-member' | 'github-webhook' | 'sign-in-sweep';

/** The board itself: a membership GitHub ended, or a role GitHub conferred. */
export const SYSTEM_ACTOR: AuditEntry['actor'] = { kind: 'system', id: null };

/**
 * THE way a membership ends, whoever ends it (the sign-in sweep, the webhook, a confirmed non-member at the
 * re-check, an admin's removal): the memberships of `orgIds`, the account's sessions in those orgs and its
 * personal tokens there, inside the caller's transaction — so a membership granted again later never revives
 * an old credential. Each deleted membership writes its `member.remove` audit row there too, naming `cause`.
 * Returns how many memberships were deleted.
 */
export async function endMemberships(
    tx: TransactionSql,
    userId: string,
    orgIds: readonly string[],
    cause: { actor: AuditEntry['actor']; reason: MembershipEnd }
): Promise<number> {
    if (orgIds.length === 0) return 0;
    const ids = [...orgIds];
    const deleted = await tx<{ org_id: string }[]>`
        delete from org_membership where user_id = ${userId}::uuid and org_id = any(${ids}::text[]) returning org_id
    `;
    for (const { org_id: orgId } of deleted) {
        const detail = { reason: cause.reason };
        await recordAudit(tx, { orgId, actor: cause.actor, action: 'member.remove', target: userId, detail });
    }
    await tx`delete from session where user_id = ${userId}::uuid and org_id = any(${ids}::text[])`;
    await tx`
        update access_token set revoked_at = now()
        where user_id = ${userId}::uuid and org_id = any(${ids}::text[]) and kind = 'personal' and revoked_at is null
    `;
    return deleted.length;
}

/**
 * An admin's removal: a block row that outlives the membership, then the same deletion and revocation a
 * `not-member` verdict runs, and its audit row, in one transaction. `last-admin` refuses removing the org's only admin;
 * `missing` is no such member.
 */
export function blockMembership(
    sql: Sql,
    orgId: string,
    userId: string,
    removedBy: string
): Promise<'removed' | 'last-admin' | 'missing'> {
    return sql.begin(async (tx) => {
        // Every admin row and the target locked first, as setMemberRole does, so two admins removing
        // each other serialize and the second counts the org the first left behind.
        const locked = await tx<{ user_id: string; role: string }[]>`
            select user_id::text as user_id, role from org_membership
            where org_id = ${orgId} and (role = ${ADMIN_ROLE} or user_id = ${userId}::uuid)
            for update
        `;
        const target = locked.find((row) => row.user_id === userId);
        if (!target) return 'missing' as const;
        const admins = locked.filter((row) => row.role === ADMIN_ROLE).length;
        if (target.role === ADMIN_ROLE && admins <= 1) return 'last-admin' as const;
        await tx`
            insert into org_membership_removal (org_id, user_id, removed_by)
            values (${orgId}, ${userId}::uuid, ${removedBy}::uuid)
            on conflict (org_id, user_id) do update
                set removed_by = excluded.removed_by, removed_at = now()
        `;
        await endMemberships(tx, userId, [orgId], { actor: userActor(removedBy), reason: 'admin-removal' });
        return 'removed' as const;
    });
}

/** Lifts a block, audited as `actorId`'s: the account's next sign-in materializes its membership again. */
export function restoreMembership(
    sql: Sql,
    orgId: string,
    userId: string,
    actorId: string
): Promise<'restored' | 'missing'> {
    return sql.begin(async (tx) => {
        const rows = await tx`
            delete from org_membership_removal where org_id = ${orgId} and user_id = ${userId}::uuid
            returning user_id
        `;
        if (rows.length === 0) return 'missing' as const;
        await recordAudit(tx, { orgId, actor: userActor(actorId), action: 'member.restore', target: userId });
        return 'restored' as const;
    });
}

/** The auth store's half: an admin's removal, its list and its restore, and the invitation read's basis. */
export function buildRemovalMethods(
    sql: Sql,
    gate: () => Promise<void>
): Pick<AuthStore, 'blockMember' | 'restoreMember' | 'listRemovedMembers' | 'invitationBasis'> {
    return {
        async blockMember(orgId, userId, removedBy) {
            await gate();
            return blockMembership(sql, orgId, userId, removedBy);
        },

        async restoreMember(orgId, userId, actorId) {
            await gate();
            return restoreMembership(sql, orgId, userId, actorId);
        },

        async listRemovedMembers(orgId) {
            await gate();
            const rows = await sql<
                { user_id: string; github_login: string; removed_at: Date; removed_by: string | null }[]
            >`
                select r.user_id::text as user_id, u.github_login, r.removed_at, b.github_login as removed_by
                from org_membership_removal r
                join app_user u on u.id = r.user_id
                left join app_user b on b.id = r.removed_by
                where r.org_id = ${orgId}
                order by u.github_login
            `;
            return rows.map((row) => ({
                userId: row.user_id,
                githubLogin: row.github_login,
                removedAt: row.removed_at.toISOString(),
                removedBy: row.removed_by,
            }));
        },

        async invitationBasis(orgId) {
            await gate();
            const orgs = await sql<
                { id: string; name: string; account_type: string | null; account_id: string | null }[]
            >`select id, name, account_type, account_id::text as account_id from organization where id = ${orgId}`;
            const org = orgs[0];
            if (!org) return null;
            // Everyone who signed in, and everyone an admin removed: neither is anyone to invite.
            const ids = await sql<{ github_user_id: string }[]>`
                select u.github_user_id::text as github_user_id from org_membership m
                join app_user u on u.id = m.user_id where m.org_id = ${orgId}
                union
                select u.github_user_id::text from org_membership_removal r
                join app_user u on u.id = r.user_id where r.org_id = ${orgId}
            `;
            return {
                org: {
                    id: org.id,
                    name: org.name,
                    accountType: org.account_type,
                    // bigint arrives as a string from postgres.js; Number() is exact for every GitHub id.
                    accountId: org.account_id === null ? null : Number(org.account_id),
                },
                githubUserIds: ids.map((row) => Number(row.github_user_id)),
            };
        },
    };
}
