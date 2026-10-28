import type { Sql, TransactionSql } from 'postgres';
import type { SecretIdentity } from '../secrets/secret-store.js';

/**
 * Integration grants (094): the credential lineage of one external account. A connection is a principal's
 * usable resource under a grant; the grant owns the refresh chain (`version`, CAS) and, once BEL-138/61 land,
 * the SecretStore record named by `secret_ref`. These are store primitives only: no SecretStore write happens
 * here, and a `service` principal is reserved for BEL-143.
 */

export type GrantStatus = 'active' | 'reconnect_required' | 'revoked';

export interface IntegrationGrant {
    id: string;
    orgId: string;
    principalUserId: string;
    provider: string;
    externalAccountId: string;
    authority: Record<string, unknown>;
    secretRef: string | null;
    secretVersion: string | null;
    status: GrantStatus;
    version: number;
}

/**
 * The identity is rebuilt from the grant on every call and never stored, so a reference copied to another
 * grant, user or organization fails as `identity-mismatch`. It keys the grant, never a connection.
 */
export function grantSecretIdentity(grant: Pick<IntegrationGrant, 'id' | 'orgId' | 'principalUserId'>): SecretIdentity {
    return {
        owner: { kind: 'user', userId: grant.principalUserId, orgId: grant.orgId },
        scope: { type: 'integration-grant', id: grant.id },
        purpose: 'connection-grant',
        owningRecord: { type: 'integration-grant', id: grant.id },
    };
}

export type GrantPrincipal = { kind: 'user'; userId: string } | { kind: 'service'; serviceId: string };

export interface AttachGrantConnection {
    principal: GrantPrincipal;
    provider: string;
    externalAccountId: string;
    authority: Record<string, unknown>;
    connection: { site: string; cloudId: string; email?: string; access: 'read' | 'write' };
}

export type AttachResult =
    | { ok: true; grant: IntegrationGrant; connectionId: string }
    | { ok: false; reason: 'grant-conflict' | 'service-principal-unsupported' | 'duplicate-connection' };

export interface RotateInput {
    secretVersion: string;
    secretRef?: string | undefined;
    authority?: Record<string, unknown> | undefined;
}

export type RotateResult = { ok: true; version: number } | { ok: false; reason: 'stale' | 'not-found' | 'revoked' };

export interface ReconnectInput extends RotateInput {
    externalAccountId: string;
}

export type ReconnectResult =
    | { ok: true; version: number }
    | { ok: false; reason: 'not-found' | 'account-mismatch' | 'revoked' };

export interface ConnectionGrants {
    /** Upserts the grant by `(provider, externalAccountId)` and adds an active connection under it. */
    attachGrantConnection(input: AttachGrantConnection): Promise<AttachResult>;
    /** Advances the grant iff `expectedVersion` is still current; exactly one of two racers wins. */
    rotate(grantId: string, expectedVersion: number, input: RotateInput): Promise<RotateResult>;
    /** Re-authorizes a connection's grant under the same external account, else changes nothing. */
    reconnect(connectionId: string, actor: { userId: string }, input: ReconnectInput): Promise<ReconnectResult>;
    /** Revokes the grant when no active connection references it; true when it did. */
    revokeIfOrphaned(grantId: string): Promise<boolean>;
}

interface GrantRow {
    id: string;
    org_id: string;
    principal_user_id: string;
    provider: string;
    external_account_id: string;
    authority: Record<string, unknown>;
    secret_ref: string | null;
    secret_version: string | null;
    status: GrantStatus;
    version: string;
}

const grantColumns = (alias = ''): string =>
    [
        'id',
        'org_id',
        'principal_user_id',
        'provider',
        'external_account_id',
        'authority',
        'secret_ref',
        'secret_version',
        'status',
        'version',
    ]
        .map((column) => `${alias}${column}`)
        .join(', ');

const toGrant = (row: GrantRow): IntegrationGrant => ({
    id: row.id,
    orgId: row.org_id,
    principalUserId: row.principal_user_id,
    provider: row.provider,
    externalAccountId: row.external_account_id,
    authority: row.authority,
    secretRef: row.secret_ref,
    secretVersion: row.secret_version,
    status: row.status,
    version: Number(row.version),
});

/**
 * Revokes `grantId` when no active connection references it. Shared with `connection-store.disconnect`, which
 * runs it in the disconnect's own transaction. The grant's row lock serializes two last-connection disconnects.
 */
export async function revokeGrantIfOrphaned(
    tx: Sql | TransactionSql,
    orgId: string,
    grantId: string
): Promise<boolean> {
    // Row lock first, orphan check in a LATER statement: READ COMMITTED gives that statement a fresh snapshot.
    await tx`select id from integration_grant where id = ${grantId} and org_id = ${orgId} for update`;
    const rows = await tx<{ id: string }[]>`
        update integration_grant set status = 'revoked', revoked_at = now(), updated_at = now()
        where id = ${grantId} and org_id = ${orgId} and status <> 'revoked'
          and not exists (
              select 1 from connector_connection c where c.grant_id = integration_grant.id and c.status = 'active'
          )
        returning id
    `;
    return rows.length > 0;
}

// Lock order: never lock a connection row before its grant (the thread root and advisory locks come before both).
const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION;

export function createConnectionGrants({
    sql,
    orgId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown> | undefined;
}): ConnectionGrants {
    const gate = async () => {
        if (ready) await ready;
    };

    return {
        async attachGrantConnection(input) {
            await gate();
            if (input.principal.kind !== 'user') return { ok: false, reason: 'service-principal-unsupported' };
            const userId = input.principal.userId;
            try {
                return await sql.begin(async (tx): Promise<AttachResult> => {
                    const existing = await tx<GrantRow[]>`
                        select ${tx.unsafe(grantColumns())} from integration_grant
                        where provider = ${input.provider} and external_account_id = ${input.externalAccountId}
                          and status <> 'revoked'
                        for update
                    `;
                    let grant: IntegrationGrant;
                    if (existing[0]) {
                        grant = toGrant(existing[0]);
                        if (grant.orgId !== orgId || grant.principalUserId !== userId) {
                            return { ok: false, reason: 'grant-conflict' };
                        }
                    } else {
                        const created = await tx<GrantRow[]>`
                            insert into integration_grant
                                (org_id, principal_kind, principal_user_id, provider, external_account_id, authority)
                            values (${orgId}, 'user', ${userId}, ${input.provider}, ${input.externalAccountId},
                                    ${tx.json(input.authority as never)})
                            returning ${tx.unsafe(grantColumns())}
                        `;
                        grant = toGrant(created[0]!);
                    }
                    const [connection] = await tx<{ id: string }[]>`
                        insert into connector_connection
                            (org_id, owner_user_id, kind, site, cloud_id, email, api_token, access, provider,
                             credential, principal_user_id, external_account_id, grant_id)
                        values (${orgId}, ${userId}, 'jira', ${input.connection.site}, ${input.connection.cloudId},
                                ${input.connection.email ?? input.externalAccountId}, null, ${input.connection.access},
                                ${input.provider}, 'oauth_grant', ${userId}, ${input.externalAccountId}, ${grant.id})
                        returning id
                    `;
                    return { ok: true, grant, connectionId: connection!.id };
                });
            } catch (error) {
                // Two attaches racing on the same new account, or the same resource twice under one grant.
                if (isUniqueViolation(error)) {
                    const detail = (error as { constraint_name?: string }).constraint_name ?? '';
                    return {
                        ok: false,
                        reason:
                            detail === 'connector_connection_grant_resource_uk'
                                ? 'duplicate-connection'
                                : 'grant-conflict',
                    };
                }
                throw error;
            }
        },

        async rotate(grantId, expectedVersion, input) {
            await gate();
            const rows = await sql<{ version: string }[]>`
                update integration_grant
                set version = version + 1, secret_version = ${input.secretVersion},
                    secret_ref = coalesce(${input.secretRef ?? null}, secret_ref),
                    authority = coalesce(${input.authority ? sql.json(input.authority as never) : null}, authority),
                    status = 'active', updated_at = now()
                where id = ${grantId} and org_id = ${orgId} and version = ${expectedVersion} and status <> 'revoked'
                returning version
            `;
            if (rows[0]) return { ok: true, version: Number(rows[0].version) };
            const current = await sql<{ status: GrantStatus }[]>`
                select status from integration_grant where id = ${grantId} and org_id = ${orgId}
            `;
            if (!current[0]) return { ok: false, reason: 'not-found' };
            return { ok: false, reason: current[0].status === 'revoked' ? 'revoked' : 'stale' };
        },

        async reconnect(connectionId, actor, input) {
            await gate();
            return sql.begin(async (tx): Promise<ReconnectResult> => {
                const rows = await tx<GrantRow[]>`
                    select ${tx.unsafe(grantColumns('g.'))}
                    from connector_connection c
                    join integration_grant g on g.id = c.grant_id and g.org_id = c.org_id
                    where c.id = ${connectionId} and c.org_id = ${orgId} and c.status = 'active'
                      and c.credential = 'oauth_grant' and c.principal_user_id = ${actor.userId}
                    for update of g
                `;
                const grant = rows[0];
                if (!grant) return { ok: false, reason: 'not-found' };
                if (grant.status === 'revoked') return { ok: false, reason: 'revoked' };
                if (grant.external_account_id !== input.externalAccountId) {
                    return { ok: false, reason: 'account-mismatch' };
                }
                const [rotated] = await tx<{ version: string }[]>`
                    update integration_grant
                    set version = version + 1, secret_version = ${input.secretVersion},
                        secret_ref = coalesce(${input.secretRef ?? null}, secret_ref),
                        authority = coalesce(${input.authority ? tx.json(input.authority as never) : null}, authority),
                        status = 'active', updated_at = now()
                    where id = ${grant.id}
                    returning version
                `;
                return { ok: true, version: Number(rotated!.version) };
            });
        },

        async revokeIfOrphaned(grantId) {
            await gate();
            return sql.begin((tx) => revokeGrantIfOrphaned(tx, orgId, grantId));
        },
    };
}
