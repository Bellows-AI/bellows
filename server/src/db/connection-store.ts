import type { Sql } from 'postgres';
import { revokeGrantIfOrphaned } from './connection-grants.js';

/** What a list or create answers: the connection without its credential, which no read ever returns. */
export interface ConnectionView {
    id: string;
    provider: string;
    credential: ConnectionCredential;
    /** `personal` belongs to one member; `legacy-org` is a pre-094 shared connection, bindable only by id. */
    ownership: 'personal' | 'legacy-org';
    /** `self` for the caller's own connection; null for a legacy org one. */
    principal: 'self' | null;
    site: string;
    account: string;
    access: ConnectionAccess;
    status: ConnectionStatus;
    createdAt: string;
}

export type ConnectionAccess = 'read' | 'write';
export type ConnectionCredential = 'legacy_api_token' | 'oauth_grant';
export type ConnectionStatus = 'active' | 'disconnected';

export interface NewConnection {
    ownerUserId: string | null;
    site: string;
    cloudId: string;
    email: string;
    apiToken: string;
    access: ConnectionAccess;
}

export interface ConnectionStore {
    /** The caller's active personal connections plus the org's active legacy ones, newest first. */
    list(userId: string): Promise<ConnectionView[]>;
    /** Creates a legacy API-token connection: personal when `ownerUserId` is set, else a legacy org one. */
    create(input: NewConnection): Promise<ConnectionView>;
    /** The caller's own active connections for `provider`, newest first: the only default candidates. */
    candidates(userId: string, provider: string): Promise<ConnectionView[]>;
    /** True when `userId` may select the connection for a task: org-owned in this org, or their own. */
    authorizedFor(userId: string, connectionId: string): Promise<boolean>;
    /** The connection a task injects when it names none: the user's newest own, else the org's newest. */
    defaultFor(userId: string): Promise<string | null>;
    /**
     * Disconnects an org-owned legacy connection (`admin`) or the caller's own: the row stays, its token is
     * scrubbed, and a grant left with no active connection is revoked. False when neither matches.
     */
    disconnect(connectionId: string, actor: { userId: string; admin: boolean }): Promise<boolean>;
}

interface Row {
    id: string;
    provider: string;
    credential: ConnectionCredential;
    site: string;
    email: string;
    external_account_id: string | null;
    access: ConnectionAccess;
    principal_user_id: string | null;
    status: ConnectionStatus;
    created_at: Date;
}

const toView = (row: Row): ConnectionView => ({
    id: row.id,
    provider: row.provider,
    credential: row.credential,
    ownership: row.principal_user_id === null ? 'legacy-org' : 'personal',
    principal: row.principal_user_id === null ? null : 'self',
    site: row.site,
    account: row.external_account_id ?? row.email,
    access: row.access,
    status: row.status,
    createdAt: row.created_at.toISOString(),
});

export function createConnectionStore({
    sql,
    orgId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown> | undefined;
}): ConnectionStore {
    const gate = async () => {
        if (ready) await ready;
    };
    return {
        async list(userId) {
            await gate();
            const rows = await sql<Row[]>`
                select id, provider, credential, site, email, external_account_id, access, principal_user_id, status,
                       created_at
                from connector_connection
                where org_id = ${orgId} and status = 'active'
                  and (principal_user_id = ${userId} or (principal_user_id is null and credential = 'legacy_api_token'))
                order by created_at desc
            `;
            return rows.map(toView);
        },
        async create(input) {
            await gate();
            const rows = await sql<Row[]>`
                insert into connector_connection
                    (org_id, owner_user_id, kind, site, cloud_id, email, api_token, access, provider, credential,
                     principal_user_id, external_account_id)
                values (${orgId}, ${input.ownerUserId}, 'jira', ${input.site}, ${input.cloudId}, ${input.email},
                        ${input.apiToken}, ${input.access}, 'jira', 'legacy_api_token', ${input.ownerUserId},
                        ${input.email})
                returning id, provider, credential, site, email, external_account_id, access, principal_user_id,
                          status, created_at
            `;
            return toView(rows[0]!);
        },
        async candidates(userId, provider) {
            await gate();
            const rows = await sql<Row[]>`
                select id, provider, credential, site, email, external_account_id, access, principal_user_id, status,
                       created_at
                from connector_connection
                where org_id = ${orgId} and status = 'active' and provider = ${provider}
                  and principal_user_id = ${userId}
                order by created_at desc, id
            `;
            return rows.map(toView);
        },
        async authorizedFor(userId, connectionId) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                select id from connector_connection
                where id = ${connectionId} and org_id = ${orgId} and status = 'active'
                  and (owner_user_id is null or owner_user_id = ${userId})
            `;
            return rows.length > 0;
        },
        async defaultFor(userId) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                select id from connector_connection
                where org_id = ${orgId} and status = 'active' and (owner_user_id is null or owner_user_id = ${userId})
                order by owner_user_id is null, created_at desc, id
                limit 1
            `;
            return rows[0]?.id ?? null;
        },
        async disconnect(connectionId, { userId, admin }) {
            await gate();
            return sql.begin(async (tx) => {
                const rows = await tx<{ grant_id: string | null }[]>`
                    update connector_connection
                    set status = 'disconnected', disconnected_at = now(), api_token = null
                    where id = ${connectionId} and org_id = ${orgId} and status = 'active'
                      and (principal_user_id = ${userId}
                           or (principal_user_id is null and credential = 'legacy_api_token' and ${admin}))
                    returning grant_id
                `;
                if (rows.length === 0) return false;
                const grantId = rows[0]!.grant_id;
                if (grantId !== null) await revokeGrantIfOrphaned(tx, orgId, grantId);
                return true;
            });
        },
    };
}

/** Why the proxy refused a call — each one names what the member fixes. */
export type ConnectionRefusal = 'lease' | 'unselected' | 'revoked';

export type LiveConnection =
    | { ok: true; cloudId: string; email: string; apiToken: string; access: ConnectionAccess }
    | { ok: false; reason: ConnectionRefusal };

export type ConnectionOfLease = (jobId: string, leaseToken: string) => Promise<LiveConnection>;

interface LiveRow {
    selected: string | null;
    owner_user_id: string | null;
    author: string | null;
    cloud_id: string | null;
    email: string | null;
    api_token: string | null;
    access: ConnectionAccess | null;
    author_is_member: boolean | null;
}

/**
 * The proxy's per-call check, org-less like `createOrgOfLease` (the pair names the org) but
 * deliberately WITHOUT its tail grace: a connector call is live work, so the attempt must be
 * unfinished, unexpired and not asked to stop. A reclaim or retry rotates the lease token, so a
 * superseded attempt's pair resolves nothing. The connection is the thread ROOT's selection,
 * re-authorized now: the root's author must still be a member of the org, and a personal
 * connection must be theirs — deleting the connection or removing the author ends access on the
 * next call.
 */
export function createConnectionOfLease({
    sql,
    ready,
}: {
    sql: Sql;
    ready?: Promise<unknown> | undefined;
}): ConnectionOfLease {
    return async (jobId, leaseToken) => {
        if (ready) await ready;
        const rows = await sql<LiveRow[]>`
            select root.jira_connection_id as selected, c.owner_user_id, root.created_by as author,
                   c.cloud_id, c.email, c.api_token, c.access,
                   exists (
                       select 1 from org_membership m
                       where m.org_id = j.org_id and m.user_id = root.created_by
                   ) as author_is_member
            from job j
            join job root on root.org_id = j.org_id and root.id = j.root_job_id
            left join connector_connection c on c.id = root.jira_connection_id and c.org_id = j.org_id
                                              and c.status = 'active'
            where j.id = ${jobId} and j.lease_token = ${leaseToken}
              and j.finished_at is null and j.lease_expires_at > now() and j.cancel_requested_at is null
        `;
        const row = rows[0];
        if (!row) return { ok: false, reason: 'lease' };
        if (row.selected === null && row.cloud_id === null) return { ok: false, reason: 'unselected' };
        if (row.cloud_id === null || row.email === null || row.api_token === null || row.access === null) {
            return { ok: false, reason: 'revoked' };
        }
        // The task's author must still be a member whichever way the connection is owned, and a
        // personal connection must be the author's own.
        const ownedByAuthor = row.owner_user_id === null || row.owner_user_id === row.author;
        if (!ownedByAuthor || !row.author_is_member) return { ok: false, reason: 'revoked' };
        return { ok: true, cloudId: row.cloud_id, email: row.email, apiToken: row.api_token, access: row.access };
    };
}
