import type { Sql } from 'postgres';
import type { SecretStore } from '../secrets/secret-store.js';
import { type AuthorizationFlow, createAuthorizationFlow } from './authorization-flow.js';
import type { AuthorizationFlowDeps } from './authorization-types.js';
import { createGrantLineage, type DestroyResult, type GrantLineage, type LineageTiming } from './grant-lineage.js';
import type { OAuthProviderLookup } from './oauth-provider.js';

/**
 * The composition of the outbound OAuth runtime and the background pass that adopts what a lost board pod left
 * (docs/connections.md). A pass runs on every replica and is idempotent: each row is acted on only through the
 * statements of its own module, which re-check the row, so two passes (or a pass and a request) never both finish it.
 * An enumeration is a candidate list, never a verdict: whatever the store did not confirm is left for the next tick.
 */

export const INTEGRATION_RECOVERY_INTERVAL_MS = 60_000;
/** Rows of each kind one pass may touch, so a backlog (or a store that is down) cannot make a tick unbounded. */
export const INTEGRATION_RECOVERY_LIMIT = 50;

export interface IntegrationRuntimeDeps {
    sql: Sql;
    secrets: SecretStore;
    providers: OAuthProviderLookup;
    clients: AuthorizationFlowDeps['clients'];
    callbackOrigin: string | null;
    timing?: Partial<LineageTiming>;
    /** Closed diagnostics only: event names and IDs, never a token, a state or a provider body. */
    log?: (line: Record<string, unknown>) => void;
}

export interface IntegrationRuntime {
    readonly sql: Sql;
    readonly log: (line: Record<string, unknown>) => void;
    lineageOf(orgId: string): GrantLineage;
    flowOf(orgId: string): AuthorizationFlow;
    /** Destroys the secret of a revoked grant; a refusal is an answer, a throw is the store's. */
    destroyRevokedSecret(orgId: string, grantId: string): Promise<DestroyResult>;
}

/** One lineage and one flow per org: the lineage owns a single-flight map, so it must outlive a request. */
export function createIntegrationRuntime(deps: IntegrationRuntimeDeps): IntegrationRuntime {
    const log = deps.log ?? (() => undefined);
    const lineages = new Map<string, GrantLineage>();
    const flows = new Map<string, AuthorizationFlow>();
    const lineageOf = (orgId: string): GrantLineage => {
        let lineage = lineages.get(orgId);
        if (!lineage) {
            lineage = createGrantLineage({
                sql: deps.sql,
                orgId,
                secrets: deps.secrets,
                providers: deps.providers,
                ...(deps.timing ? { timing: deps.timing } : {}),
                log: (event) => log({ source: 'lineage', ...event }),
            });
            lineages.set(orgId, lineage);
        }
        return lineage;
    };
    const flowOf = (orgId: string): AuthorizationFlow => {
        let flow = flows.get(orgId);
        if (!flow) {
            flow = createAuthorizationFlow({
                sql: deps.sql,
                orgId,
                secrets: deps.secrets,
                lineage: lineageOf(orgId),
                providers: deps.providers,
                clients: deps.clients,
                callbackOrigin: deps.callbackOrigin,
                log: (event) => log({ source: 'authorization', ...event }),
            });
            flows.set(orgId, flow);
        }
        return flow;
    };
    return {
        sql: deps.sql,
        log,
        lineageOf,
        flowOf,
        destroyRevokedSecret: (orgId, grantId) => lineageOf(orgId).destroyRevokedSecret(grantId),
    };
}

export interface RecoverySummary {
    /** Expired claims (recorded operation or not) that this pass examined. */
    grants: number;
    /** Revoked grants whose secret this pass destroyed. */
    destroyed: number;
    /** Stale authorizations that this pass examined. */
    authorizations: number;
    /** Items whose handler threw or that a store refused inconclusively; each stays for the next pass. */
    failed: number;
}

interface Candidate {
    org_id: string;
    id: string;
}

const REFUSALS_LEFT_FOR_NEXT_PASS: ReadonlySet<string> = new Set(['pending', 'failed', 'unconfirmed', 'claim-lost']);

/**
 * One bounded pass: adopt expired claims, destroy the secrets of revoked grants, then settle stale authorizations.
 * It stops between items when `signal` aborts. A throw from the enumeration itself propagates (nothing was touched).
 */
export async function recoverIntegrations(
    runtime: IntegrationRuntime,
    options: { limit?: number; signal?: AbortSignal } = {}
): Promise<RecoverySummary> {
    const { sql } = runtime;
    const limit = options.limit ?? INTEGRATION_RECOVERY_LIMIT;
    const signal = options.signal;
    const summary: RecoverySummary = { grants: 0, destroyed: 0, authorizations: 0, failed: 0 };

    /** Runs `act` for each candidate; one item's failure never stops the rest. */
    const each = async (kind: string, rows: Candidate[], act: (row: Candidate) => Promise<void>): Promise<void> => {
        for (const row of rows) {
            if (signal?.aborted) return;
            try {
                await act(row);
            } catch {
                summary.failed += 1;
                runtime.log({ source: 'recovery', event: 'item-failed', kind, id: row.id });
            }
        }
    };

    const expired = await sql<Candidate[]>`
        select org_id, id from integration_grant
        where lineage_claim is not null and lineage_claim_expires_at < now()
        order by lineage_claim_expires_at
        limit ${limit}
    `;
    await each('grant', expired, async (row) => {
        summary.grants += 1;
        await runtime.lineageOf(row.org_id).recoverLineage(row.id);
    });

    // Random, not ordered: a grant whose destroy keeps being refused must not hold the head of a bounded list.
    const revoked = signal?.aborted
        ? []
        : await sql<Candidate[]>`
            select org_id, id from integration_grant
            where status = 'revoked' and secret_version is not null and secret_wedged_at is null and lineage_claim is null
            order by random()
            limit ${limit}
        `;
    await each('destroy', revoked, async (row) => {
        const result = await runtime.destroyRevokedSecret(row.org_id, row.id);
        if (result.ok) summary.destroyed += 1;
        else if (REFUSALS_LEFT_FOR_NEXT_PASS.has(result.reason)) summary.failed += 1;
    });

    const stale = signal?.aborted
        ? []
        : await sql<Candidate[]>`
            select org_id, id from integration_authorization
            where (status = 'pending' and expires_at < now())
               or (status in ('exchanging', 'persisting') and deadline_at < now())
            order by expires_at
            limit ${limit}
        `;
    await each('authorization', stale, async (row) => {
        summary.authorizations += 1;
        await runtime.flowOf(row.org_id).recoverAuthorization(row.id);
    });

    return summary;
}

/**
 * Runs `pass` now and then on an interval, on every replica. A pass never overlaps the previous one and never throws
 * out of the loop: a failed pass logs one closed line (never the error text) and the next tick is the retry. The
 * returned stop clears the timer and aborts the running pass's signal, so it ends between items. The timer is
 * unref'd, so it never holds the process open.
 */
export function startIntegrationRecovery(
    pass: (signal: AbortSignal) => Promise<unknown>,
    intervalMs = INTEGRATION_RECOVERY_INTERVAL_MS,
    log: (line: string) => void = (line) => console.error(line)
): () => void {
    const controller = new AbortController();
    let running = false;
    const tick = async () => {
        if (running || controller.signal.aborted) return;
        running = true;
        try {
            await pass(controller.signal);
        } catch {
            log('[integrations] recovery pass failed');
        } finally {
            running = false;
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    return () => {
        clearInterval(timer);
        controller.abort();
    };
}
