import { finalizeLineage } from '../db/connection-grants.js';
import { createSecretRef } from '../secrets/secret-input.js';
import type { OperationId, SecretError, SecretRef, SecretResult, SecretVersion } from '../secrets/secret-store.js';
import { decodeGrantPayload, encodeGrantPayload, type GrantPayload } from './grant-credentials.js';
import { endClaim, readLineage, recordOperation } from './lineage-claims.js';
import { type CommitResult, identityOf, type LineageClaim, type LineageCtx, pause } from './lineage-types.js';

/**
 * Steps 4-6 of the protocol: record the operation, persist the new credentials by replaying the identical
 * mutation from memory, finalize. The caller's signal never reaches this code: once the provider accepted an
 * exchange, only the lease governs, so a cancel never discards rotated credentials.
 */

/** A definitive refusal: the mutation will never apply, so the credentials it carried are lost. */
const DEFINITIVE: ReadonlySet<SecretError['code']> = new Set([
    'not-found',
    'identity-mismatch',
    'conflict',
    'invalid-input',
]);

export type Replayed<T extends object> =
    | { kind: 'ok'; result: Extract<SecretResult<T>, { ok: true }> }
    | { kind: 'definitive'; error: SecretError }
    | { kind: 'pending' };

/** Replays one mutation, identically, until the store answers definitively or the deadline passes. */
export async function replay<T extends object>(
    ctx: LineageCtx,
    attempt: () => Promise<SecretResult<T>>,
    deadlineAt: number
): Promise<Replayed<T>> {
    for (;;) {
        const result = await attempt().catch(() => null);
        if (result?.ok) return { kind: 'ok', result: result as Extract<SecretResult<T>, { ok: true }> };
        if (result && DEFINITIVE.has(result.error.code)) return { kind: 'definitive', error: result.error };
        if (Date.now() >= deadlineAt) return { kind: 'pending' };
        await pause(ctx.timing.retryDelayMs);
    }
}

export const persistDeadline = (ctx: LineageCtx, claim: LineageClaim): number =>
    Math.min(claim.deadlineAt - ctx.timing.marginMs, Date.now() + ctx.timing.persistBudgetMs);

/** Reads the active secret and accepts it only as a confirmed value of the version the grant names. */
export async function readConfirmed(
    ctx: LineageCtx,
    claim: LineageClaim,
    signal: AbortSignal | undefined
): Promise<{ ok: true; payload: GrantPayload } | { ok: false }> {
    if (claim.secretRef === null || claim.secretVersion === null) return { ok: false };
    const bound = AbortSignal.timeout(ctx.timing.readDeadlineMs);
    try {
        const read = await ctx.secrets.readActive({
            identity: identityOf(claim),
            ref: claim.secretRef as SecretRef,
            signal: signal ? AbortSignal.any([signal, bound]) : bound,
        });
        if (!read.ok || read.version !== claim.secretVersion) return { ok: false };
        return { ok: true, payload: decodeGrantPayload(read.value) };
    } catch {
        // A thrown read or a payload that does not decode is not "no credential": the caller leaves the grant alone.
        return { ok: false };
    }
}

async function dropTokens(ctx: LineageCtx, claim: LineageClaim, payload: GrantPayload): Promise<void> {
    const hooks = ctx.providers(claim.provider);
    if (hooks?.revokeScope !== 'token' || !hooks.revoke) return;
    try {
        const result = await hooks.revoke({
            token: payload.refreshToken ?? payload.accessToken,
            signal: AbortSignal.timeout(ctx.timing.exchangeDeadlineMs),
        });
        ctx.log(result === 'revoked' ? 'revoke-attempted' : 'revoke-failed', claim.grantId);
    } catch {
        ctx.log('revoke-failed', claim.grantId);
    }
}

/** The credentials cannot be stored: a rotating lineage (or any reconsent) needs the person, the rest keeps its secret. */
async function lose(ctx: LineageCtx, claim: LineageClaim, rotating: boolean): Promise<CommitResult> {
    await endClaim(ctx, claim, { operation: true, reconnect: rotating });
    ctx.log(rotating ? 'reconnect-required' : 'persistence-lost', claim.grantId);
    return { ok: false, reason: 'lost', reconnectRequired: rotating };
}

/** The grant was revoked (or the claim lost) while the exchange ran: the new tokens are dropped, never stored. */
async function dropped(ctx: LineageCtx, claim: LineageClaim, payload: GrantPayload): Promise<CommitResult> {
    const current = await readLineage(ctx, claim.grantId);
    await dropTokens(ctx, claim, payload);
    await endClaim(ctx, claim);
    return { ok: false, reason: current?.status === 'revoked' ? 'revoked' : 'claim-lost' };
}

async function persist(
    ctx: LineageCtx,
    claim: LineageClaim,
    target: { fresh: boolean; ref: SecretRef; operationId: OperationId; bytes: Uint8Array }
): Promise<Replayed<{ version: SecretVersion }>> {
    const { fresh, ref, operationId, bytes } = target;
    const identity = identityOf(claim);
    const deadline = persistDeadline(ctx, claim);
    if (fresh) return replay(ctx, () => ctx.secrets.create({ identity, ref, operationId, payload: bytes }), deadline);
    const expectedVersion = claim.secretVersion as SecretVersion;
    return replay(
        ctx,
        () => ctx.secrets.replace({ identity, ref, operationId, expectedVersion, payload: bytes }),
        deadline
    );
}

export async function commitLineage(
    ctx: LineageCtx,
    claim: LineageClaim,
    payload: GrantPayload
): Promise<CommitResult> {
    if (claim.kind === 'destroy') throw new Error('commitLineage: a destroy claim carries no credentials');
    const hooks = ctx.providers(claim.provider);
    const rotating = claim.kind === 'reconsent' || (hooks?.rotatesRefreshToken ?? true);
    const fresh =
        claim.kind === 'reconsent' && (claim.wedged || claim.secretRef === null || claim.secretVersion === null);
    const ref = (fresh ? createSecretRef() : claim.secretRef) as SecretRef;
    const operationId = await ctx.secrets.issueOperationId().catch(() => null);
    if (!operationId) return lose(ctx, claim, rotating);
    if (!(await recordOperation(ctx, claim, operationId, ref))) return dropped(ctx, claim, payload);

    const persisted = await persist(ctx, claim, { fresh, ref, operationId, bytes: encodeGrantPayload(payload) });
    if (persisted.kind === 'pending') {
        ctx.log('persistence-pending', claim.grantId);
        return { ok: false, reason: 'persistence-pending' };
    }
    if (persisted.kind === 'definitive') return lose(ctx, claim, rotating);

    const secretVersion = persisted.result.version;
    try {
        const done = await finalizeLineage(ctx.sql, claim, {
            kind: claim.kind,
            secretVersion,
            authority: payload.authority,
        });
        return done.ok ? { ok: true, version: done.version, secretVersion } : { ok: false, reason: 'claim-lost' };
    } catch {
        // The secret is stored and the operation recorded: recovery finalizes it.
        return { ok: false, reason: 'persistence-pending' };
    }
}
