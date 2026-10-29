import { finalizeLineage, type LineageKind } from '../db/connection-grants.js';
import type { OperationId, OperationStatus, SecretRef, SecretVersion } from '../secrets/secret-store.js';
import { endClaim, type LineageRow, readLineage } from './lineage-claims.js';
import { readConfirmed } from './lineage-commit.js';
import { identityOf, type LineageCtx, type RecoverResult } from './lineage-types.js';

/**
 * Recovery of a claim whose lease lapsed with an operation recorded (step 7), dispatched on the claim kind. The
 * claim is acted on only through statements guarded by its own token, so two recoverers cannot both finalize.
 * Anything the store did not confirm leaves the grant exactly as it was.
 */

interface Held {
    token: string;
    grantId: string;
    kind: LineageKind;
    rotating: boolean;
    row: LineageRow;
    ref: SecretRef;
}

/** The credentials are lost: recorded but never run, or run and failed. */
async function lost(ctx: LineageCtx, held: Held): Promise<RecoverResult> {
    if (held.kind !== 'destroy' && held.rotating) {
        await endClaim(ctx, held, { operation: true, reconnect: true });
        ctx.log('reconnect-required', held.grantId);
        return 'reconnect-required';
    }
    await endClaim(ctx, held, { operation: true });
    return 'released';
}

/** The holder is gone and the payload with it: nobody can replay, and the store refuses every other mutation. */
async function wedge(ctx: LineageCtx, held: Held): Promise<RecoverResult> {
    await endClaim(ctx, held, { reconnect: true, wedged: true });
    ctx.log('secret-wedged', held.grantId);
    return 'wedged';
}

async function recoverDestroy(ctx: LineageCtx, held: Held, status: OperationStatus): Promise<RecoverResult> {
    if (status.state === 'failed') return lost(ctx, held);
    if (status.state !== 'succeeded' || status.result.version !== null) return 'left';
    const done = await finalizeLineage(
        ctx.sql,
        { orgId: ctx.orgId, grantId: held.grantId, token: held.token },
        { kind: 'destroy' }
    );
    if (done.ok) ctx.log('recovered', held.grantId);
    return done.ok ? 'destroyed' : 'left';
}

async function recoverCredentials(ctx: LineageCtx, held: Held, status: OperationStatus): Promise<RecoverResult> {
    if (status.state === 'failed') return lost(ctx, held);
    if (status.state !== 'succeeded') return wedge(ctx, held);
    const secretVersion = status.result.version as SecretVersion | null;
    if (secretVersion === null || held.kind === 'destroy') return 'left';
    // Succeeded: the new credentials are the active version. Read them back for the authority, then finalize.
    const read = await readConfirmed(
        ctx,
        {
            token: held.token,
            kind: held.kind,
            grantId: held.grantId,
            orgId: ctx.orgId,
            principalUserId: held.row.principal_user_id,
            provider: held.row.provider,
            version: Number(held.row.version),
            secretRef: held.ref,
            secretVersion,
            authority: held.row.authority,
            wedged: false,
            deadlineAt: Date.now() + ctx.timing.readDeadlineMs,
        },
        undefined
    );
    if (!read.ok) return 'left';
    const done = await finalizeLineage(
        ctx.sql,
        { orgId: ctx.orgId, grantId: held.grantId, token: held.token },
        { kind: held.kind, secretVersion, authority: read.payload.authority }
    );
    if (done.ok) ctx.log('recovered', held.grantId);
    return done.ok ? 'finalized' : 'left';
}

function heldBy(ctx: LineageCtx, row: LineageRow): Held | RecoverResult {
    if (!row.lineage_claim) return 'idle';
    if (row.expired !== true) return 'not-expired';
    if (!row.lineage_operation_id || !row.lineage_secret_ref || !row.lineage_claim_kind) return 'no-operation';
    const kind = row.lineage_claim_kind;
    const hooks = ctx.providers(row.provider);
    return {
        token: row.lineage_claim,
        grantId: row.id,
        kind,
        rotating: kind === 'reconsent' || (hooks?.rotatesRefreshToken ?? true),
        row,
        ref: row.lineage_secret_ref as SecretRef,
    };
}

export async function recoverLineage(ctx: LineageCtx, grantId: string): Promise<RecoverResult> {
    const row = await readLineage(ctx, grantId);
    if (!row) return 'idle';
    const target = heldBy(ctx, row);
    if (typeof target === 'string') return target;

    const reconciled = await ctx.secrets
        .reconcileOperation({
            identity: identityOf({ grantId, orgId: ctx.orgId, principalUserId: row.principal_user_id }),
            ref: target.ref,
            operationId: row.lineage_operation_id as OperationId,
        })
        .catch(() => null);
    if (!reconciled) return 'left';
    // `not-found` is the store's confirmed "that operation never ran"; any other refusal is inconclusive.
    if (!reconciled.ok) return reconciled.error.code === 'not-found' ? lost(ctx, target) : 'left';
    return target.kind === 'destroy'
        ? recoverDestroy(ctx, target, reconciled.status)
        : recoverCredentials(ctx, target, reconciled.status);
}
