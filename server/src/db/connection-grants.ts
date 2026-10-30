import type { Sql, TransactionSql } from 'postgres';
import type { SecretIdentity } from '../secrets/secret-store.js';

/**
 * Integration grants (094, 096): the credential lineage of one external account. A connection is a principal's
 * usable resource under a grant; the grant owns the refresh chain (`version`) and the SecretStore record named by
 * `secret_ref`. These are store primitives only: no SecretStore call happens here. The lineage module
 * (`integrations/grant-lineage.ts`) takes the claim, talks to the SecretStore and then calls `finalize`, the only
 * writer of a grant's credential columns once it holds the claim. A `service` principal is reserved for BEL-143.
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
    /** The provider's resource: `id` is the connection's `cloud_id` and `label` its `site`. */
    resource: { id: string; label: string };
    email?: string;
    access: 'read' | 'write';
    /**
     * A NEW grant is inserted under this pre-allocated ID with the secret it already holds, so the secret exists
     * before the grant or its connection is visible. An existing grant of the account is reused and these are ignored.
     */
    grantId?: string;
    secretRef?: string;
    secretVersion?: string;
}

export type AttachRefusal = Extract<AttachResult, { ok: false }>['reason'];

export type AttachResult =
    | { ok: true; grant: IntegrationGrant; connectionId: string }
    | { ok: false; reason: 'grant-conflict' | 'service-principal-unsupported' | 'duplicate-connection' };

export type LineageKind = 'refresh' | 'reconsent' | 'destroy';

/** What a claim-guarded finalize writes. `destroy` clears the secret and leaves `version` and `authority` alone. */
export type FinalizeInput =
    | { kind: 'refresh' | 'reconsent'; secretVersion: string; authority: Record<string, unknown> }
    | { kind: 'destroy' };

export type FinalizeResult = { ok: true; version: number } | { ok: false; reason: 'claim-lost' };

export interface ReconnectInput {
    externalAccountId: string;
    /** The `reconsent` claim this reconnect holds. */
    claimToken: string;
    secretVersion: string;
    authority?: Record<string, unknown> | undefined;
}

export type ReconnectResult =
    | { ok: true; version: number }
    | { ok: false; reason: 'not-found' | 'account-mismatch' | 'revoked' | 'claim-lost' };

export interface ConnectionGrants {
    /** Upserts the grant by `(provider, externalAccountId)` and adds an active connection under it. */
    attachGrantConnection(input: AttachGrantConnection): Promise<AttachResult>;
    /** Ends a lineage claim by kind; applies only while `claimToken` is still the grant's claim. */
    finalize(grantId: string, claimToken: string, input: FinalizeInput): Promise<FinalizeResult>;
    /** Checks a connection's grant is under the same external account, then ends the held `reconsent` claim. */
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

/** One grant of `orgId`, or null: a confirmed absence. A thrown query is not an absence and propagates. */
export async function readGrant(
    db: Sql | TransactionSql,
    orgId: string,
    grantId: string
): Promise<IntegrationGrant | null> {
    const rows = await db<GrantRow[]>`
        select ${db.unsafe(grantColumns())} from integration_grant where id = ${grantId} and org_id = ${orgId}
    `;
    return rows[0] ? toGrant(rows[0]) : null;
}

/**
 * The one statement that ends a lineage claim with new credentials, by kind, and clears every `lineage_*` column.
 * It holds no lock beyond the grant row it updates and applies only while `claimToken` is still the grant's claim.
 *  - `refresh` leaves `status` alone: a concurrent `revoked` stays, and destroy deletes at the new version.
 *  - `reconsent` restores `active` (a reconnected grant serves again) but never resurrects a concurrent `revoked`,
 *    and moves the grant onto the reference its claim recorded (a fresh one when the old was wedged). It records the
 *    claim token as `lineage_finalized_claim`, which an authorization settles from.
 *  - `destroy` records the confirmed delete: no version, no authority change, no `version` bump.
 */
export async function finalizeLineage(
    db: Sql | TransactionSql,
    claim: { orgId: string; grantId: string; token: string },
    input: FinalizeInput
): Promise<FinalizeResult> {
    const { orgId, grantId, token: claimToken } = claim;
    const rows =
        input.kind === 'destroy'
            ? await db<{ version: string }[]>`
                update integration_grant
                set secret_version = null, secret_destroyed_at = now(), updated_at = now(),
                    lineage_claim = null, lineage_claim_kind = null, lineage_claim_expires_at = null,
                    lineage_operation_id = null, lineage_secret_ref = null
                where id = ${grantId} and org_id = ${orgId} and lineage_claim = ${claimToken}
                  and lineage_claim_kind = 'destroy'
                returning version
            `
            : input.kind === 'refresh'
              ? await db<{ version: string }[]>`
                update integration_grant
                set version = version + 1, secret_version = ${input.secretVersion},
                    authority = ${db.json(input.authority as never)}, updated_at = now(),
                    lineage_claim = null, lineage_claim_kind = null, lineage_claim_expires_at = null,
                    lineage_operation_id = null, lineage_secret_ref = null
                where id = ${grantId} and org_id = ${orgId} and lineage_claim = ${claimToken}
                  and lineage_claim_kind = 'refresh'
                returning version
            `
              : await db<{ version: string }[]>`
                update integration_grant
                set version = version + 1, secret_version = ${input.secretVersion},
                    secret_ref = coalesce(lineage_secret_ref, secret_ref),
                    authority = ${db.json(input.authority as never)},
                    status = case when status = 'revoked' then 'revoked' else 'active' end,
                    secret_wedged_at = null, secret_destroyed_at = null, updated_at = now(),
                    lineage_finalized_claim = ${claimToken},
                    lineage_claim = null, lineage_claim_kind = null, lineage_claim_expires_at = null,
                    lineage_operation_id = null, lineage_secret_ref = null
                where id = ${grantId} and org_id = ${orgId} and lineage_claim = ${claimToken}
                  and lineage_claim_kind = 'reconsent'
                returning version
            `;
    return rows[0] ? { ok: true, version: Number(rows[0].version) } : { ok: false, reason: 'claim-lost' };
}

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

/** The refusal a unique violation of an attach means, or null for any other error (which the caller rethrows). */
export function attachRefusalOf(error: unknown): AttachRefusal | null {
    if (!isUniqueViolation(error)) return null;
    const detail = (error as { constraint_name?: string }).constraint_name ?? '';
    return detail === 'connector_connection_grant_resource_uk' ? 'duplicate-connection' : 'grant-conflict';
}

/**
 * Upserts the grant by `(provider, externalAccountId)` and adds an active connection under it, inside the caller's
 * transaction. A unique violation propagates: `attachRefusalOf` names it. The `kind` column is the 054 rollout
 * column (`'jira'` only); the contract release drops it, so every connection carries it until then.
 */
export async function attachInTx(
    tx: TransactionSql,
    orgId: string,
    input: AttachGrantConnection
): Promise<AttachResult> {
    if (input.principal.kind !== 'user') return { ok: false, reason: 'service-principal-unsupported' };
    const userId = input.principal.userId;
    const existing = await tx<GrantRow[]>`
        select ${tx.unsafe(grantColumns())} from integration_grant
        where provider = ${input.provider} and external_account_id = ${input.externalAccountId}
          and status <> 'revoked'
        for update
    `;
    let grant: IntegrationGrant;
    if (existing[0]) {
        grant = toGrant(existing[0]);
        if (grant.orgId !== orgId || grant.principalUserId !== userId) return { ok: false, reason: 'grant-conflict' };
    } else {
        const created = await tx<GrantRow[]>`
            insert into integration_grant
                (id, org_id, principal_kind, principal_user_id, provider, external_account_id, authority,
                 secret_ref, secret_version)
            values (coalesce(${input.grantId ?? null}::uuid, gen_random_uuid()), ${orgId}, 'user', ${userId},
                    ${input.provider}, ${input.externalAccountId}, ${tx.json(input.authority as never)},
                    ${input.secretRef ?? null}, ${input.secretVersion ?? null})
            returning ${tx.unsafe(grantColumns())}
        `;
        grant = toGrant(created[0]!);
    }
    const [connection] = await tx<{ id: string }[]>`
        insert into connector_connection
            (org_id, owner_user_id, kind, site, cloud_id, email, api_token, access, provider,
             credential, principal_user_id, external_account_id, grant_id)
        values (${orgId}, ${userId}, 'jira', ${input.resource.label}, ${input.resource.id},
                ${input.email ?? input.externalAccountId}, null, ${input.access},
                ${input.provider}, 'oauth_grant', ${userId}, ${input.externalAccountId}, ${grant.id})
        returning id
    `;
    return { ok: true, grant, connectionId: connection!.id };
}

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
            try {
                return await sql.begin((tx) => attachInTx(tx, orgId, input));
            } catch (error) {
                // Two attaches racing on the same new account, or the same resource twice under one grant.
                const refusal = attachRefusalOf(error);
                if (refusal) return { ok: false, reason: refusal };
                throw error;
            }
        },

        async finalize(grantId, claimToken, input) {
            await gate();
            return finalizeLineage(sql, { orgId, grantId, token: claimToken }, input);
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
                return finalizeLineage(
                    tx,
                    { orgId, grantId: grant.id, token: input.claimToken },
                    {
                        kind: 'reconsent',
                        secretVersion: input.secretVersion,
                        authority: input.authority ?? grant.authority,
                    }
                );
            });
        },

        async revokeIfOrphaned(grantId) {
            await gate();
            return sql.begin((tx) => revokeGrantIfOrphaned(tx, orgId, grantId));
        },
    };
}
