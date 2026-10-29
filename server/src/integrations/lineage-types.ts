import type { IntegrationOutcome, UnavailableReason } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { grantSecretIdentity, type LineageKind } from '../db/connection-grants.js';
import type { SecretIdentity, SecretStore } from '../secrets/secret-store.js';
import type { OAuthProviderLookup } from './oauth-provider.js';

/** The vocabulary and the shared context of the grant lineage modules; `grant-lineage.ts` documents the protocol. */

export interface LineageTiming {
    /** The absolute bound of one provider exchange. */
    exchangeDeadlineMs: number;
    /** The absolute bound of one SecretStore read. */
    readDeadlineMs: number;
    /** How long the holder replays an inconclusive mutation after a successful exchange. */
    persistBudgetMs: number;
    /** Slack so no takeover happens while the holder can still write. */
    marginMs: number;
    /** Pause between two identical replays. */
    retryDelayMs: number;
}

export const DEFAULT_LINEAGE_TIMING: LineageTiming = {
    exchangeDeadlineMs: 15_000,
    readDeadlineMs: 5_000,
    persistBudgetMs: 20_000,
    marginMs: 5_000,
    retryDelayMs: 100,
};

/** The claim lease: the read, the exchange, the whole persistence budget and a margin. */
export const leaseMsOf = (t: LineageTiming): number =>
    t.readDeadlineMs + t.exchangeDeadlineMs + t.persistBudgetMs + t.marginMs;

/** Closed diagnostics: a grant ID and an event name, never a token, a reference or a provider body. */
export interface LineageEvent {
    event:
        | 'refresh-joined'
        | 'reconnect-required'
        | 'secret-wedged'
        | 'persistence-lost'
        | 'persistence-pending'
        | 'revoke-attempted'
        | 'revoke-failed'
        | 'recovered';
    grantId: string;
}

export interface LineageClaim {
    token: string;
    kind: LineageKind;
    grantId: string;
    orgId: string;
    principalUserId: string;
    provider: string;
    version: number;
    secretRef: string | null;
    secretVersion: string | null;
    authority: Record<string, unknown>;
    /** The grant's current reference is wedged: a reconsent moves it to a fresh one. */
    wedged: boolean;
    /** Epoch milliseconds on this process's clock after which the lease may be taken over. */
    deadlineAt: number;
}

export type ClaimRefusal =
    | 'held'
    | 'recovery-needed'
    | 'abandoned'
    | 'revoked'
    | 'reconnect_required'
    | 'wedged'
    | 'no-secret'
    | 'not-found'
    | 'not-revoked'
    | 'nothing-to-destroy';

export type ClaimResult = { ok: true; claim: LineageClaim } | { ok: false; reason: ClaimRefusal };

export type CommitResult =
    | { ok: true; version: number; secretVersion: string }
    | { ok: false; reason: 'revoked' | 'claim-lost' | 'persistence-pending' }
    | { ok: false; reason: 'lost'; reconnectRequired: boolean };

export type RefreshResult = { ok: true } | { ok: false; outcome: IntegrationOutcome };

export type RecoverResult =
    | 'idle'
    | 'not-expired'
    | 'no-operation'
    | 'finalized'
    | 'destroyed'
    | 'released'
    | 'reconnect-required'
    | 'wedged'
    | 'left';

export type DestroyResult =
    | { ok: true }
    | { ok: false; reason: ClaimRefusal | 'pending' | 'failed' | 'claim-lost' | 'unconfirmed' };

export interface LineageCtx {
    sql: Sql;
    orgId: string;
    secrets: SecretStore;
    providers: OAuthProviderLookup;
    timing: LineageTiming;
    leaseMs: number;
    log: (event: LineageEvent['event'], grantId: string) => void;
}

export const required = (reason: 'missing' | 'reconnect', provider: string): RefreshResult => ({
    ok: false,
    outcome: { outcome: 'integration_required', reason, provider },
});

export const unavailable = (reason: UnavailableReason): RefreshResult => ({
    ok: false,
    outcome: { outcome: 'unavailable', reason, retryable: true },
});

export const identityOf = (claim: Pick<LineageClaim, 'grantId' | 'orgId' | 'principalUserId'>): SecretIdentity =>
    grantSecretIdentity({ id: claim.grantId, orgId: claim.orgId, principalUserId: claim.principalUserId });

export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
