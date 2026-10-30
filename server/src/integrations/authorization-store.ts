import type { Sql, TransactionSql } from 'postgres';
import { type AttachGrantConnection, attachInTx, attachRefusalOf } from '../db/connection-grants.js';
import type { AuthorizationFailure, CompleteFailure } from './authorization-types.js';

/**
 * SQL for `integration_authorization` (097). Every transition is one guarded statement, so two racers, a late
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
    /** The one site (lowercase host) the person narrowed the connect to, or null for every accessible site. */
    expectedSite: string | null;
    interactionId: string | null;
    returnTo: string;
    status: 'pending' | 'exchanging' | 'persisting' | 'completed' | 'failed' | 'expired';
    pendingGrantId: string | null;
    secretRef: string | null;
    secretOperationId: string | null;
    result: StoredFacts | null;
    /** The PKCE verifier as it was before consume; present only on the row `consumeAuthorization` returns. */
    verifier: string | null;
    /** Epoch milliseconds on this process's clock by which the flow must end; set only on the row `consumeAuthorization` returns. */
    deadlineAt: number | null;
    /** The durable deadline has passed: no holder of the flow may still be running. */
    pastDeadline: boolean;
    expired: boolean;
}

/** The non-secret facts a completion needs after the holder is gone. */
export interface StoredFacts {
    account: string;
    /** What a person calls the account (an email, else a display name): shown on every connection of it. */
    label: string;
    resources: { id: string; label: string }[];
    authority: { scopes: string[] };
    /** `write` exactly when the token's own scope holds every write scope of the client. */
    access: 'read' | 'write';
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
    expected_site: string | null;
    interaction_id: string | null;
    return_to: string;
    status: AuthorizationRow['status'];
    pending_grant_id: string | null;
    secret_ref: string | null;
    secret_operation_id: string | null;
    result: StoredFacts | null;
    verifier?: string | null;
    past_deadline?: boolean;
    expired?: boolean;
}

const COLUMNS = `id, user_id, provider, intent, connection_id, grant_id, grant_claim, expected_account_id,
    expected_site, interaction_id, return_to, status, pending_grant_id, secret_ref, secret_operation_id, result`;

const toRow = (raw: Raw): AuthorizationRow => ({
    id: raw.id,
    userId: raw.user_id,
    provider: raw.provider,
    intent: raw.intent,
    connectionId: raw.connection_id,
    grantId: raw.grant_id,
    grantClaim: raw.grant_claim,
    expectedAccountId: raw.expected_account_id,
    expectedSite: raw.expected_site,
    interactionId: raw.interaction_id,
    returnTo: raw.return_to,
    status: raw.status,
    pendingGrantId: raw.pending_grant_id,
    secretRef: raw.secret_ref,
    secretOperationId: raw.secret_operation_id,
    result: raw.result,
    verifier: raw.verifier ?? null,
    deadlineAt: null,
    pastDeadline: raw.past_deadline === true,
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
    bindJobId: string | null;
    requestedAccess: 'read' | 'write';
    expectedSite: string | null;
    ttlMs: number;
    reconnect: { connectionId: string; accountId: string } | null;
}

export async function insertAuthorization(
    sql: Sql,
    input: NewAuthorization
): Promise<{ id: string; expiresAt: string }> {
    const [row] = await sql<{ id: string; expires_at: Date }[]>`
        insert into integration_authorization
            (org_id, user_id, provider, intent, connection_id, expected_account_id, interaction_id, bind_job_id, state_hash,
             pkce_verifier, return_to, requested_access, expected_site, expires_at)
        values (${input.orgId}, ${input.userId}, ${input.provider},
                ${input.reconnect ? 'reconnect' : 'connect'}, ${input.reconnect?.connectionId ?? null},
                ${input.reconnect?.accountId ?? null}, ${input.interactionId}, ${input.bindJobId}, ${input.stateHash},
                ${input.verifier}, ${input.returnTo}, ${input.requestedAccess}, ${input.expectedSite},
                now() + (${input.ttlMs}::double precision * interval '1 millisecond'))
        returning id, expires_at
    `;
    return { id: row!.id, expiresAt: row!.expires_at.toISOString() };
}

export interface Owner {
    orgId: string;
    userId: string;
    stateHash: string;
}

/**
 * Consumes the row: `pending` -> `exchanging`, once, for its own user, before its time is up. The verifier is
 * returned from the row as it was and nulled by the same statement, and `deadline_at` is stored: the flow has
 * `windowMs` to end. Zero rows is `null`, classified by `classifyUnconsumed`; the lock on the target row serializes
 * two racers, and the loser sees the new status.
 */
export async function consumeAuthorization(sql: Sql, owner: Owner, windowMs: number): Promise<AuthorizationRow | null> {
    const startedAt = Date.now();
    const rows = await sql<Raw[]>`
        with target as (
            select id, pkce_verifier from integration_authorization
            where state_hash = ${owner.stateHash} and user_id = ${owner.userId} and org_id = ${owner.orgId}
              and status = 'pending' and expires_at > now()
            for update
        )
        update integration_authorization a
        set status = 'exchanging', consumed_at = now(), pkce_verifier = null,
            deadline_at = now() + (${windowMs}::double precision * interval '1 millisecond')
        from target t where a.id = t.id
        returning ${sql.unsafe(COLUMNS.replaceAll(/\b(\w+)\b/g, 'a.$1'))}, t.pkce_verifier as verifier
    `;
    return rows[0] ? { ...toRow(rows[0]), deadlineAt: startedAt + windowMs } : null;
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

/** The task a connect was started from (BEL-174), by the owner's state; null for none or an unknown state. */
export async function bindJobOf(sql: Sql, owner: Owner): Promise<string | null> {
    const [row] = await sql<{ bind_job_id: string | null }[]>`
        select bind_job_id from integration_authorization
        where state_hash = ${owner.stateHash} and user_id = ${owner.userId} and org_id = ${owner.orgId}
    `;
    return row?.bind_job_id ?? null;
}

export async function readAuthorization(
    sql: Sql,
    input: { orgId: string; id: string }
): Promise<AuthorizationRow | null> {
    const rows = await sql<Raw[]>`
        select ${sql.unsafe(COLUMNS)},
               (deadline_at is not null and deadline_at < now()) as past_deadline,
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

/** Records the lineage claim a reconnect (or a connect that found a grant) holds, while the row is `exchanging` and inside its deadline. */
export async function recordGrantClaim(
    sql: Sql,
    input: { id: string; grantId: string; claim: string }
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        update integration_authorization set grant_id = ${input.grantId}, grant_claim = ${input.claim}
        where id = ${input.id} and status = 'exchanging' and deadline_at > now()
        returning id
    `;
    return rows.length > 0;
}

/**
 * Keeps the facts a commit under the held claim will activate from, BEFORE the commit: a holder that vanishes after
 * the claim finalized leaves recovery everything it needs. It applies only to the claim the row recorded, in time.
 */
export async function recordClaimResult(
    sql: Sql,
    input: { id: string; claim: string; facts: StoredFacts }
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        update integration_authorization set result = ${sql.json(input.facts as never)}
        where id = ${input.id} and status = 'exchanging' and grant_claim = ${input.claim} and deadline_at > now()
        returning id
    `;
    return rows.length > 0;
}

/** Records the pre-allocated grant, reference and operation BEFORE the secret is created (inside the deadline): recovery reconciles them. */
export async function recordPersisting(
    sql: Sql,
    input: { id: string; pendingGrantId: string; secretRef: string; operationId: string; facts: StoredFacts }
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        update integration_authorization
        set status = 'persisting', pending_grant_id = ${input.pendingGrantId}, secret_ref = ${input.secretRef},
            secret_operation_id = ${input.operationId}, result = ${sql.json(input.facts as never)}
        where id = ${input.id} and status = 'exchanging' and deadline_at > now()
        returning id
    `;
    return rows.length > 0;
}

/** The grant and account of the caller's active OAuth connection for `provider`, or null. */
export async function connectionTarget(
    sql: Sql,
    input: { orgId: string; userId: string; provider: string; connectionId: string }
): Promise<{ grantId: string; accountId: string; scopes: string[] } | null> {
    const rows = await sql<{ grant_id: string; external_account_id: string; authority: { scopes: string[] } }[]>`
        select c.grant_id, g.external_account_id, g.authority
        from connector_connection c join integration_grant g on g.id = c.grant_id and g.org_id = c.org_id
        where c.id = ${input.connectionId} and c.org_id = ${input.orgId} and c.status = 'active'
          and c.credential = 'oauth_grant' and c.principal_user_id = ${input.userId} and c.provider = ${input.provider}
    `;
    return rows[0]
        ? { grantId: rows[0].grant_id, accountId: rows[0].external_account_id, scopes: rows[0].authority.scopes }
        : null;
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
    /**
     * The one site (lowercase host) the person asked for by name, or null. A site named here that was disconnected
     * earlier is connected again; without it a disconnected site stays disconnected.
     */
    expectedSite: string | null;
    /** A NEW grant: the pre-allocated identity and the secret already stored under it. */
    newGrant: { grantId: string; secretRef: string; secretVersion: string; operationId: string } | null;
}

export type ActivationResult = { ok: true; connectionIds: string[] } | { ok: false; failure: AuthorizationFailure };

type Known = Map<string, { id: string; status: string }>;

/**
 * The connections of the account's live grant of this person, by resource. The grant row is locked first, so the
 * order stays authorization row -> grant -> connections.
 */
async function existingConnections(tx: TransactionSql, input: Activation): Promise<Known> {
    await tx`
        select id from integration_grant
        where provider = ${input.provider} and external_account_id = ${input.facts.account} and status <> 'revoked'
        for update
    `;
    const rows = await tx<{ id: string; cloud_id: string; status: string }[]>`
        select c.id, c.cloud_id, c.status
        from integration_grant g join connector_connection c on c.grant_id = g.id and c.org_id = g.org_id
        where g.provider = ${input.provider} and g.external_account_id = ${input.facts.account}
          and g.status <> 'revoked' and g.org_id = ${input.orgId} and g.principal_user_id = ${input.userId}
        order by c.created_at
    `;
    // An active connection wins over an older disconnected row of the same resource.
    const byResource: Known = new Map();
    for (const row of rows) {
        if (byResource.get(row.cloud_id)?.status !== 'active') byResource.set(row.cloud_id, row);
    }
    return byResource;
}

/**
 * A consent replaces the grant's authority, so every ACTIVE connection of the grant follows it: a write consent
 * through any one connection makes them all write, a read-only one makes them all read. The grant row is already
 * locked, so the order stays authorization row -> grant -> connections.
 */
async function followGrantAccess(tx: TransactionSql, input: Activation): Promise<void> {
    await tx`
        update connector_connection c set access = ${input.facts.access}
        from integration_grant g
        where c.grant_id = g.id and c.org_id = g.org_id and c.status = 'active' and c.access <> ${input.facts.access}
          and g.provider = ${input.provider} and g.external_account_id = ${input.facts.account}
          and g.status <> 'revoked' and g.org_id = ${input.orgId} and g.principal_user_id = ${input.userId}
    `;
}

/**
 * Activation is idempotent over what is already there: a resource with an ACTIVE connection under the grant keeps it
 * (same id), a resource the person disconnected earlier stays disconnected unless the consent names exactly that site
 * (`expectedSite`), and only unseen resources, or that named one, are inserted.
 * Nothing left to activate is a `duplicate-connection`: the consent changed nothing.
 */
async function attachResources(tx: TransactionSql, input: Activation): Promise<string[]> {
    const known: Known = input.newGrant ? new Map() : await existingConnections(tx, input);
    if (!input.newGrant) await followGrantAccess(tx, input);
    const connectionIds: string[] = [];
    let inserted = 0;
    for (const resource of input.facts.resources) {
        const present = known.get(resource.id);
        if (present?.status === 'active') {
            connectionIds.push(present.id);
            continue;
        }
        // Only an explicit consent for this very site brings a disconnected one back, as a new connection.
        if (present && resource.label !== input.expectedSite) continue;
        const attach: AttachGrantConnection = {
            principal: { kind: 'user', userId: input.userId },
            provider: input.provider,
            externalAccountId: input.facts.account,
            authority: input.facts.authority,
            resource,
            access: input.facts.access,
            email: input.facts.label,
            // Only the first insert can create the grant; the rest find it.
            ...(input.newGrant && inserted === 0 ? input.newGrant : {}),
        };
        const attached = await attachInTx(tx, input.orgId, attach);
        if (!attached.ok) throw new Refused(refusalOf(attached.reason));
        connectionIds.push(attached.connectionId);
        inserted += 1;
    }
    if (connectionIds.length === 0) throw new Refused('duplicate-connection');
    return connectionIds;
}

const refusalOf = (reason: string): AuthorizationFailure =>
    reason === 'duplicate-connection' ? 'duplicate-connection' : 'grant-conflict';

async function activateInTx(tx: TransactionSql, input: Activation): Promise<ActivationResult> {
    const [auth] = await tx<{ status: string; secret_operation_id: string | null }[]>`
        select status, secret_operation_id from integration_authorization where id = ${input.id} and org_id = ${input.orgId}
        for update
    `;
    if (!auth || (auth.status !== 'exchanging' && auth.status !== 'persisting')) {
        return { ok: false, failure: 'interrupted' };
    }
    // A new grant activates only the transaction that still names its operation: a recovery that fenced it settled the row.
    if (input.newGrant && (auth.status !== 'persisting' || auth.secret_operation_id !== input.newGrant.operationId)) {
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
