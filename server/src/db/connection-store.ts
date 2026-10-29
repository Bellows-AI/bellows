import type { Sql, TransactionSql } from 'postgres';
import { lockThreadRootInTx, projectJiraConnectionInTx } from './connection-bindings.js';
import { revokeGrantIfOrphaned } from './connection-grants.js';

const DISCONNECT_ATTEMPTS = 5;

/** What a list answers: the connection without its credential, which no read ever returns. */
export interface ConnectionView {
    id: string;
    provider: string;
    credential: ConnectionCredential;
    /** Every connection belongs to one member. */
    ownership: 'personal';
    principal: 'self';
    site: string;
    account: string;
    access: ConnectionAccess;
    status: ConnectionStatus;
    createdAt: string;
}

export type ConnectionAccess = 'read' | 'write';
export type ConnectionCredential = 'oauth_grant';
export type ConnectionStatus = 'active' | 'disconnected';

export interface ConnectionStore {
    /** The caller's active OAuth connections, newest first. */
    list(userId: string): Promise<ConnectionView[]>;
    /** The caller's own active connections for `provider`, newest first: the only default candidates. */
    candidates(userId: string, provider: string): Promise<ConnectionView[]>;
    /**
     * Disconnects the caller's own connection: the row stays and a grant left with no active connection is revoked.
     * `disconnected` is false when it is not theirs. An admin has no more reach than a member.
     * `revokedGrantId` names the grant this call revoked, so the caller can destroy its secret after the commit.
     */
    disconnect(connectionId: string, actor: { userId: string }): Promise<DisconnectResult>;
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
    access: ConnectionAccess;
    status: ConnectionStatus;
    created_at: Date;
}

const toView = (row: Row): ConnectionView => ({
    id: row.id,
    provider: row.provider,
    credential: row.credential,
    ownership: 'personal',
    principal: 'self',
    site: row.site,
    // An OAuth row's email column carries the account label; the external id is an opaque provider id.
    account: row.email,
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
    { userId }: { userId: string }
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
          and credential = 'oauth_grant' and principal_user_id = ${userId}
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
                select id, provider, credential, site, email, access, status, created_at
                from connector_connection
                where org_id = ${orgId} and status = 'active' and credential = 'oauth_grant'
                  and principal_user_id = ${userId}
                order by created_at desc
            `;
            return rows.map(toView);
        },
        async candidates(userId, provider) {
            await gate();
            const rows = await sql<Row[]>`
                select id, provider, credential, site, email, access, status, created_at
                from connector_connection
                where org_id = ${orgId} and status = 'active' and provider = ${provider}
                  and credential = 'oauth_grant' and principal_user_id = ${userId}
                order by created_at desc, id
            `;
            return rows.map(toView);
        },
        async disconnect(connectionId, { userId }) {
            await gate();
            // Lock order (see `lockThreadRootInTx`): each bound root's row then advisory lock in ascending root
            // order, then the grant, then the connection (a bind share-locks it after its thread lock). A bind that commits a new root between the root read and the
            // update is seen after it and the transaction retries with that root locked too.
            for (let attempt = 0; attempt < DISCONNECT_ATTEMPTS; attempt += 1) {
                try {
                    return await sql.begin((tx) => disconnectOnce(tx, orgId, connectionId, { userId }));
                } catch (error) {
                    if (!(error instanceof RetryDisconnect)) throw error;
                }
            }
            throw new Error('disconnect: bindings kept changing');
        },
    };
}
