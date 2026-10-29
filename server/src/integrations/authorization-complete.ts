import { createHash, randomUUID } from 'node:crypto';
import { grantSecretIdentity } from '../db/connection-grants.js';
import { createSecretRef } from '../secrets/secret-input.js';
import type { OperationId, SecretRef, SecretVersion } from '../secrets/secret-store.js';
import {
    type ActivationResult,
    activateAuthorization,
    type AuthorizationRow,
    classifyUnconsumed,
    consumeAuthorization,
    expireAuthorization,
    failAuthorization,
    grantOfAccount,
    readAuthorization,
    recordGrantClaim,
    recordPersisting,
    type StoredFacts,
    connectionTarget,
} from './authorization-store.js';
import {
    type AuthorizationFailure,
    type CompleteAuthorizationInput,
    type CompleteAuthorizationResult,
    type AuthorizationClient,
    type FlowCtx,
    type RecoverAuthorizationResult,
    redirectUriOf,
} from './authorization-types.js';
import { encodeGrantPayload, type GrantPayload } from './grant-credentials.js';
import { attemptsLive, replay } from './lineage-commit.js';
import {
    authorizationAttemptKey,
    authorizationWindowMs,
    grantAttemptKey,
    type LineageClaim,
    type LineageCtx,
} from './lineage-types.js';
import type { DiscoveredIdentity, ExchangeResult, OAuthProviderHooks } from './oauth-provider.js';
import { reconcileFenced } from './operation-fence.js';
import { isTrustedContext, type TrustedIntegrationContext } from './trusted-context.js';

/**
 * Completion of an authorization transaction (docs/connections.md): consume the state once, claim the grant's
 * lineage BEFORE the code exchange when the person reconnects, exchange, discover the identity, then commit the
 * credentials - under the held claim, or as a NEW grant created secret first and activated last.
 *
 * No database lock is held across a provider or SecretStore call. Once the provider accepted the code the caller's
 * signal is detached: only the lease governs, so a cancel never discards credentials the provider already issued.
 * Tokens discarded on a conflict, a mismatch or a busy grant are dropped from memory and never revoked: they are a
 * fresh consent, not the grant's lineage (F8).
 */

export const hashState = (state: string): string => createHash('sha256').update(state).digest('hex');

export function requireTrusted(fc: Pick<FlowCtx, 'orgId'>, ctx: TrustedIntegrationContext): void {
    if (!isTrustedContext(ctx)) throw new Error('integration authorization needs a trusted context');
    if (ctx.orgId !== fc.orgId) throw new Error('integration authorization context is for another organization');
}

type Failed = { ok: false; returnTo: string; failure: AuthorizationFailure };

/** Marks the row failed (when still open) and answers its stored return path. */
async function fail(fc: FlowCtx, row: AuthorizationRow, failure: AuthorizationFailure): Promise<Failed> {
    if (await failAuthorization(fc.sql, row.id, failure)) fc.log('failed', row.id, failure);
    return { ok: false, returnTo: row.returnTo, failure };
}

interface Held {
    claim: LineageClaim | null;
    rotates: boolean;
}

/** The same claim for the lease, a persistence fence no later than the authorization's own deadline. */
const capClaim = (claim: LineageClaim, row: AuthorizationRow): LineageClaim => ({
    ...claim,
    deadlineAt: Math.min(claim.deadlineAt, row.deadlineAt ?? claim.deadlineAt),
});

/** The flow has no time left: nothing more is exchanged, looked up or stored. */
const overDeadline = (row: AuthorizationRow): boolean => row.deadlineAt !== null && Date.now() >= row.deadlineAt;

const release = async (fc: FlowCtx, held: Held, options: { reconnect?: boolean } = {}): Promise<void> => {
    if (held.claim) await fc.lineage.releaseClaim(held.claim, options).catch(() => false);
};

/** Takes the grant's `reconsent` claim; refused means the grant is busy or gone, and nothing was exchanged. */
async function claimGrant(
    fc: FlowCtx,
    row: AuthorizationRow,
    grant: { id: string; rotates: boolean }
): Promise<{ ok: true; held: Held } | { ok: false; failure: AuthorizationFailure }> {
    const claimed = await fc.lineage.claimLineage(grant.id, 'reconsent', { rotates: grant.rotates });
    if (!claimed.ok) {
        return {
            ok: false,
            failure: claimed.reason === 'revoked' || claimed.reason === 'not-found' ? 'grant-conflict' : 'busy',
        };
    }
    const held: Held = { claim: claimed.claim, rotates: grant.rotates };
    if (!(await recordGrantClaim(fc.sql, { id: row.id, grantId: grant.id, claim: claimed.claim.token }))) {
        await release(fc, held);
        return { ok: false, failure: 'interrupted' };
    }
    return { ok: true, held };
}

async function exchangeCode(
    fc: FlowCtx,
    request: { hooks: OAuthProviderHooks; row: AuthorizationRow; code: string; redirectUri: string },
    signal: AbortSignal | undefined
): Promise<ExchangeResult> {
    const bound = AbortSignal.timeout(fc.lineage.timing.exchangeDeadlineMs);
    return request.hooks
        .exchangeCode({
            code: request.code,
            redirectUri: request.redirectUri,
            ...(request.row.verifier ? { codeVerifier: request.row.verifier } : {}),
            signal: signal ? AbortSignal.any([signal, bound]) : bound,
        })
        .catch((): ExchangeResult => ({ ok: false, failure: 'ambiguous' }));
}

/** `write` exactly when the token's own scope holds every scope a write consent adds to a read one. */
function accessOf(client: AuthorizationClient | undefined, granted: readonly string[]): 'read' | 'write' {
    if (!client) return 'read';
    const read = new Set(client.scopesFor('read'));
    const extra = client.scopesFor('write').filter((scope) => !read.has(scope));
    return extra.length > 0 && extra.every((scope) => granted.includes(scope)) ? 'write' : 'read';
}

/** The facts a completion keeps: the token's actual scope wins over what discovery listed, and a named site narrows. */
function factsOf(
    fc: FlowCtx,
    row: AuthorizationRow,
    found: { identity: DiscoveredIdentity; granted: readonly string[] }
): StoredFacts | null {
    const { identity, granted } = found;
    const resources = identity.resources
        .filter(({ label }) => row.expectedSite === null || label === row.expectedSite)
        .map(({ id, label }) => ({ id, label }));
    if (resources.length === 0) return null;
    return {
        account: identity.externalAccountId,
        label: identity.label,
        resources,
        authority: { scopes: [...granted] },
        access: accessOf(fc.clients(row.provider), granted),
        interactionId: row.interactionId,
    };
}

/** The grant row the credentials land on is the lineage's: commit under the claim, and map what it answers. */
async function commitUnderClaim(
    fc: FlowCtx,
    held: Held,
    payload: GrantPayload
): Promise<AuthorizationFailure | 'pending' | null> {
    const committed = await fc.lineage.commitLineage(held.claim!, payload);
    if (committed.ok) return null;
    if (committed.reason === 'persistence-pending') return 'pending';
    if (committed.reason === 'revoked') return 'grant-conflict';
    return committed.reason === 'claim-lost' ? 'busy' : 'storage-failed';
}

async function finishActivation(fc: FlowCtx, row: AuthorizationRow, activated: ActivationResult) {
    if (activated.ok) {
        fc.log('completed', row.id);
        return {
            ok: true as const,
            returnTo: row.returnTo,
            connectionId: row.connectionId ?? activated.connectionIds[0]!,
        };
    }
    return fail(fc, row, activated.failure);
}

/** Destroys a reference no grant will ever name: best effort, and never at a version nobody confirmed. */
async function destroyOwnReference(
    fc: FlowCtx,
    target: { row: AuthorizationRow; version: SecretVersion },
    lctx: LineageCtx
): Promise<void> {
    const { row, version } = target;
    if (!row.pendingGrantId || !row.secretRef) return;
    try {
        const operationId = await fc.secrets.issueOperationId();
        const identity = grantSecretIdentity({ id: row.pendingGrantId, orgId: fc.orgId, principalUserId: row.userId });
        // Best effort, under no claim: the retry budget, plus one more call's worth for the last attempt.
        const until = Date.now() + fc.lineage.timing.persistBudgetMs;
        await replay(
            lctx,
            authorizationAttemptKey(fc.orgId, row.id),
            (signal) =>
                fc.secrets.delete({
                    identity,
                    ref: row.secretRef as SecretRef,
                    operationId,
                    expectedVersion: version,
                    signal,
                }),
            { fenceAt: until + fc.lineage.timing.readDeadlineMs, retryUntil: until }
        );
    } catch {
        // The reference stays encrypted at rest, unreferenced; a later sweep owns it.
    }
}

const lineageCtxOf = (fc: FlowCtx): LineageCtx => ({
    attempts: fc.lineage.attempts,
    sql: fc.sql,
    orgId: fc.orgId,
    secrets: fc.secrets,
    providers: fc.providers,
    timing: fc.lineage.timing,
    leaseMs: fc.lineage.leaseMs,
    log: () => undefined,
});

/** Activates a new grant whose secret is stored; on any refusal our reference is destroyed (no grant names it). */
async function activateNewGrant(
    fc: FlowCtx,
    target: { row: AuthorizationRow; facts: StoredFacts; version: SecretVersion }
): Promise<ActivationResult> {
    const { row, facts, version } = target;
    const activated = await activateAuthorization(fc.sql, {
        orgId: fc.orgId,
        userId: row.userId,
        id: row.id,
        provider: row.provider,
        facts,
        expectedSite: row.expectedSite,
        newGrant: {
            grantId: row.pendingGrantId!,
            secretRef: row.secretRef!,
            secretVersion: version,
            operationId: row.secretOperationId!,
        },
    });
    // `interrupted`: someone else settled the row and may have activated this very reference.
    if (!activated.ok && activated.failure !== 'interrupted') {
        await destroyOwnReference(fc, { row, version }, lineageCtxOf(fc));
    }
    return activated;
}

/** A new account: the secret is created first, replayed identically on an inconclusive answer, the connection last. */
async function connectNewGrant(
    fc: FlowCtx,
    row: AuthorizationRow,
    step: { payload: GrantPayload; facts: StoredFacts }
): Promise<CompleteAuthorizationResult> {
    const operationId = await fc.secrets.issueOperationId().catch(() => null);
    if (!operationId) return fail(fc, row, 'storage-failed');
    const pendingGrantId = randomUUID();
    const secretRef = createSecretRef();
    const recorded = await recordPersisting(fc.sql, {
        id: row.id,
        pendingGrantId,
        secretRef,
        operationId,
        facts: step.facts,
    });
    if (!recorded) return fail(fc, row, 'interrupted');
    const identity = grantSecretIdentity({ id: pendingGrantId, orgId: fc.orgId, principalUserId: row.userId });
    const bytes = encodeGrantPayload(step.payload);
    const fenceAt = (row.deadlineAt ?? Date.now()) - fc.lineage.timing.marginMs;
    const persisted = await replay(
        lineageCtxOf(fc),
        authorizationAttemptKey(fc.orgId, row.id),
        (signal) =>
            fc.secrets.create({
                identity,
                ref: secretRef,
                operationId: operationId as OperationId,
                payload: bytes,
                signal,
            }),
        { fenceAt, retryUntil: Math.min(fenceAt, Date.now() + fc.lineage.timing.persistBudgetMs) }
    );
    // Still inconclusive at the deadline: the row stays `persisting` and recovery reconciles the recorded operation.
    if (persisted.kind === 'pending') return { ok: false, returnTo: row.returnTo, failure: 'storage-failed' };
    if (persisted.kind === 'definitive') return fail(fc, row, 'storage-failed');
    const stored = { ...row, pendingGrantId, secretRef, secretOperationId: operationId };
    return finishActivation(
        fc,
        row,
        await activateNewGrant(fc, { row: stored, facts: step.facts, version: persisted.result.version })
    );
}

/** A connect to an account that already has a grant of this person: reconsent it now, then add the connections. */
async function connectExistingGrant(
    fc: FlowCtx,
    row: AuthorizationRow,
    step: { grantId: string; hooks: OAuthProviderHooks; payload: GrantPayload; facts: StoredFacts }
): Promise<CompleteAuthorizationResult> {
    const claimed = await claimGrant(fc, row, { id: step.grantId, rotates: step.hooks.rotatesRefreshToken });
    // Busy: the tokens are a fresh consent, not the grant's lineage; dropping them leaves its refresh untouched.
    if (!claimed.ok) return fail(fc, row, claimed.failure);
    // This claim was taken after the exchange and the lookup: its lease may outlast the flow, its persistence may not.
    const held: Held = { ...claimed.held, claim: capClaim(claimed.held.claim!, row) };
    const refusal = await commitUnderClaim(fc, held, step.payload);
    if (refusal === 'pending') return { ok: false, returnTo: row.returnTo, failure: 'storage-failed' };
    if (refusal) return fail(fc, row, refusal);
    return finishActivation(fc, row, await activateExistingGrant(fc, row, step.facts));
}

/** A reconnect: the claim is already held, the account must be the same one, then the lineage commit. */
async function reconnect(
    fc: FlowCtx,
    row: AuthorizationRow,
    step: { held: Held; payload: GrantPayload; facts: StoredFacts }
): Promise<CompleteAuthorizationResult> {
    if (step.facts.account !== row.expectedAccountId) {
        await release(fc, step.held);
        return fail(fc, row, 'identity-mismatch');
    }
    const refusal = await commitUnderClaim(fc, step.held, step.payload);
    if (refusal === 'pending') return { ok: false, returnTo: row.returnTo, failure: 'storage-failed' };
    if (refusal) return fail(fc, row, refusal);
    // The same activation as a first connect: access follows the new authority and newly seen sites attach.
    return finishActivation(fc, row, await activateExistingGrant(fc, row, step.facts));
}

const activateExistingGrant = (fc: FlowCtx, row: AuthorizationRow, facts: StoredFacts): Promise<ActivationResult> =>
    activateAuthorization(fc.sql, {
        orgId: fc.orgId,
        userId: row.userId,
        id: row.id,
        provider: row.provider,
        facts,
        expectedSite: row.expectedSite,
        newGrant: null,
    });

async function afterExchange(
    fc: FlowCtx,
    request: { row: AuthorizationRow; hooks: OAuthProviderHooks; held: Held },
    tokens: Extract<ExchangeResult, { ok: true }>['tokens']
): Promise<CompleteAuthorizationResult> {
    const { row, hooks, held } = request;
    if (overDeadline(row)) {
        await release(fc, held);
        return fail(fc, row, 'interrupted');
    }
    // From here the caller's signal is detached: discovery and persistence run under their own bounds.
    const identity = await hooks
        .discoverIdentity({
            accessToken: tokens.accessToken,
            signal: AbortSignal.timeout(fc.lineage.timing.exchangeDeadlineMs),
        })
        .catch(() => null);
    if (!identity || identity.resources.length === 0) {
        await release(fc, held);
        return fail(fc, row, 'exchange-failed');
    }
    if (overDeadline(row)) {
        await release(fc, held);
        return fail(fc, row, 'interrupted');
    }
    const facts = factsOf(fc, row, { identity, granted: tokens.authority?.scopes ?? identity.authority.scopes });
    if (!facts) {
        // A named site this account cannot reach: nothing is stored, a held reconnect claim is released.
        await release(fc, held);
        return fail(fc, row, 'site-mismatch');
    }
    const payload: GrantPayload = {
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken,
        authority: facts.authority,
    };
    if (row.intent === 'reconnect') return reconnect(fc, row, { held, payload, facts });
    const existing = await grantOfAccount(fc.sql, { provider: row.provider, accountId: identity.externalAccountId });
    if (!existing) return connectNewGrant(fc, row, { payload, facts });
    if (existing.orgId !== fc.orgId || existing.principalUserId !== row.userId) return fail(fc, row, 'grant-conflict');
    return connectExistingGrant(fc, row, { grantId: existing.id, hooks, payload, facts });
}

async function run(
    fc: FlowCtx,
    row: AuthorizationRow,
    input: CompleteAuthorizationInput,
    signal: AbortSignal | undefined
): Promise<CompleteAuthorizationResult> {
    if (input.error) return fail(fc, row, 'denied');
    const hooks = fc.providers(row.provider);
    const redirectUri = redirectUriOf(fc, row.provider);
    if (!input.code || !hooks || !redirectUri) return fail(fc, row, 'exchange-failed');

    let held: Held = { claim: null, rotates: hooks.rotatesRefreshToken };
    if (row.intent === 'reconnect') {
        const target = row.connectionId
            ? await connectionTarget(fc.sql, {
                  orgId: fc.orgId,
                  userId: row.userId,
                  provider: row.provider,
                  connectionId: row.connectionId,
              })
            : null;
        if (!target) return fail(fc, row, 'grant-conflict');
        const claimed = await claimGrant(fc, row, { id: target.grantId, rotates: hooks.rotatesRefreshToken });
        if (!claimed.ok) return fail(fc, row, claimed.failure);
        held = claimed.held;
    }

    const answer = await exchangeCode(fc, { hooks, row, code: input.code, redirectUri }, signal);
    if (!answer.ok) {
        // An ambiguous answer may have spent a rotating grant's token (F7); a definitive or unsent one spent nothing.
        await release(fc, held, { reconnect: answer.failure === 'ambiguous' && held.rotates });
        return fail(fc, row, 'exchange-failed');
    }
    return afterExchange(fc, { row, hooks, held }, answer.tokens);
}

export async function completeAuthorization(
    fc: FlowCtx,
    ctx: TrustedIntegrationContext,
    input: CompleteAuthorizationInput,
    signal: AbortSignal | undefined
): Promise<CompleteAuthorizationResult> {
    requireTrusted(fc, ctx);
    if (ctx.principal.kind !== 'user' || !input.state) {
        return { ok: false, returnTo: '/', failure: 'state-mismatch' };
    }
    const owner = { orgId: fc.orgId, userId: ctx.principal.userId, stateHash: hashState(input.state) };
    const row = await consumeAuthorization(fc.sql, owner, authorizationWindowMs(fc.lineage.timing));
    if (!row) {
        const why = await classifyUnconsumed(fc.sql, owner);
        return { ok: false, returnTo: why.returnTo, failure: why.failure };
    }
    fc.log('consumed', row.id);
    try {
        return await run(fc, row, input, signal);
    } catch {
        // Closed diagnostics only: a driver or hook error may quote a code or a token. Recovery owns the row.
        fc.log('error', row.id);
        throw new Error('integration authorization failed');
    }
}

/** Reconciles a `persisting` row's recorded create: succeeded activates, anything else is a lost secret. */
async function recoverPersisting(fc: FlowCtx, row: AuthorizationRow): Promise<RecoverAuthorizationResult> {
    const lost = async (): Promise<RecoverAuthorizationResult> => {
        await fail(fc, row, 'storage-failed');
        return 'failed';
    };
    if (!row.pendingGrantId || !row.secretRef || !row.secretOperationId || !row.result) return lost();
    const settled = await reconcileFenced(
        fc.secrets,
        {
            identity: grantSecretIdentity({ id: row.pendingGrantId, orgId: fc.orgId, principalUserId: row.userId }),
            ref: row.secretRef as SecretRef,
            operationId: row.secretOperationId as OperationId,
        },
        fc.lineage.timing.readDeadlineMs
    );
    if (settled.kind === 'fenced') return lost();
    if (settled.kind === 'inconclusive') return 'left';
    const { status } = settled;
    if (status.state !== 'succeeded' || status.result.version === null) return lost();
    const activated = await activateNewGrant(fc, { row, facts: row.result, version: status.result.version });
    if (activated.ok) {
        fc.log('recovered', row.id);
        return 'activated';
    }
    await fail(fc, row, activated.failure);
    return activated.failure === 'interrupted' ? 'left' : 'failed';
}

/** The holder of an `exchanging` row is gone: the code is never exchanged again; a held claim is released (F7). */
async function recoverExchanging(fc: FlowCtx, row: AuthorizationRow): Promise<RecoverAuthorizationResult> {
    if (row.grantClaim && row.grantId) {
        const rotates = fc.providers(row.provider)?.rotatesRefreshToken ?? true;
        const released = await fc.lineage.releaseClaim(
            { token: row.grantClaim, grantId: row.grantId },
            { reconnect: row.intent === 'reconnect' && rotates, unrecordedOnly: true }
        );
        // A recorded operation is the lineage's: its own recovery finalizes or loses it.
        if (!released) await fc.lineage.recoverLineage(row.grantId).catch(() => undefined);
    }
    await fail(fc, row, 'interrupted');
    fc.log('recovered', row.id);
    return 'interrupted';
}

export async function recoverAuthorization(fc: FlowCtx, id: string): Promise<RecoverAuthorizationResult> {
    const row = await readAuthorization(fc.sql, { orgId: fc.orgId, id });
    if (!row || row.status === 'completed' || row.status === 'failed' || row.status === 'expired') return 'idle';
    if (row.status === 'pending') {
        if (!row.expired) return 'not-expired';
        return (await expireAuthorization(fc.sql, id)) ? 'expired' : 'left';
    }
    // A holder may still be running until the flow's own deadline has passed, and while a mutation of it is live.
    if (!row.pastDeadline) return 'not-expired';
    const grantKey = row.grantId ? grantAttemptKey(fc.orgId, row.grantId) : null;
    if (
        attemptsLive(fc.lineage.attempts, authorizationAttemptKey(fc.orgId, id)) ||
        (grantKey && attemptsLive(fc.lineage.attempts, grantKey))
    )
        return 'left';
    return row.status === 'persisting' ? recoverPersisting(fc, row) : recoverExchanging(fc, row);
}
