import { ADMIN_ROLE } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { endMemberships } from './store.js';
import type { MembershipTarget, MembershipVerdict } from './membership.js';

/** One membership to re-check, keyed for the store and described for the GitHub read. */
export interface MembershipCheck extends MembershipTarget {
    orgId: string;
    userId: string;
}

/**
 * The membership re-check's SQL (docs/auth.md): which memberships are due, what a verdict does to one, and the
 * admin's persistent removal and its restore.
 */
export interface MembershipStore {
    /** The membership, described for the GitHub read; null when it no longer exists. */
    target(orgId: string, userId: string): Promise<MembershipCheck | null>;
    /** Up to `limit` memberships last checked before `before` (never checked first). */
    due(before: Date, limit: number): Promise<MembershipCheck[]>;
    /**
     * Applies a verdict read at `at`. `not-member` deletes the membership and, in the same transaction, the
     * account's sessions in that org and revokes its personal tokens there; `active` promotes a GitHub owner
     * (never demotes); every verdict, `unknown` included, stamps `checked_at`, so an unanswered org is asked
     * once per TTL rather than on every request.
     */
    record(orgId: string, userId: string, verdict: MembershipVerdict, at: Date): Promise<void>;
    /**
     * An admin's removal: a block row that outlives the membership, then the same deletion and revocation a
     * `not-member` verdict runs, in one transaction. `last-admin` refuses removing the org's only admin;
     * `missing` is no such member.
     */
    block(orgId: string, userId: string, removedBy: string): Promise<'removed' | 'last-admin' | 'missing'>;
    /** Lifts a block: the account's next sign-in materializes its membership again. */
    restore(orgId: string, userId: string): Promise<'restored' | 'missing'>;
}

interface CheckRow {
    org_id: string;
    user_id: string;
    org_name: string;
    account_type: string | null;
    account_id: string | null;
    github_user_id: string;
    github_login: string;
}

const toCheck = (row: CheckRow): MembershipCheck => ({
    orgId: row.org_id,
    userId: row.user_id,
    org: {
        id: row.org_id,
        login: row.org_name,
        accountType: row.account_type,
        accountId: row.account_id === null ? null : Number(row.account_id),
    },
    // bigint arrives as a string from postgres.js; Number() is exact for every GitHub id.
    user: { githubUserId: Number(row.github_user_id), login: row.github_login },
});

export function createMembershipStore({ sql, ready }: { sql: Sql; ready?: Promise<unknown> }): MembershipStore {
    const gate = async () => {
        if (ready) await ready;
    };
    const select = () => sql`
        select m.org_id, m.user_id::text as user_id, o.name as org_name, o.account_type,
               o.account_id::text as account_id, u.github_user_id::text as github_user_id, u.github_login
        from org_membership m
        join organization o on o.id = m.org_id
        join app_user u on u.id = m.user_id
    `;

    return {
        async target(orgId, userId) {
            await gate();
            const rows = await sql<CheckRow[]>`${select()} where m.org_id = ${orgId} and m.user_id = ${userId}::uuid`;
            return rows[0] ? toCheck(rows[0]) : null;
        },

        async due(before, limit) {
            await gate();
            // The stand-in account of AUTH_MODE=none (github id 0) is nobody GitHub knows.
            const rows = await sql<CheckRow[]>`
                ${select()}
                where (m.checked_at is null or m.checked_at < ${before}) and u.github_user_id <> 0
                order by m.checked_at nulls first
                limit ${limit}
            `;
            return rows.map(toCheck);
        },

        async record(orgId, userId, verdict, at) {
            await gate();
            if (verdict.kind === 'not-member') {
                await sql.begin((tx) => endMemberships(tx, userId, [orgId]));
                return;
            }
            const owner = verdict.kind === 'active' && verdict.owner;
            await sql`
                update org_membership
                set checked_at = ${at}, role = case when ${owner} then ${ADMIN_ROLE} else role end
                where org_id = ${orgId} and user_id = ${userId}::uuid
            `;
        },

        async block(orgId, userId, removedBy) {
            await gate();
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
                await endMemberships(tx, userId, [orgId]);
                return 'removed' as const;
            });
        },

        async restore(orgId, userId) {
            await gate();
            const rows = await sql`
                delete from org_membership_removal where org_id = ${orgId} and user_id = ${userId}::uuid
                returning user_id
            `;
            return rows.length > 0 ? 'restored' : 'missing';
        },
    };
}
