import type { IntegrationOutcome, UnavailableReason } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { closeForgeRequirementsOfMember } from '../db/forge-requirement.js';
import { errorClass, logger } from '../log.js';
import { type GrantStanding, readGrantStanding } from '../db/forge-grant-standing.js';
import { grantSecretIdentity } from '../db/connection-grants.js';
import { orgSql } from '../db/org-sql.js';
import type { SecretRef, SecretStore, SecretVersion } from '../secrets/secret-store.js';
import { grantOfAccount } from './authorization-store.js';
import { decodeGrantPayload, type GrantPayload } from './grant-credentials.js';
import type { GrantLineage } from './grant-lineage.js';

/**
 * A member's grant on a forge (docs/connections.md): the token pair the forge's own user authorization issued at
 * sign-in, kept as one `integration_grant` lineage per organization, keyed by member and forge. `forge` is the grant's
 * `provider` (`github` here; a host-qualified `gitlab:<host>` the same way). The token lives in the secret store, the
 * row carries only its reference; the lineage owns the single-flight refresh, the claim and the recovery.
 *
 * Every read here either confirms an answer or throws: a failed or timed-out read is never "missing" (AGENTS.md).
 */

export type MemberGrantStanding = GrantStanding;

/** What a sign-in's code exchange hands over: the forge's own token pair, lifetimes in seconds. */
export interface MemberGrantTokens {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
}

export interface StoreMemberGrantInput {
    orgId: string;
    userId: string;
    forge: string;
    /** The forge's identity of the member (the GitHub user id): what the grant's lineage is unique on in the org. */
    externalAccountId: string;
    tokens: MemberGrantTokens;
}

/** Why a sign-in's tokens did not become the grant. The previous grant, if any, stands untouched. */
export type StoreMemberGrantRefusal = 'conflict' | 'busy' | 'pending' | 'lost' | 'unavailable';
export type StoreMemberGrantResult = { ok: true } | { ok: false; reason: StoreMemberGrantRefusal };

export type MemberTokenResult =
    | { ok: true; accessToken: string; expiresAt: number | null }
    | { ok: false; outcome: IntegrationOutcome };

export interface MemberForgeGrants {
    /** Insert or replace the member's grant in the org with the pair a sign-in just obtained. */
    store(input: StoreMemberGrantInput): Promise<StoreMemberGrantResult>;
    /** `live` is a grant the board can use, `broken` one that needs the member to sign in again, `missing` none. */
    standing(orgId: string, userId: string, forge: string): Promise<MemberGrantStanding>;
    /** A usable access token, refreshing an expiring one through the lineage (one refresh across replicas). */
    accessToken(
        orgId: string,
        userId: string,
        forge: string,
        options?: { signal?: AbortSignal | undefined }
    ): Promise<MemberTokenResult>;
    /** The forge says the member revoked the authorization: every org's live grant of the account is broken. */
    revokeAuthorization(forge: string, externalAccountId: string): Promise<number>;
}

export interface MemberForgeGrantsDeps {
    /** The request pool: each org's statements run on it scoped to their org (`orgSql`). */
    sql: Sql;
    /** The cross-org pool: a revocation names an account, not an org. */
    crossOrgSql: Sql;
    /** Resolves when the migrations the grant table needs have run. */
    ready?: Promise<unknown> | undefined;
    secrets: SecretStore;
    lineageOf(orgId: string): GrantLineage;
    /** A token expiring within this window is refreshed first. */
    skewMs?: number;
    readDeadlineMs?: number;
    now?: () => number;
}

const DEFAULT_SKEW_MS = 60_000;
const DEFAULT_READ_DEADLINE_MS = 5_000;
const MS_PER_SECOND = 1000;

const unavailable = (reason: UnavailableReason): { ok: false; outcome: IntegrationOutcome } => ({
    ok: false,
    outcome: { outcome: 'unavailable', reason, retryable: true },
});
const required = (reason: 'missing' | 'reconnect', forge: string): { ok: false; outcome: IntegrationOutcome } => ({
    ok: false,
    outcome: { outcome: 'integration_required', reason, provider: forge },
});

interface GrantRow {
    id: string;
    status: string;
    secret_ref: string | null;
    secret_version: string | null;
    secret_wedged_at: Date | null;
}

type Settings = Required<Pick<MemberForgeGrantsDeps, 'skewMs' | 'readDeadlineMs' | 'now'>> & MemberForgeGrantsDeps;

/** The member's non-revoked grant on the forge in the org: a confirmed absence is `null`, a thrown query propagates. */
async function readMemberGrant(deps: Settings, orgId: string, userId: string, forge: string): Promise<GrantRow | null> {
    const rows = await orgSql(deps.sql, orgId)<GrantRow[]>`
        select id, status, secret_ref, secret_version, secret_wedged_at from integration_grant
        where org_id = ${orgId} and principal_user_id = ${userId} and provider = ${forge} and status <> 'revoked'
        order by updated_at desc
        limit 1
    `;
    return rows[0] ?? null;
}

/**
 * The row a sign-in's tokens land on. A first sign-in inserts it as `reconnect_required` with no secret: it is not
 * usable until the lineage's `reconsent` commit has stored the secret and activated it, so a half-stored grant is never
 * live. A racing insert of the same account finds the other's row.
 */
async function rowForSignIn(deps: Settings, input: StoreMemberGrantInput): Promise<string | 'conflict'> {
    const { orgId, userId, forge, externalAccountId } = input;
    const db = orgSql(deps.sql, orgId);
    const find = () => grantOfAccount({ sql: db, orgId }, forge, externalAccountId);
    let existing = await find();
    if (!existing) {
        await db`
            insert into integration_grant
                (org_id, principal_kind, principal_user_id, provider, external_account_id, authority, status)
            values (${orgId}, 'user', ${userId}, ${forge}, ${externalAccountId}, ${db.json({ scopes: [] })},
                    'reconnect_required')
            on conflict do nothing
        `;
        existing = await find();
    }
    if (!existing || existing.principalUserId !== userId) return 'conflict';
    return existing.id;
}

const payloadOf = (deps: Settings, tokens: MemberGrantTokens): GrantPayload => ({
    accessToken: tokens.accessToken,
    accessExpiresAt: deps.now() + tokens.expiresIn * MS_PER_SECOND,
    refreshToken: tokens.refreshToken,
    authority: { scopes: [] },
});

/**
 * The grant is live again: the member's threads waiting on it stop saying so. Presentation only — the claim re-reads the
 * grant and heals any wait this misses — so it takes no lock, runs after the lineage's commit, and a failure is logged,
 * never the sign-in's.
 */
async function closeOpenForgeWaits(deps: Settings, { orgId, userId, forge }: StoreMemberGrantInput): Promise<void> {
    try {
        await closeForgeRequirementsOfMember(orgSql(deps.sql, orgId), { orgId, userId, forge });
    } catch (err) {
        logger('integrations').error({ err: errorClass(err) }, 'closing the forge waits of a re-linked member failed');
    }
}

async function storeGrant(deps: Settings, input: StoreMemberGrantInput): Promise<StoreMemberGrantResult> {
    await deps.ready;
    const grantId = await rowForSignIn(deps, input);
    if (grantId === 'conflict') return { ok: false, reason: 'conflict' };
    const lineage = deps.lineageOf(input.orgId);
    // The sign-in is a fresh consent: it replaces the lineage's credentials under the same claim a reconnect takes.
    const claimed = await lineage.claimLineage(grantId, 'reconsent', { rotates: true });
    if (!claimed.ok) return { ok: false, reason: claimed.reason === 'held' ? 'busy' : 'unavailable' };
    const committed = await lineage.commitLineage(claimed.claim, payloadOf(deps, input.tokens));
    if (committed.ok) {
        await closeOpenForgeWaits(deps, input);
        return { ok: true };
    }
    return { ok: false, reason: committed.reason === 'persistence-pending' ? 'pending' : 'lost' };
}

async function readSecret(
    deps: Settings,
    who: { orgId: string; userId: string },
    read: { grant: GrantRow; signal: AbortSignal | undefined }
) {
    const { grant, signal } = read;
    const bound = AbortSignal.timeout(deps.readDeadlineMs);
    try {
        const stored = await deps.secrets.readActive({
            identity: grantSecretIdentity({ id: grant.id, orgId: who.orgId, principalUserId: who.userId }),
            ref: grant.secret_ref as SecretRef,
            signal: signal ? AbortSignal.any([signal, bound]) : bound,
        });
        if (!stored.ok || (stored.version as SecretVersion) !== grant.secret_version) return null;
        return decodeGrantPayload(stored.value);
    } catch {
        // A thrown read or a payload that does not decode is not "no credential": the caller leaves the grant alone.
        return null;
    }
}

async function tokenOnce(
    deps: Settings,
    who: { orgId: string; userId: string; forge: string },
    signal: AbortSignal | undefined,
    mayRefresh: boolean
): Promise<MemberTokenResult> {
    const { orgId, userId, forge } = who;
    const grant = await readMemberGrant(deps, orgId, userId, forge);
    if (!grant) return required('missing', forge);
    if (grant.status !== 'active' || grant.secret_wedged_at !== null) return required('reconnect', forge);
    if (grant.secret_ref === null || grant.secret_version === null) return unavailable('credential-pending');
    const payload = await readSecret(deps, who, { grant, signal });
    if (!payload) return unavailable('secret-unavailable');
    if (payload.accessExpiresAt !== null && payload.accessExpiresAt - deps.skewMs <= deps.now()) {
        if (!mayRefresh) return unavailable('refresh-in-progress');
        const refreshed = await deps
            .lineageOf(orgId)
            .refreshGrant(grant.id, { signal, observedVersion: grant.secret_version });
        // Whatever the refresh did, the grant and its stored credential are read again from the top.
        return refreshed.ok ? tokenOnce(deps, who, signal, false) : refreshed;
    }
    return { ok: true, accessToken: payload.accessToken, expiresAt: payload.accessExpiresAt };
}

export function createMemberForgeGrants(deps: MemberForgeGrantsDeps): MemberForgeGrants {
    const settings: Settings = {
        ...deps,
        skewMs: deps.skewMs ?? DEFAULT_SKEW_MS,
        readDeadlineMs: deps.readDeadlineMs ?? DEFAULT_READ_DEADLINE_MS,
        now: deps.now ?? Date.now,
    };
    return {
        store: (input) => storeGrant(settings, input),

        async standing(orgId, userId, forge) {
            await deps.ready;
            return readGrantStanding(orgSql(deps.sql, orgId), { orgId, userId, forge });
        },

        async accessToken(orgId, userId, forge, options = {}) {
            try {
                await deps.ready;
                return await tokenOnce(settings, { orgId, userId, forge }, options.signal, true);
            } catch {
                // A thrown query or read is not an absence: the caller may retry.
                return unavailable('secret-unavailable');
            }
        },

        async revokeAuthorization(forge, externalAccountId) {
            await deps.ready;
            const rows = await deps.crossOrgSql<{ id: string }[]>`
                update integration_grant set status = 'reconnect_required', updated_at = now()
                where provider = ${forge} and external_account_id = ${externalAccountId} and status = 'active'
                returning id
            `;
            return rows.length;
        },
    };
}
