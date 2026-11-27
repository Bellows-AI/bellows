import type { Sql } from 'postgres';
import { SYSTEM_ACTOR } from '../auth/member-removal.js';
import { withLease } from '../db/background-lease.js';
import { grantSecretIdentity } from '../db/connection-grants.js';
import { revokeConnectionsInTx } from '../db/connection-revocation.js';
import { startIntervalLoop } from '../interval-loop.js';
import { logger } from '../log.js';
import type { SecretRef, SecretVersion } from '../secrets/secret-store.js';
import { decodeGrantPayload } from './grant-credentials.js';
import type { IntegrationRuntime } from './integration-recovery.js';

/**
 * The re-check of what a connection's account still reaches at its provider (docs/connections.md, "Revocation").
 * The providers push nothing (Atlassian's 3LO apps get no lifecycle webhook), so a loop asks: on every replica,
 * behind one lease so a cycle runs on one at a time. `recheckAccounts` is the cycle and the one place a later
 * account-level check joins it (BEL-601's closed and updated accounts); `recheckSiteAccess` is its first step.
 *
 * A confirmed loss revokes through `revokeConnectionsInTx`. A failed, timed-out, empty or malformed answer, an
 * unreadable secret and a refresh that did not answer are inconclusive: nothing changes and the next cycle retries.
 * `server/test-db/account-recheck.test.ts`.
 */

export const ACCOUNT_RECHECK_LEASE = 'account-recheck';
export const ACCOUNT_RECHECK_INTERVAL_MS = 300_000;
/** The lease outlasts a full pass of every deadline below; a longer pass is tolerated, never relied on. */
export const ACCOUNT_RECHECK_LEASE_MS = 600_000;
/** A connection confirmed this recently is not asked again. */
export const SITE_RECHECK_AFTER_MS = 3_600_000;
/** Grants one cycle may ask the provider about, so a backlog cannot make a tick unbounded. */
export const SITE_RECHECK_LIMIT = 50;
const SITE_READ_DEADLINE_MS = 5_000;
const SITE_CALL_DEADLINE_MS = 10_000;
const TOKEN_SKEW_MS = 60_000;

export interface RecheckOptions {
    /** The providers a step asks about; the ones whose hooks can answer. */
    providers: readonly string[];
    limit?: number;
    recheckAfterMs?: number;
    signal?: AbortSignal;
    now?: () => number;
}

export interface RecheckSummary {
    /** Grants whose accessible resources were confirmed this cycle. */
    checked: number;
    /** Connections revoked because their site is confirmed absent. */
    revoked: number;
    /** Grants left for the next cycle: no token, no answer or a refresh that did not settle. */
    inconclusive: number;
}

interface GrantRow {
    org_id: string;
    id: string;
    provider: string;
    principal_user_id: string;
    secret_ref: string | null;
    secret_version: string | null;
}

/** The grant's access token, refreshed first when it is about to expire; null when none is confirmed. */
async function accessTokenOf(
    runtime: IntegrationRuntime,
    grant: GrantRow,
    options: RecheckOptions
): Promise<string | null> {
    const now = options.now ?? Date.now;
    const read = async () => {
        if (!grant.secret_ref || !grant.secret_version) return null;
        const bound = AbortSignal.timeout(SITE_READ_DEADLINE_MS);
        const result = await runtime.secrets.readActive({
            identity: grantSecretIdentity({
                id: grant.id,
                orgId: grant.org_id,
                principalUserId: grant.principal_user_id,
            }),
            ref: grant.secret_ref as SecretRef,
            signal: options.signal ? AbortSignal.any([options.signal, bound]) : bound,
        });
        if (!result.ok || (result.version as SecretVersion) !== grant.secret_version) return null;
        return decodeGrantPayload(result.value);
    };
    const first = await read();
    if (!first) return null;
    if (first.accessExpiresAt === null || first.accessExpiresAt - TOKEN_SKEW_MS > now()) return first.accessToken;
    // A refusal the provider answers for good revokes inside the refresh; anything else leaves the grant alone.
    const refreshed = await runtime
        .lineageOf(grant.org_id)
        .refreshGrant(grant.id, options.signal ? { signal: options.signal } : {});
    if (!refreshed.ok) return null;
    const grantRow = await runtime.sql<Pick<GrantRow, 'secret_version'>[]>`
        select secret_version from integration_grant where id = ${grant.id} and org_id = ${grant.org_id}
          and status = 'active'
    `;
    if (!grantRow[0]) return null;
    grant.secret_version = grantRow[0].secret_version;
    return (await read())?.accessToken ?? null;
}

/**
 * Asks each due grant's provider what its token reaches now and revokes the connections whose site is not among
 * it. The oldest-checked connections go first, so a backlog is worked in order.
 */
export async function recheckSiteAccess(runtime: IntegrationRuntime, options: RecheckOptions): Promise<RecheckSummary> {
    const summary: RecheckSummary = { checked: 0, revoked: 0, inconclusive: 0 };
    if (options.providers.length === 0) return summary;
    const afterMs = options.recheckAfterMs ?? SITE_RECHECK_AFTER_MS;
    const due = await runtime.sql<GrantRow[]>`
        select g.org_id, g.id, g.provider, g.principal_user_id::text as principal_user_id, g.secret_ref, g.secret_version
        from integration_grant g
        where g.status = 'active' and g.provider = any(${[...options.providers]}::text[])
          and g.lineage_claim is null and g.secret_wedged_at is null
          and exists (
              select 1 from connector_connection c
              where c.grant_id = g.id and c.org_id = g.org_id and c.status = 'active'
                and (c.site_checked_at is null or c.site_checked_at < now() - ${afterMs} * interval '1 millisecond')
          )
        order by (
            select min(coalesce(c.site_checked_at, 'epoch'::timestamptz)) from connector_connection c
            where c.grant_id = g.id and c.org_id = g.org_id and c.status = 'active'
        )
        limit ${options.limit ?? SITE_RECHECK_LIMIT}
    `;
    for (const grant of due) {
        if (options.signal?.aborted) break;
        const revoked = await recheckGrant(runtime, grant, options);
        if (revoked === null) summary.inconclusive += 1;
        else {
            summary.checked += 1;
            summary.revoked += revoked;
        }
    }
    return summary;
}

/** One grant's site check: the connections it revoked, or null when nothing was confirmed. */
async function recheckGrant(
    runtime: IntegrationRuntime,
    grant: GrantRow,
    options: RecheckOptions
): Promise<number | null> {
    try {
        const list = runtime.providers(grant.provider)?.accessibleResources;
        const token = list ? await accessTokenOf(runtime, grant, options) : null;
        if (!list || !token) return null;
        const bound = AbortSignal.timeout(SITE_CALL_DEADLINE_MS);
        const sites = await list({
            accessToken: token,
            signal: options.signal ? AbortSignal.any([options.signal, bound]) : bound,
        });
        return sites ? await settleSites(runtime.orgSqlOf(grant.org_id), grant, new Set(sites.map((s) => s.id))) : null;
    } catch {
        runtime.log({ source: 'account-recheck', event: 'item-failed', grantId: grant.id });
        return null;
    }
}

/** A confirmed list: each active connection whose site is in it is stamped checked, each other one is revoked. */
async function settleSites(sql: Sql, grant: GrantRow, siteIds: ReadonlySet<string>): Promise<number> {
    const connections = await sql<{ id: string; cloud_id: string }[]>`
        select id, cloud_id from connector_connection
        where grant_id = ${grant.id} and org_id = ${grant.org_id} and status = 'active'
    `;
    const gone = connections.filter((c) => !siteIds.has(c.cloud_id));
    const kept = connections.filter((c) => siteIds.has(c.cloud_id));
    if (kept.length > 0) {
        await sql`update connector_connection set site_checked_at = now() where id = any(${kept.map((c) => c.id)}::uuid[])`;
    }
    let revoked = 0;
    for (const { id } of gone) {
        const result = await sql.begin((tx) =>
            revokeConnectionsInTx(
                tx,
                { kind: 'connection', orgId: grant.org_id, connectionId: id },
                { actor: SYSTEM_ACTOR, reason: 'site-access-lost' }
            )
        );
        revoked += result.connectionIds.length;
    }
    return revoked;
}

/** One cycle of every account check, on the replica that holds the lease; undefined when another one does. */
export function recheckAccounts(
    runtime: IntegrationRuntime,
    options: RecheckOptions
): Promise<{ site: RecheckSummary } | undefined> {
    return withLease(runtime.sql, ACCOUNT_RECHECK_LEASE, ACCOUNT_RECHECK_LEASE_MS, async () => ({
        site: await recheckSiteAccess(runtime, options),
    }));
}

/** Runs the cycle now and then on an interval on every replica; like the recovery loop it never overlaps itself. */
export function startAccountRecheck(
    pass: (signal: AbortSignal) => Promise<unknown>,
    intervalMs = ACCOUNT_RECHECK_INTERVAL_MS
): () => Promise<void> {
    return startIntervalLoop('account-recheck', pass, intervalMs, {
        onError: () => logger('integrations').error('account recheck failed'),
    });
}
