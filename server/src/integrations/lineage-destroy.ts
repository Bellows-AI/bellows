import { finalizeLineage } from '../db/connection-grants.js';
import type { SecretRef, SecretVersion } from '../secrets/secret-store.js';
import { claimLineage, endClaim, recordOperation } from './lineage-claims.js';
import { persistDeadline, readConfirmed, replay } from './lineage-commit.js';
import { type DestroyResult, identityOf, type LineageClaim, type LineageCtx } from './lineage-types.js';

/**
 * Step 8: the secret of a revoked grant is deleted (and, for a provider that revokes per token, revoked first).
 * It runs only for a committed `status = 'revoked'`; the claim kind `destroy` is what recovery dispatches on.
 */

type DeleteStep = 'destroyed' | 'pending' | 'claim-lost' | 'stale' | 'failed' | 'unconfirmed';

/** One bounded revoke attempt, and only on a confirmed read: the token is gone with the secret. */
async function revokeAtProvider(ctx: LineageCtx, claim: LineageClaim): Promise<boolean> {
    const hooks = ctx.providers(claim.provider);
    if (hooks?.revokeScope !== 'token' || !hooks.revoke) return true;
    const read = await readConfirmed(ctx, claim, undefined);
    if (!read.ok) return false;
    try {
        const result = await hooks.revoke({
            token: read.payload.refreshToken ?? read.payload.accessToken,
            signal: AbortSignal.timeout(ctx.timing.exchangeDeadlineMs),
        });
        ctx.log(result === 'revoked' ? 'revoke-attempted' : 'revoke-failed', claim.grantId);
    } catch {
        ctx.log('revoke-failed', claim.grantId);
    }
    return true;
}

async function deleteOnce(ctx: LineageCtx, claim: LineageClaim, expectedVersion: SecretVersion): Promise<DeleteStep> {
    const operationId = await ctx.secrets.issueOperationId().catch(() => null);
    if (!operationId) return 'unconfirmed';
    const ref = claim.secretRef as SecretRef;
    if (!(await recordOperation(ctx, claim, operationId, ref))) return 'claim-lost';
    const deleted = await replay(
        ctx,
        () => ctx.secrets.delete({ identity: identityOf(claim), ref, operationId, expectedVersion }),
        persistDeadline(ctx, claim)
    );
    if (deleted.kind === 'pending') return 'pending';
    if (deleted.kind === 'ok' || deleted.error.code === 'not-found') return 'destroyed';
    return deleted.error.reason === 'stale-version' ? 'stale' : 'failed';
}

/** The store holds a version this grant does not know: the version to delete at, when the store confirms one. */
async function confirmedVersion(ctx: LineageCtx, claim: LineageClaim): Promise<SecretVersion | null> {
    const current = await ctx.secrets
        .readActive({ identity: identityOf(claim), ref: claim.secretRef as SecretRef })
        .catch(() => null);
    return current?.ok ? current.version : null;
}

async function destroyUnderClaim(ctx: LineageCtx, claim: LineageClaim): Promise<DestroyResult> {
    if (!(await revokeAtProvider(ctx, claim))) return { ok: false, reason: 'unconfirmed' };
    let step = await deleteOnce(ctx, claim, claim.secretVersion as SecretVersion);
    if (step === 'stale') {
        const version = await confirmedVersion(ctx, claim);
        step = version ? await deleteOnce(ctx, claim, version) : 'failed';
    }
    if (step === 'destroyed') {
        const done = await finalizeLineage(ctx.sql, claim, { kind: 'destroy' });
        return done.ok ? { ok: true } : { ok: false, reason: 'claim-lost' };
    }
    if (step === 'pending' || step === 'claim-lost') return { ok: false, reason: step };
    // A definitive refusal ends the claim (the next pass starts over); an unconfirmed step does too.
    await endClaim(ctx, claim, { operation: true });
    return { ok: false, reason: step === 'unconfirmed' ? 'unconfirmed' : 'failed' };
}

export async function destroyRevokedSecret(ctx: LineageCtx, grantId: string): Promise<DestroyResult> {
    const claimed = await claimLineage(ctx, grantId, 'destroy', false);
    if (!claimed.ok) return { ok: false, reason: claimed.reason };
    try {
        return await destroyUnderClaim(ctx, claimed.claim);
    } catch (error) {
        // Whatever stopped this pass, the claim must not outlive it with a half-recorded operation.
        await endClaim(ctx, claimed.claim, { operation: true }).catch(() => undefined);
        throw error;
    }
}
