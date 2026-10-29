import type { Sql, TransactionSql } from 'postgres';
import { type AttachGrantConnection, attachInTx, attachRefusalOf } from '../db/connection-grants.js';
import type { AuthorizationFailure, CompleteFailure } from './authorization-types.js';

/**
 * SQL for `integration_authorization` (096). Every transition is one guarded statement, so two racers, a late
 * recovery and a crashed holder each find the row exactly as the last winner left it. Lock order: the authorization
 * row, then the grant, then the connection (docs/connections.md).
 */

export interface AuthorizationRow {
    id: string;
    userId: string;
    provider: string;
    intent: 'connect' | 'reconnect';
    connectionId: string | null;
    grantId: string | null;
    grantClaim: string | null;
    expectedAccountId: string | null;
    interactionId: string | null;
    returnTo: string;
    status: 'pending' | 'exchanging' | 'persisting' | 'completed' | 'failed' | 'expired';
    pendingGrantId: string | null;
    secretRef: string | null;
    secretOperationId: string | null;
    result: StoredFacts | null;
    /** The PKCE verifier as it was before consume; present only on the row `consumeAuthorization` returns. */
    verifier: string | null;
    /** The row was consumed longer ago than a holder can still be running. */
    pastLease: boolean;
    expired: boolean;
}

/** The non-secret facts a completion needs after the holder is gone. */
export interface StoredFacts {
    account: string;
    resources: { id: string; label: string }[];
    authority: { scopes: string[] };
    interactionId: string | null;
    connectionIds?: string[];
}

interface Raw {
    id: string;
    user_id: string;
    provider: string;
    intent: AuthorizationRow['intent'];
    connection_id: string | null;
    grant_id: string | null;
    grant_claim: string | null;
    expected_account_id: string | null;
    interaction_id: string | null;
    return_to: string;
    status: AuthorizationRow['status'];
    pending_grant_id: string | null;
    secret_ref: string | null;
    secret_operation_id: string | null;
    result: StoredFacts | null;
    verifier?: string | null;
    past_lease?: boolean;
    expired?: boolean;
}

const COLUMNS = `id, user_id, provider, intent, connection_id, grant_id, grant_claim, expected_account_id,
    interaction_id, return_to, status, pending_grant_id, secret_ref, secret_operation_id, result`;

const toRow = (raw: Raw): AuthorizationRow => ({
    id: raw.id,
    userId: raw.user_id,
    provider: raw.provider,
    intent: raw.intent,
    connectionId: raw.connection_id,
    grantId: raw.grant_id,
    grantClaim: raw.grant_claim,
    expectedAccountId: raw.expected_account_id,
    interactionId: raw.interaction_id,
    returnTo: raw.return_to,
    status: raw.status,
    pendingGrantId: raw.pending_grant_id,
    secretRef: raw.secret_ref,
    secretOperationId: raw.secret_operation_id,
    result: raw.result,
    verifier: raw.verifier ?? null,
    pastLease: raw.past_lease === true,
    expired: raw.expired === true,
});

export interface NewAuthorization {
    orgId: string;
    userId: string;
    provider: string;
    stateHash: string;
    verifier: string | null;
    returnTo: string;
    interactionId: string | null;
    ttlMs: number;
    reconnect: { connectionId: string; accountId: string } | null;
}

export async function insertAuthorization(
    sql: Sql,
    input: NewAuthorization
): Promise<{ id: string; expiresAt: string }> {
    const [row] = await sql<{ id: string; expires_at: Date }[]>`
        insert into integration_authorization
            (org_id, user_id, provider, intent, connection_id, expected_account_id, interaction_id, state_hash,
             pkce_verifier, return_to, expires_at)
        values (${input.orgId}, ${input.userId}, ${input.provider},
                ${input.reconnect ? 'reconnect' : 'connect'}, ${input.reconnect?.connectionId ?? null},
                ${input.reconnect?.accountId ?? null}, ${input.interactionId}, ${input.stateHash},
                ${input.verifier}, ${input.returnTo},
                now() + (${input.ttlMs}::double precision * interval '1 millisecond'))
        returning id, expires_at
    `;
    return { id: row!.id, expiresAt: row!.expires_at.toISOString() };
}

interface Owner {
    orgId: string;
    userId: string;
    stateHash: string;
}

/**
 * Consumes the row: `pending` -> `exchanging`, once, for its own user, before its time is up. The verifier is
 * returned from the row as it was and nulled by the same statement. Zero rows is `null`, classified by
 * `classifyUnconsumed`; the lock on the target row serializes two racers, and the loser sees the new status.
 */
export async function consumeAuthorization(sql: Sql, owner: Owner): Promise<AuthorizationRow | null> {
    const rows = await sql<Raw[]>`
        with target as (
            select id, pkce_verifier from integration_authorization
            where state_hash = ${owner.stateHash} and user_id = ${owner.userId} and org_id = ${owner.orgId}
              and status = 'pending' and expires_at > now()
            for update
        )
        update integration_authorization a
        set status = 'exchanging', consumed_at = now(), pkce_verifier = null
        from target t where a.id = t.id
        returning ${sql.unsafe(COLUMNS.replaceAll(/\b(\w+)\b/g, 'a.$1'))}, t.pkce_verifier as verifier
    `;
    return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Why a state was not consumed. Another user's row, an unknown state and a missing one are all `state-mismatch`
 * with no stored path, so a probe learns nothing; an own, past-time `pending` row is marked `expired` here.
 */
export async function classifyUnconsumed(
    sql: Sql,
    owner: Owner
): Promise<{ failure: CompleteFailure; returnTo: string }> {
    const expired = await sql<{ return_to: string }[]>`
        update integration_authorization
        set status = 'expired', failure = 'expired', completed_at = now(), pkce_verifier = null
        where state_hash = ${owner.stateHash} and user_id = ${owner.userId} and org_id = ${owner.orgId}
          and status = 'pending' and expires_at <= now()
        returning return_to
    `;
    if (expired[0]) return { failure: 'expired', returnTo: expired[0].return_to };
    const rows = await sql<{ return_to: string }[]>`
        select return_to from integration_authorization
        where state_hash = ${owner.stateHash} and user_id = ${owner.userId} and org_id = ${owner.orgId}
    `;
    return rows[0]
        ? { failure: 'replayed', returnTo: rows[0].return_to }
        : { failure: 'state-mismatch', returnTo: '/' };
}

export async function readAuthorization(
    sql: Sql,
    input: { orgId: string; id: string; leaseMs: number }
): Promise<AuthorizationRow | null> {
    const rows = await sql<Raw[]>`
        select ${sql.unsafe(COLUMNS)},
               (consumed_at is not null
                and consumed_at < now() - (${input.leaseMs}::double precision * interval '1 millisecond')) as past_lease,
               (expires_at <= now()) as expired
        from integration_authorization where id = ${input.id} and org_id = ${input.orgId}
    `;
    return rows[0] ? toRow(rows[0]) : null;
}

/** Ends an open transaction as failed; false when it was no longer open (someone else settled it). */
export async function failAuthorization(sql: Sql, id: string, failure: AuthorizationFailure): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        update integration_authorization
        set status = case when ${failure} = 'expired' then 'expired' else 'failed' end, failure = ${failure},
            completed_at = now(), pkce_verifier = null
        where id = ${id} and status in ('pending', 'exchanging', 'persisting')
        returning id
    `;
    return rows.length > 0;
}

/** Marks the expiry of a transaction nobody consumed. */
export const expireAuthorization = (sql: Sql, id: string): Promise<boolean> => failAuthorization(sql, id, 'expired');

/** Records the lineage claim a reconnect (or a connect that found a grant) holds, while the row is `exchanging`. */
export async function recordGrantClaim(
    sql: Sql,
    input: { id: string; grantId: string; claim: string }
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        update integration_authorization set grant_id = ${input.grantId}, grant_claim = ${input.claim}
        where id = ${input.id} and status = 'exchanging'
        returning id
    `;
    return rows.length > 0;
}

/** Records the pre-allocated grant, reference and operation BEFORE the secret is created: recovery reconciles them. */
export async function recordPersisting(
    sql: Sql,
    input: { id: string; pendingGrantId: string; secretRef: string; operationId: string; facts: StoredFacts }
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        update integration_authorization
        set status = 'persisting', pending_grant_id = ${input.pendingGrantId}, secret_ref = ${input.secretRef},
            secret_operation_id = ${input.operationId}, result = ${sql.json(input.facts as never)}
        where id = ${input.id} and status = 'exchanging'
        returning id
    `;
    return rows.length > 0;
}

/** The grant and account of the caller's active OAuth connection for `provider`, or null. */
export async function connectionTarget(
    sql: Sql,
    input: { orgId: string; userId: string; provider: string; connectionId: string }
): Promise<{ grantId: string; accountId: string } | null> {
    const rows = await sql<{ grant_id: string; external_account_id: string }[]>`
        select c.grant_id, g.external_account_id
        from connector_connection c join integration_grant g on g.id = c.grant_id and g.org_id = c.org_id
        where c.id = ${input.connectionId} and c.org_id = ${input.orgId} and c.status = 'active'
          and c.credential = 'oauth_grant' and c.principal_user_id = ${input.userId} and c.provider = ${input.provider}
    `;
    return rows[0] ? { grantId: rows[0].grant_id, accountId: rows[0].external_account_id } : null;
}

/** The live grant of an external account, whoever owns it. */
export async function grantOfAccount(
    sql: Sql,
    input: { provider: string; accountId: string }
): Promise<{ id: string; orgId: string; principalUserId: string | null } | null> {
    const rows = await sql<{ id: string; org_id: string; principal_user_id: string | null }[]>`
        select id, org_id, principal_user_id from integration_grant
        where provider = ${input.provider} and external_account_id = ${input.accountId} and status <> 'revoked'
    `;
    return rows[0] ? { id: rows[0].id, orgId: rows[0].org_id, principalUserId: rows[0].principal_user_id } : null;
}

class Refused extends Error {
    constructor(readonly failure: AuthorizationFailure) {
        super('refused');
    }
}

export interface Activation {
    orgId: string;
    userId: string;
    id: string;
    provider: string;
    facts: StoredFacts;
    /** A NEW grant: the pre-allocated identity and the secret already stored under it. */
    newGrant: { grantId: string; secretRef: string; secretVersion: string } | null;
}

export type ActivationResult = { ok: true; connectionIds: string[] } | { ok: false; failure: AuthorizationFailure };

async function attachResources(tx: TransactionSql, input: Activation): Promise<string[]> {
    const connectionIds: string[] = [];
    for (const resource of input.facts.resources) {
        const attach: AttachGrantConnection = {
            principal: { kind: 'user', userId: input.userId },
            provider: input.provider,
            externalAccountId: input.facts.account,
            authority: input.facts.authority,
            resource,
            access: 'read',
            // Only the first insert can create the grant; the rest find it.
            ...(input.newGrant && connectionIds.length === 0 ? input.newGrant : {}),
        };
        const attached = await attachInTx(tx, input.orgId, attach);
        if (!attached.ok) throw new Refused(refusalOf(attached.reason));
        connectionIds.push(attached.connectionId);
    }
    return connectionIds;
}

const refusalOf = (reason: string): AuthorizationFailure =>
    reason === 'duplicate-connection' ? 'duplicate-connection' : 'grant-conflict';

async function activateInTx(tx: TransactionSql, input: Activation): Promise<ActivationResult> {
    const [auth] = await tx<{ status: string }[]>`
        select status from integration_authorization where id = ${input.id} and org_id = ${input.orgId}
        for update
    `;
    if (!auth || (auth.status !== 'exchanging' && auth.status !== 'persisting')) {
        return { ok: false, failure: 'interrupted' };
    }
    if (input.newGrant) {
        const rival = await tx<{ id: string }[]>`
            select id from integration_grant
            where provider = ${input.provider} and external_account_id = ${input.facts.account}
              and status <> 'revoked'
            for update
        `;
        if (rival.length > 0) throw new Refused('grant-conflict');
    }
    const connectionIds = await attachResources(tx, input);
    const facts: StoredFacts = { ...input.facts, connectionIds };
    await tx`
        update integration_authorization
        set status = 'completed', completed_at = now(), pkce_verifier = null, result = ${tx.json(facts as never)}
        where id = ${input.id}
    `;
    return { ok: true, connectionIds };
}

/**
 * The activation transaction: authorization row (for update) -> grant (insert, or the existing one) -> connections.
 * A new grant is inserted only when no live grant of the account exists, so a grant that appeared meanwhile is a
 * `grant-conflict` the caller answers by destroying its own reference. Everything rolls back together.
 */
export async function activateAuthorization(sql: Sql, input: Activation): Promise<ActivationResult> {
    try {
        return await sql.begin((tx) => activateInTx(tx, input));
    } catch (error) {
        if (error instanceof Refused) return { ok: false, failure: error.failure };
        const refusal = attachRefusalOf(error);
        if (refusal) return { ok: false, failure: refusalOf(refusal) };
        throw error;
    }
}
