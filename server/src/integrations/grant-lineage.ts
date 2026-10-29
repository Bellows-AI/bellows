import type { Sql } from 'postgres';
import type { SecretStore } from '../secrets/secret-store.js';
import { authorityScopes, type GrantPayload } from './grant-credentials.js';
import { abandonExpiredRefresh, claimLineage as claimStatement, endClaim, readLineage } from './lineage-claims.js';
import { commitLineage as commit, readConfirmed } from './lineage-commit.js';
import { destroyRevokedSecret as destroy } from './lineage-destroy.js';
import { recoverLineage as recover } from './lineage-recovery.js';
import {
    type ClaimResult,
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
 * transaction open, so no database lock is held across a provider call (the BEL-59 lock order puts the grant row
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
    claimLineage(grantId: string, kind: LineageKind, options: { rotates: boolean }): Promise<ClaimResult>;
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
    refreshGrant(grantId: string, options?: { signal?: AbortSignal | undefined }): Promise<RefreshResult>;
    recoverLineage(grantId: string): Promise<RecoverResult>;
    destroyRevokedSecret(grantId: string): Promise<DestroyResult>;
    /** Resolves when no refresh (and no detached persistence) is in flight in this process. */
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
    options: { rotating: boolean; aborted: boolean }
): Promise<{ result: RefreshResult; settled: boolean }> {
    if (answer.failure === 'not-sent') {
        return { result: unavailable(options.aborted ? 'aborted' : 'transport'), settled: false };
    }
    if (answer.failure === 'definitive' || options.rotating) {
        // A spent (or possibly spent) rotating token is never replayed: the person must reconnect.
        await endClaim(ctx, claim, { reconnect: true });
        ctx.log('reconnect-required', claim.grantId);
        return { result: required('reconnect', claim.provider), settled: true };
    }
    await endClaim(ctx, claim, {});
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
    refreshToken: tokens.refreshToken ?? spent.refreshToken,
    authority: tokens.authority ?? { scopes: authorityScopes(claim.authority) ?? spent.authority.scopes },
});

/** Steps 2-6 under a held claim. The claim ends exactly one way: released here, ended by the failure, or committed. */
async function exchangeUnderClaim(
    ctx: LineageCtx,
    claim: LineageClaim,
    hooks: OAuthProviderHooks,
    signal: AbortSignal | undefined
): Promise<RefreshResult> {
    let settled = false;
    try {
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
        const answer: ExchangeResult = await hooks
            .refresh({ refreshToken, signal: signal ? AbortSignal.any([signal, bound]) : bound })
            .catch((): ExchangeResult => ({ ok: false, failure: 'ambiguous' }));
        if (!answer.ok) {
            const failed = await failedExchange(ctx, claim, answer, {
                rotating: hooks.rotatesRefreshToken,
                aborted: signal?.aborted === true,
            });
            settled = failed.settled;
            return failed.result;
        }

        // Success: from here the caller's signal is detached; only the lease governs persistence.
        settled = true;
        return commitOutcome(await commit(ctx, claim, payloadOf(answer.tokens, read.payload, claim)), claim.provider);
    } finally {
        if (!settled) await endClaim(ctx, claim).catch(() => undefined);
    }
}

async function runRefresh(ctx: LineageCtx, grantId: string, signal: AbortSignal | undefined): Promise<RefreshResult> {
    const info = await readLineage(ctx, grantId);
    if (!info) return required('missing', '');
    const hooks = ctx.providers(info.provider);
    if (!hooks) return unavailable('secret-unavailable');
    for (let round = 0; ; round += 1) {
        const claimed = await claimStatement(ctx, grantId, 'refresh', hooks.rotatesRefreshToken);
        if (claimed.ok) return exchangeUnderClaim(ctx, claimed.claim, hooks, signal);
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
    function refreshGrant(grantId: string, options: { signal?: AbortSignal | undefined } = {}): Promise<RefreshResult> {
        const { signal } = options;
        let run = inflight.get(grantId);
        if (run) {
            ctx.log('refresh-joined', grantId);
        } else {
            const started: Promise<RefreshResult> = runRefresh(ctx, grantId, signal)
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
        claimLineage: (grantId, kind, { rotates }) => claimStatement(ctx, grantId, kind, rotates),
        commitLineage: (claim, payload) => commit(ctx, claim, payload),
        releaseClaim: (claim, options) => endClaim(ctx, claim, options ?? {}),
        refreshGrant,
        recoverLineage: (grantId) => recover(ctx, grantId),
        destroyRevokedSecret: (grantId) => destroy(ctx, grantId),
        idle: async () => {
            while (inflight.size > 0) await Promise.allSettled([...inflight.values()]);
        },
    };
}
