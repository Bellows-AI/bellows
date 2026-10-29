import type { Credential, IntegrationOutcome, UnavailableReason } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { grantSecretIdentity } from '../db/connection-grants.js';
import type { SecretRef, SecretStore, SecretVersion } from '../secrets/secret-store.js';
import { authorityScopes, decodeGrantPayload, type GrantPayload } from './grant-credentials.js';
import type { GrantLineage } from './grant-lineage.js';
import { isTrustedContext, type TrustedIntegrationContext } from './trusted-context.js';

/**
 * A frozen binding becomes a short-lived credential, or a closed outcome. The read that decides runs twice: once
 * before the SecretStore is touched, so a disconnect blocks resolution at once, and once more after a secret read
 * or a refresh, so a disconnect that landed meanwhile never hands out a token. An answer that is not a confirmed
 * value (a thrown query or read, a version mismatch, a payload that does not decode) is `unavailable`, never
 * "missing": absence is only what a successful query of the binding says.
 */
export type ResolveResult = { ok: true; credential: Credential } | { ok: false; outcome: IntegrationOutcome };

export interface CredentialResolverDeps {
    sql: Sql;
    orgId: string;
    secrets: SecretStore;
    lineage: GrantLineage;
    /** A token expiring within this window is refreshed first. */
    skewMs?: number;
    readDeadlineMs?: number;
    now?: () => number;
}

export interface ResolveRequest {
    rootJobId: string;
    connectionId: string;
}

interface BindingRow {
    provider: string;
    b_grant_id: string | null;
    b_authority: unknown;
    c_status: string | null;
    c_credential: string | null;
    c_principal: string | null;
    c_grant_id: string | null;
    g_id: string | null;
    g_principal: string | null;
    g_provider: string | null;
    g_status: string | null;
    g_version: string | null;
    g_authority: unknown;
    g_secret_ref: string | null;
    g_secret_version: string | null;
}

type Refusal = { ok: false; outcome: IntegrationOutcome };

type Checked =
    | {
          ok: true;
          grant: { id: string; provider: string; ref: string; version: string; scopes: string[]; principal: string };
      }
    | { ok: false; outcome: IntegrationOutcome };

const DEFAULT_SKEW_MS = 60_000;
const DEFAULT_READ_DEADLINE_MS = 5_000;

const unavailable = (reason: UnavailableReason): { ok: false; outcome: IntegrationOutcome } => ({
    ok: false,
    outcome: { outcome: 'unavailable', reason, retryable: true },
});
const required = (reason: 'missing' | 'reconnect', provider: string): { ok: false; outcome: IntegrationOutcome } => ({
    ok: false,
    outcome: { outcome: 'integration_required', reason, provider },
});
const forbidden = (reason: 'principal-mismatch' | 'service-principal-unsupported' | 'binding-ceiling-exceeded') => ({
    ok: false as const,
    outcome: { outcome: 'forbidden', reason } satisfies IntegrationOutcome,
});

type Settings = Required<Pick<CredentialResolverDeps, 'skewMs' | 'readDeadlineMs' | 'now'>> & CredentialResolverDeps;

/** The binding, its connection and its grant, validated field by field. */
async function check(deps: Settings, ctx: TrustedIntegrationContext, request: ResolveRequest): Promise<Checked> {
    const rows = await deps.sql<BindingRow[]>`
        select b.provider, b.grant_id as b_grant_id, b.authority as b_authority,
               c.status as c_status, c.credential as c_credential, c.principal_user_id as c_principal,
               c.grant_id as c_grant_id,
               g.id as g_id, g.principal_user_id as g_principal, g.provider as g_provider, g.status as g_status,
               g.version as g_version, g.authority as g_authority, g.secret_ref as g_secret_ref,
               g.secret_version as g_secret_version
        from job_connection_binding b
        left join connector_connection c on c.id = b.connection_id and c.org_id = b.org_id
        left join integration_grant g on g.id = c.grant_id and g.org_id = c.org_id
        where b.org_id = ${deps.orgId} and b.root_job_id = ${request.rootJobId}
          and b.connection_id = ${request.connectionId}
        limit 1
    `;
    const row = rows[0];
    if (!row) return required('missing', '');
    return refusal(row, ctx) ?? grantOf(row);
}

/** Who may use this binding, and whether its connection and grant still stand. */
function refusal(row: BindingRow, ctx: TrustedIntegrationContext): Refusal | null {
    const provider = row.provider;
    if (row.c_status !== 'active' || row.c_credential !== 'oauth_grant' || !row.g_id) {
        return required('missing', provider);
    }
    if (ctx.principal.kind !== 'user') return forbidden('service-principal-unsupported');
    if (row.c_principal !== ctx.principal.userId || row.g_principal !== ctx.principal.userId) {
        return forbidden('principal-mismatch');
    }
    if (row.b_grant_id !== row.c_grant_id) return required('reconnect', provider);
    if (row.g_status === 'revoked') return required('missing', provider);
    if (row.g_status !== 'active') return required('reconnect', provider);
    return null;
}

/** The grant a request may use: a stored credential, and an authority inside the binding's frozen ceiling. */
function grantOf(row: BindingRow): Checked {
    if (!row.g_id || !row.g_secret_ref || !row.g_secret_version) return unavailable('credential-pending');
    const scopes = authorityScopes(row.g_authority);
    const ceiling = authorityScopes(row.b_authority);
    if (!scopes || !ceiling) return unavailable('secret-unavailable');
    if (scopes.some((scope) => !ceiling.includes(scope))) return forbidden('binding-ceiling-exceeded');
    return {
        ok: true,
        grant: {
            id: row.g_id,
            provider: row.g_provider ?? row.provider,
            ref: row.g_secret_ref,
            version: row.g_secret_version,
            scopes,
            principal: row.g_principal as string,
        },
    };
}

async function read(
    deps: Settings,
    grant: Extract<Checked, { ok: true }>['grant'],
    signal: AbortSignal | undefined
): Promise<{ ok: true; payload: GrantPayload } | { ok: false }> {
    const bound = AbortSignal.timeout(deps.readDeadlineMs);
    try {
        const result = await deps.secrets.readActive({
            identity: grantSecretIdentity({ id: grant.id, orgId: deps.orgId, principalUserId: grant.principal }),
            ref: grant.ref as SecretRef,
            signal: signal ? AbortSignal.any([signal, bound]) : bound,
        });
        if (!result.ok || (result.version as SecretVersion) !== grant.version) return { ok: false };
        return { ok: true, payload: decodeGrantPayload(result.value) };
    } catch {
        return { ok: false };
    }
}

const isExpired = (deps: Settings, payload: GrantPayload): boolean =>
    payload.accessExpiresAt !== null && payload.accessExpiresAt - deps.skewMs <= deps.now();

interface Call {
    ctx: TrustedIntegrationContext;
    request: ResolveRequest;
    signal: AbortSignal | undefined;
}

async function resolveOnce(deps: Settings, call: Call, mayRefresh: boolean): Promise<ResolveResult> {
    const { ctx, request, signal } = call;
    const before = await check(deps, ctx, request);
    if (!before.ok) return before;
    const stored = await read(deps, before.grant, signal);
    if (!stored.ok) return unavailable('secret-unavailable');
    const { payload } = stored;
    if (isExpired(deps, payload)) {
        if (!mayRefresh) return unavailable('refresh-in-progress');
        const refreshed = await deps.lineage.refreshGrant(before.grant.id, { signal });
        // Whatever the refresh did, the binding and the stored credential are read again from the top.
        return refreshed.ok ? resolveOnce(deps, call, false) : refreshed;
    }
    // A disconnect that landed during the secret read is seen here, before any token leaves.
    const after = await check(deps, ctx, request);
    if (!after.ok) return after;
    if (after.grant.version !== before.grant.version) return unavailable('refresh-in-progress');
    return {
        ok: true,
        credential: {
            accessToken: payload.accessToken,
            expiresAt: payload.accessExpiresAt,
            authority: { scopes: after.grant.scopes },
        },
    };
}

export function createCredentialResolver(deps: CredentialResolverDeps) {
    const settings: Settings = {
        ...deps,
        skewMs: deps.skewMs ?? DEFAULT_SKEW_MS,
        readDeadlineMs: deps.readDeadlineMs ?? DEFAULT_READ_DEADLINE_MS,
        now: deps.now ?? Date.now,
    };
    return {
        async resolveCredential(
            ctx: TrustedIntegrationContext,
            request: ResolveRequest,
            options: { signal?: AbortSignal | undefined } = {}
        ): Promise<ResolveResult> {
            if (!isTrustedContext(ctx) || ctx.orgId !== settings.orgId) return forbidden('principal-mismatch');
            try {
                return await resolveOnce(settings, { ctx, request, signal: options.signal }, true);
            } catch {
                // A thrown query or read is not an absence: the caller may retry.
                return unavailable('secret-unavailable');
            }
        },
    };
}

export type CredentialResolver = ReturnType<typeof createCredentialResolver>;
