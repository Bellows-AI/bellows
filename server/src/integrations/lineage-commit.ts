import { finalizeLineage } from '../db/connection-grants.js';
import { createSecretRef } from '../secrets/secret-input.js';
import type { OperationId, SecretError, SecretRef, SecretResult, SecretVersion } from '../secrets/secret-store.js';
import { decodeGrantPayload, encodeGrantPayload, type GrantPayload } from './grant-credentials.js';
import { endClaim, readLineage, recordOperation } from './lineage-claims.js';
import {
    type Attempts,
    type CommitResult,
    grantAttemptKey,
    identityOf,
    type LineageClaim,
    type LineageCtx,
    pause,
} from './lineage-types.js';

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

/**
 * The window one mutation may run in. `fenceAt` is absolute: no attempt starts at or after it and an attempt in flight
 * is told to abort then, because past it recovery may treat the claim as dead. `retryUntil` only ends the retries: the
 * first attempt always gets its chance inside the fence.
 */
export interface ReplayLimits {
    fenceAt: number;
    retryUntil: number;
}

/**
 * Mitigation, not the fence: SecretStore mutations that may still be running in this runtime instance, by key. A
 * mutation that ignores its abort signal stays here until it settles, so a recovery of the same instance leaves the
 * grant meanwhile. Correctness across instances is the store-side fence (`operation-fence.ts`).
 */
export const attemptsLive = (attempts: Attempts, key: string): boolean => (attempts.live.get(key)?.size ?? 0) > 0;

/** Resolves when no tracked mutation is running in this instance. */
export async function settleAttempts(attempts: Attempts): Promise<void> {
    while (attempts.live.size > 0) {
        await Promise.allSettled([...attempts.live.values()].flatMap((running) => [...running]));
    }
}

function track(attempts: Attempts, key: string, running: Promise<unknown>): void {
    let set = attempts.live.get(key);
    if (!set) {
        set = new Set();
        attempts.live.set(key, set);
    }
    set.add(running);
    void running.then(() => {
        set.delete(running);
        if (set.size === 0 && attempts.live.get(key) === set) attempts.live.delete(key);
    });
}

/** One attempt, abandoned (not forgotten) when the fence passes. A throw is an inconclusive answer. */
async function attemptWithin<T extends object>(
    attempts: Attempts,
    key: string,
    attempt: (signal: AbortSignal) => Promise<SecretResult<T>>,
    ms: number
): Promise<SecretResult<T> | null | 'fenced'> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fenced = new Promise<'fenced'>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve('fenced');
        }, ms);
    });
    const running = (async () => attempt(controller.signal))().catch(() => null);
    track(attempts, key, running);
    try {
        return await Promise.race([running, fenced]);
    } finally {
        clearTimeout(timer);
    }
}

/** Replays one mutation, identically, until the store answers definitively or the limits end it. */
export async function replay<T extends object>(
    ctx: LineageCtx,
    key: string,
    attempt: (signal: AbortSignal) => Promise<SecretResult<T>>,
    limits: ReplayLimits
): Promise<Replayed<T>> {
    for (let first = true; ; first = false) {
        const now = Date.now();
        if (now >= limits.fenceAt || (!first && now >= limits.retryUntil)) return { kind: 'pending' };
        const result = await attemptWithin(ctx.attempts, key, attempt, limits.fenceAt - now);
        if (result === 'fenced') return { kind: 'pending' };
        if (result?.ok) return { kind: 'ok', result: result as Extract<SecretResult<T>, { ok: true }> };
        if (result && DEFINITIVE.has(result.error.code)) return { kind: 'definitive', error: result.error };
        await pause(ctx.timing.retryDelayMs);
    }
}

/** A claim's mutation may not run past its lease minus the margin, nor retry past the persistence budget. */
export const persistLimits = (ctx: LineageCtx, claim: Pick<LineageClaim, 'deadlineAt'>): ReplayLimits => {
    const fenceAt = claim.deadlineAt - ctx.timing.marginMs;
    return { fenceAt, retryUntil: Math.min(fenceAt, Date.now() + ctx.timing.persistBudgetMs) };
};

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
    const key = grantAttemptKey(claim.orgId, claim.grantId);
    const limits = persistLimits(ctx, claim);
    if (fresh) {
        return replay(
            ctx,
            key,
            (signal) => ctx.secrets.create({ identity, ref, operationId, payload: bytes, signal }),
            limits
        );
    }
    const expectedVersion = claim.secretVersion as SecretVersion;
    return replay(
        ctx,
        key,
        (signal) => ctx.secrets.replace({ identity, ref, operationId, expectedVersion, payload: bytes, signal }),
        limits
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
    if (persisted.kind === 'definitive') {
        // A recovery bound this operation ID to its fence before the request arrived: nothing was written.
        if (persisted.error.reason === 'operation-id-reused') ctx.log('fenced', claim.grantId);
        return lose(ctx, claim, rotating);
    }

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
