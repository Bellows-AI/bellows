import type { Sql, TransactionSql } from 'postgres';
import { lockThreadRootInTx, projectJiraConnectionInTx } from './connection-bindings.js';
import { revokeGrantIfOrphaned } from './connection-grants.js';

const DISCONNECT_ATTEMPTS = 5;

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
    /**
     * Disconnects an org-owned legacy connection (`admin`) or the caller's own: the row stays, its token is
     * scrubbed, and a grant left with no active connection is revoked. `disconnected` is false when neither matches.
     * `revokedGrantId` names the grant this call revoked, so the caller can destroy its secret after the commit.
     */
    disconnect(connectionId: string, actor: { userId: string; admin: boolean }): Promise<DisconnectResult>;
}

export interface DisconnectResult {
    disconnected: boolean;
    revokedGrantId: string | null;
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

/** Thrown inside the disconnect transaction (rolling it back) when a bind added a root after the roots were locked. */
class RetryDisconnect extends Error {}

/** One disconnect attempt. */
async function disconnectOnce(
    tx: TransactionSql,
    orgId: string,
    connectionId: string,
    { userId, admin }: { userId: string; admin: boolean }
): Promise<DisconnectResult> {
    const rootsOf = async (): Promise<string[]> =>
        (
            await tx<{ root_job_id: string }[]>`
                select distinct root_job_id from job_connection_binding
                where org_id = ${orgId} and connection_id = ${connectionId}
                order by root_job_id
            `
        ).map((row) => row.root_job_id);
    const roots = await rootsOf();
    for (const root of roots) await lockThreadRootInTx(tx, orgId, root);
    await tx`
        select g.id from integration_grant g
        join connector_connection c on c.grant_id = g.id
        where c.id = ${connectionId} and c.org_id = ${orgId} and g.org_id = ${orgId}
        for update of g
    `;
    const rows = await tx<{ grant_id: string | null }[]>`
        update connector_connection
        set status = 'disconnected', disconnected_at = now(), api_token = null
        where id = ${connectionId} and org_id = ${orgId} and status = 'active'
          and (principal_user_id = ${userId}
               or (principal_user_id is null and credential = 'legacy_api_token' and ${admin}))
        returning grant_id
    `;
    if (rows.length === 0) return { disconnected: false, revokedGrantId: null };
    if ((await rootsOf()).some((root) => !roots.includes(root))) throw new RetryDisconnect();
    const grantId = rows[0]!.grant_id;
    const revoked = grantId !== null && (await revokeGrantIfOrphaned(tx, orgId, grantId));
    // Old pods read the root's projection: recompute it wherever this connection was bound.
    for (const root of roots) await projectJiraConnectionInTx(tx, orgId, root);
    return { disconnected: true, revokedGrantId: revoked ? grantId : null };
}

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
        async disconnect(connectionId, { userId, admin }) {
            await gate();
            // Lock order (see `lockThreadRootInTx`): each bound root's row then advisory lock in ascending root
            // order, then the grant, then the connection (a bind share-locks it after its thread lock). A bind that commits a new root between the root read and the
            // update is seen after it and the transaction retries with that root locked too.
            for (let attempt = 0; attempt < DISCONNECT_ATTEMPTS; attempt += 1) {
                try {
                    return await sql.begin((tx) => disconnectOnce(tx, orgId, connectionId, { userId, admin }));
                } catch (error) {
                    if (!(error instanceof RetryDisconnect)) throw error;
                }
            }
            throw new Error('disconnect: bindings kept changing');
        },
    };
}

/** Why the proxy refused a call — each one names what the member fixes. */
export type ConnectionRefusal = 'lease' | 'unselected' | 'revoked' | 'ambiguous';

export type LiveConnection =
    | { ok: true; cloudId: string; email: string; apiToken: string; access: ConnectionAccess }
    | { ok: false; reason: ConnectionRefusal };

export type ConnectionOfLease = (jobId: string, leaseToken: string) => Promise<LiveConnection>;

/** One binding of the thread, with its connection's current row (all null once the connection is hard-deleted). */
interface LiveRow {
    binding_id: string | null;
    frozen_account: string | null;
    connection_id: string | null;
    status: ConnectionStatus | null;
    principal_user_id: string | null;
    account: string | null;
    execution_user_id: string | null;
    cloud_id: string | null;
    email: string | null;
    api_token: string | null;
    access: ConnectionAccess | null;
    executor_is_member: boolean;
}

type LiveRowOf = LiveRow & { cloud_id: string; email: string; api_token: string; access: ConnectionAccess };

/** Fail closed: a present row with any field the credential needs missing sends nothing. */
function servable(row: LiveRow): row is LiveRowOf {
    if (row.cloud_id === null || row.email === null || row.api_token === null || row.access === null) return false;
    // The execution user must still be a member, whichever way the connection is owned, and a personal
    // connection must be theirs.
    if (row.execution_user_id === null || !row.executor_is_member) return false;
    if (row.principal_user_id !== null && row.principal_user_id !== row.execution_user_id) return false;
    // The identity frozen at bind time must still be the connection's.
    return row.frozen_account !== null && row.frozen_account === row.account;
}

/**
 * The proxy's per-call check, org-less like `createOrgOfLease` (the pair names the org) but
 * deliberately WITHOUT its tail grace: a connector call is live work, so the attempt must be
 * unfinished, unexpired and not asked to stop. A reclaim or retry rotates the lease token, so a
 * superseded attempt's pair resolves nothing, and a reviewer row's lease gets nothing (as in
 * `github-credential.ts`). The connection is the thread ROOT's live jira binding, re-authorized now:
 * the root's execution user must still be a member, a personal connection must be theirs, and the
 * account frozen at bind time must still be the connection's. Disconnecting the connection or
 * removing the user ends access on the next call. Nothing in the request names a connection.
 *
 * A SQL throw propagates (the route answers 5xx); "no binding" is `unselected` only when the lease
 * predicate held and the thread has no jira binding at all.
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
            select b.id as binding_id, b.external_account_id as frozen_account, c.id as connection_id, c.status,
                   c.principal_user_id, c.external_account_id as account, root.execution_user_id,
                   c.cloud_id, c.email, c.api_token, c.access,
                   exists (
                       select 1 from org_membership m
                       where m.org_id = j.org_id and m.user_id = root.execution_user_id
                   ) as executor_is_member
            from job j
            join job root on root.org_id = j.org_id and root.id = j.root_job_id
            left join job_connection_binding b on b.org_id = j.org_id and b.root_job_id = j.root_job_id
                                              and b.provider = 'jira' and b.credential = 'legacy_api_token'
            left join connector_connection c on c.id = b.connection_id and c.org_id = j.org_id
            where j.id = ${jobId} and j.lease_token = ${leaseToken} and j.review_of is null
              and j.finished_at is null and j.lease_expires_at > now() and j.cancel_requested_at is null
        `;
        if (rows.length === 0) return { ok: false, reason: 'lease' };
        const bound = rows.filter((row) => row.binding_id !== null);
        if (bound.length === 0) return { ok: false, reason: 'unselected' };
        const live = bound.filter((row) => row.connection_id !== null && row.status === 'active');
        if (live.length > 1) return { ok: false, reason: 'ambiguous' };
        const row = live[0];
        if (!row || !servable(row)) return { ok: false, reason: 'revoked' };
        return { ok: true, cloudId: row.cloud_id, email: row.email, apiToken: row.api_token, access: row.access };
    };
}
