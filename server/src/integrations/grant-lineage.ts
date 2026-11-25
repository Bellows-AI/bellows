import type { Sql } from 'postgres';
import type { SecretStore } from '../secrets/secret-store.js';
import { authorityScopes, type GrantPayload } from './grant-credentials.js';
import {
    abandonExpiredRefresh,
    claimLineage as claimStatement,
    endClaim,
    markInFlight,
    readLineage,
} from './lineage-claims.js';
import { commitLineage as commit, readConfirmed, settleAttempts } from './lineage-commit.js';
import { destroyRevokedSecret as destroy } from './lineage-destroy.js';
import { recoverLineage as recover } from './lineage-recovery.js';
import {
    type Attempts,
    type ClaimResult,
    createAttempts,
    type CommitResult,
    DEFAULT_LINEAGE_TIMING,
    type DestroyResult,
    type LineageClaim,
    type LineageCtx,
    type LineageEvent,
    type LineageTiming,
    leaseMsOf,
    type RecoverResult,
    type RefreshResult,
    required,
    unavailable,
} from './lineage-types.js';
import type { ExchangeResult, OAuthProviderHooks, OAuthProviderLookup } from './oauth-provider.js';
import type { LineageKind } from '../db/connection-grants.js';

/**
 * One grant is one refresh lineage. Whoever holds the lineage CLAIM (a lease token on the grant row) may
 * exchange the refresh token and persist what comes back; everyone else gets an immediate `refresh-in-progress`.
 * Every statement is a single UPDATE on the grant row and the exchange and every SecretStore call run with NO
 * transaction open, so no database lock is held across a provider call (the lock order puts the grant row
 * after the thread root and advisory locks and before the connection, and this code never takes more than it).
 *
 * New credentials live in exactly one place before they are stored: the memory of the process that exchanged
 * them. That process replays the IDENTICAL SecretStore mutation (same operation ID, same bytes, same expected
 * version) until the store answers or the lease ends; the OAuth exchange is never repeated. When the holder is
 * gone the payload is gone with it: an operation the store still calls `unknown` is a lost payload, the grant goes
 * to `reconnect_required`, and its reference is wedged (`docs/secrets.md`) and abandoned for a fresh one.
 * `docs/connections.md` states the limits.
 *
 * Modules: `lineage-claims.ts` (the claim statements), `lineage-commit.ts` (record, replay, finalize),
 * `lineage-recovery.ts` (step 7), `lineage-destroy.ts` (step 8); this file is the refresh flow and the facade.
 */

export type {
    ClaimRefusal,
    ClaimResult,
    CommitResult,
    DestroyResult,
    LineageClaim,
    LineageEvent,
    LineageTiming,
    RecoverResult,
    RefreshResult,
} from './lineage-types.js';
export { DEFAULT_LINEAGE_TIMING, leaseMsOf } from './lineage-types.js';

export interface GrantLineage {
    readonly timing: LineageTiming;
    readonly leaseMs: number;
    /** The mutations of this instance that may still be running; two instances stand in for two processes. */
    readonly attempts: Attempts;
    claimLineage(
        grantId: string,
        kind: LineageKind,
        options: { rotates: boolean; authorizationId?: string }
    ): Promise<ClaimResult>;
    /** Persists `payload` under the held claim (record, identical replay, finalize). The caller signal never reaches it. */
    commitLineage(claim: LineageClaim, payload: GrantPayload): Promise<CommitResult>;
    /**
     * Ends a claim whose holder did not exchange anything; `operation` also forgets a recorded operation,
     * `reconnect` sends the grant to `reconnect_required` (a spent rotating token), and `unrecordedOnly` leaves a
     * claim that has a recorded operation to recovery. Resolves true when it ended the claim.
     */
    releaseClaim(
        claim: Pick<LineageClaim, 'token' | 'grantId'>,
        options?: { operation?: boolean; reconnect?: boolean; unrecordedOnly?: boolean }
    ): Promise<boolean>;
    /**
     * `observedVersion` is the secret version the caller saw expired: a claim that finds another version stored was
     * beaten by a replica that already refreshed, and releases without exchanging (GitHub rotates both tokens on
     * every refresh, so a second exchange would kill the first caller's token).
     */
    refreshGrant(
        grantId: string,
        options?: { signal?: AbortSignal | undefined; observedVersion?: string | undefined }
    ): Promise<RefreshResult>;
    recoverLineage(grantId: string): Promise<RecoverResult>;
    destroyRevokedSecret(grantId: string): Promise<DestroyResult>;
    /** Resolves when no refresh, detached persistence or abandoned SecretStore mutation is running in this process. */
    idle(): Promise<void>;
}

export interface GrantLineageDeps {
    sql: Sql;
    orgId: string;
    secrets: SecretStore;
    providers: OAuthProviderLookup;
    timing?: Partial<LineageTiming>;
    log?: (event: LineageEvent) => void;
}

/** The exchange failed before the provider produced credentials. */
async function failedExchange(
    ctx: LineageCtx,
    claim: LineageClaim,
    answer: Extract<ExchangeResult, { ok: false }>,
    options: { rotating: boolean; retryTransient: boolean; aborted: boolean }
): Promise<{ result: RefreshResult; settled: boolean }> {
    if (answer.failure === 'not-sent') {
        return { result: unavailable(options.aborted ? 'aborted' : 'transport'), settled: false };
    }
    if (answer.failure === 'definitive' || (options.rotating && !options.retryTransient)) {
        // A spent (or possibly spent) rotating token is never replayed: the person must reconnect.
        await endClaim(ctx, claim, { reconnect: true });
        ctx.log('reconnect-required', claim.grantId);
        return { result: required('reconnect', claim.provider), settled: true };
    }
    // Reached for a provider that rotates nothing, or one that declares an unconfirmed answer retryable.
    await endClaim(ctx, claim, { provablyUnsent: true });
    return { result: unavailable(options.aborted ? 'aborted' : 'timeout'), settled: true };
}

const commitOutcome = (committed: CommitResult, provider: string): RefreshResult => {
    if (committed.ok) return { ok: true };
    if (committed.reason === 'revoked') return required('missing', provider);
    if (committed.reason === 'lost') {
        return committed.reconnectRequired ? required('reconnect', provider) : unavailable('secret-unavailable');
    }
    return unavailable(committed.reason === 'persistence-pending' ? 'persistence-pending' : 'secret-unavailable');
};

const payloadOf = (
    tokens: Extract<ExchangeResult, { ok: true }>['tokens'],
    spent: GrantPayload,
    claim: LineageClaim
): GrantPayload => ({
    accessToken: tokens.accessToken,
    accessExpiresAt: tokens.expiresAt,
    // Only a provider that rotates nothing reaches the fallback: a rotating one without a replacement never commits.
    refreshToken: tokens.refreshToken ?? spent.refreshToken,
    authority: tokens.authority ?? { scopes: authorityScopes(claim.authority) ?? spent.authority.scopes },
});

/**
 * Ends a claim whose holder settled nothing (an error, or an answer it could not act on). Nothing was spent, or the
 * provider declares a retry safe: the claim is released (`provablyUnsent`). A rotating token that may have been spent
 * is sent to reconnect, tried once more here; if the database refuses that too the claim STAYS (`endClaim` refuses any
 * other end of a claim marked in flight), blocking every other caller until it lapses and recovery reads it as
 * reconnect-needed.
 */
async function closeUnsettled(
    ctx: LineageCtx,
    claim: LineageClaim,
    hooks: OAuthProviderHooks,
    possiblySpent: boolean
): Promise<void> {
    const spent = possiblySpent && hooks.rotatesRefreshToken && hooks.retryTransientRefresh !== true;
    const ended = await endClaim(ctx, claim, spent ? { reconnect: true } : { provablyUnsent: true }).catch(() => false);
    if (ended && spent) ctx.log('reconnect-required', claim.grantId);
}

/**
 * A rotating provider's success that does not carry a replacement refresh token (absent, empty, or the one just
 * sent) spent the old token and gave nothing to store: it is never committed over the old token, which a later
 * refresh would replay. The grant goes to reconnect through the guarded exit, whatever the provider says about retries.
 * Null when the answer is usable (and always, for a provider that rotates nothing and keeps its token).
 */
async function rotationLost(
    ctx: LineageCtx,
    claim: LineageClaim,
    hooks: OAuthProviderHooks,
    found: { answer: Extract<ExchangeResult, { ok: true }>; sent: string }
): Promise<{ result: RefreshResult; settled: boolean } | null> {
    const next = found.answer.tokens.refreshToken;
    if (!hooks.rotatesRefreshToken || (next && next !== found.sent)) return null;
    return failedExchange(
        ctx,
        claim,
        { ok: false, failure: 'ambiguous' },
        { rotating: true, retryTransient: false, aborted: false }
    );
}

/** Steps 2-6 under a held claim. The claim ends exactly one way: released here, ended by the failure, or committed. */
async function exchangeUnderClaim(
    ctx: LineageCtx,
    claim: LineageClaim,
    hooks: OAuthProviderHooks,
    attempt: { signal: AbortSignal | undefined; observedVersion: string | undefined }
): Promise<RefreshResult> {
    const { signal, observedVersion } = attempt;
    let settled = false;
    // True from the moment a refresh request may reach the provider until its answer proves otherwise: a rotating
    // provider may have spent the token, and then an error here must never turn into an ordinary release.
    let possiblySpent = false;
    try {
        // 1. Under the claim, a version other than the one the caller saw expired is already a fresh credential.
        if (observedVersion !== undefined && claim.secretVersion !== observedVersion) return { ok: true };
        // 2. Read: any answer that is not a confirmed value of the stored version releases the claim.
        const read = await readConfirmed(ctx, claim, signal);
        if (!read.ok) return unavailable('secret-unavailable');
        const refreshToken = read.payload.refreshToken;
        if (refreshToken === null) {
            settled = true;
            await endClaim(ctx, claim, { reconnect: true });
            ctx.log('reconnect-required', claim.grantId);
            return required('reconnect', claim.provider);
        }

        // 3. Exchange, under an absolute deadline combined with the caller's signal.
        const bound = AbortSignal.timeout(ctx.timing.exchangeDeadlineMs);
        // Durable, and before the request can leave: from here the claim ends only by commit or by reconnect. A mark
        // that fails or is refused sent nothing.
        if (hooks.rotatesRefreshToken && !(await markInFlight(ctx, claim))) return unavailable('refresh-in-progress');
        possiblySpent = true;
        const answer: ExchangeResult = await hooks
            .refresh({ refreshToken, signal: signal ? AbortSignal.any([signal, bound]) : bound })
            .catch((): ExchangeResult => ({ ok: false, failure: 'ambiguous' }));
        if (!answer.ok && answer.failure === 'not-sent') possiblySpent = false;
        if (!answer.ok) {
            const failed = await failedExchange(ctx, claim, answer, {
                rotating: hooks.rotatesRefreshToken,
                retryTransient: hooks.retryTransientRefresh === true,
                aborted: signal?.aborted === true,
            });
            settled = failed.settled;
            return failed.result;
        }

        const unusable = await rotationLost(ctx, claim, hooks, { answer, sent: refreshToken });
        if (unusable) {
            settled = unusable.settled;
            return unusable.result;
        }

        // Success: from here the caller's signal is detached; only the lease governs persistence.
        settled = true;
        return commitOutcome(await commit(ctx, claim, payloadOf(answer.tokens, read.payload, claim)), claim.provider);
    } finally {
        if (!settled) await closeUnsettled(ctx, claim, hooks, possiblySpent);
    }
}

async function runRefresh(
    ctx: LineageCtx,
    grantId: string,
    attempt: { signal: AbortSignal | undefined; observedVersion: string | undefined }
): Promise<RefreshResult> {
    const info = await readLineage(ctx, grantId);
    if (!info) return required('missing', '');
    const hooks = ctx.providers(info.provider);
    if (!hooks) return unavailable('secret-unavailable');
    for (let round = 0; ; round += 1) {
        const claimed = await claimStatement(ctx, grantId, 'refresh', { rotates: hooks.rotatesRefreshToken });
        if (claimed.ok) return exchangeUnderClaim(ctx, claimed.claim, hooks, attempt);
        switch (claimed.reason) {
            case 'held':
                return unavailable('refresh-in-progress');
            case 'revoked':
            case 'not-found':
                return required('missing', info.provider);
            case 'reconnect_required':
            case 'wedged':
                return required('reconnect', info.provider);
            case 'no-secret':
                return unavailable('credential-pending');
            case 'abandoned':
                await abandonExpiredRefresh(ctx, grantId);
                ctx.log('reconnect-required', grantId);
                return required('reconnect', info.provider);
            case 'recovery-needed':
                if (round > 0) return unavailable('persistence-pending');
                await recover(ctx, grantId);
                break;
            default:
                return unavailable('secret-unavailable');
        }
    }
}

export function createGrantLineage(deps: GrantLineageDeps): GrantLineage {
    const timing: LineageTiming = { ...DEFAULT_LINEAGE_TIMING, ...deps.timing };
    const leaseMs = leaseMsOf(timing);
    const ctx: LineageCtx = {
        attempts: createAttempts(),
        sql: deps.sql,
        orgId: deps.orgId,
        secrets: deps.secrets,
        providers: deps.providers,
        timing,
        leaseMs,
        log: (event, grantId) => deps.log?.({ event, grantId }),
    };
    const inflight = new Map<string, Promise<RefreshResult>>();

    /** One flight per grant per process; a caller that goes away leaves the flight (and its persistence) running. */
    function refreshGrant(
        grantId: string,
        options: { signal?: AbortSignal | undefined; observedVersion?: string | undefined } = {}
    ): Promise<RefreshResult> {
        const { signal, observedVersion } = options;
        let run = inflight.get(grantId);
        if (run) {
            ctx.log('refresh-joined', grantId);
        } else {
            const started: Promise<RefreshResult> = runRefresh(ctx, grantId, { signal, observedVersion })
                .catch((): RefreshResult => unavailable('secret-unavailable'))
                .finally(() => {
                    if (inflight.get(grantId) === started) inflight.delete(grantId);
                });
            inflight.set(grantId, started);
            run = started;
        }
        if (!signal) return run;
        const aborted = new Promise<RefreshResult>((resolve) => {
            if (signal.aborted) resolve(unavailable('aborted'));
            else signal.addEventListener('abort', () => resolve(unavailable('aborted')), { once: true });
        });
        return Promise.race([run, aborted]);
    }

    return {
        timing,
        leaseMs,
        attempts: ctx.attempts,
        claimLineage: (grantId, kind, options) => claimStatement(ctx, grantId, kind, options),
        commitLineage: (claim, payload) => commit(ctx, claim, payload),
        releaseClaim: (claim, options) => endClaim(ctx, claim, options ?? {}),
        refreshGrant,
        recoverLineage: (grantId) => recover(ctx, grantId),
        destroyRevokedSecret: (grantId) => destroy(ctx, grantId),
        idle: async () => {
            while (inflight.size > 0) await Promise.allSettled([...inflight.values()]);
            await settleAttempts(ctx.attempts);
        },
    };
}
