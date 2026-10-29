import type { Sql } from 'postgres';
import type { GrantLineage } from './grant-lineage.js';
import type { OAuthProviderLookup } from './oauth-provider.js';
import type { SecretStore } from '../secrets/secret-store.js';

/** The vocabulary of the authorization transaction; `authorization-flow.ts` is the module API. */

/** The closed list of the 097 `failure` column. */
export type AuthorizationFailure =
    | 'denied'
    | 'state-mismatch'
    | 'identity-mismatch'
    | 'grant-conflict'
    | 'duplicate-connection'
    | 'exchange-failed'
    | 'storage-failed'
    | 'busy'
    | 'expired'
    | 'interrupted'
    | 'site-mismatch';

/** What a callback can be refused for: the stored list, plus a state that was already consumed. */
export type CompleteFailure = AuthorizationFailure | 'replayed';

/** No principal field: the user and the organization come from the trusted context alone. */
export interface StartAuthorizationInput {
    provider: string;
    /** Set to reconnect this active connection of the caller's; absent connects a new account. */
    connectionId?: string | undefined;
    returnTo?: string | undefined;
    /** Opaque until BEL-140: echoed in the result, never used for authorization. */
    interactionId?: string | undefined;
    /** The consent asked for; absent is `read`. What was GRANTED is the token's scope, never this. */
    access?: AuthorizationAccess | undefined;
    /** One site (a bare host or an https URL) the connection is narrowed to; absent takes every accessible site. */
    site?: string | undefined;
}

export type AuthorizationAccess = 'read' | 'write';

export type StartAuthorizationResult =
    | { ok: true; authorizationId: string; authorizeUrl: string; expiresAt: string }
    | { ok: false; reason: 'unknown-provider' | 'not-configured' | 'not-found' | 'bad-input' };

/** The callback's query, parsed and nothing else: a return destination is never an input. */
export interface CompleteAuthorizationInput {
    state?: string | undefined;
    code?: string | undefined;
    error?: string | undefined;
}

export type CompleteAuthorizationResult =
    | { ok: true; returnTo: string; connectionId: string }
    | { ok: false; returnTo: string; failure: CompleteFailure };

export type RecoverAuthorizationResult =
    | 'idle'
    | 'not-expired'
    | 'expired'
    | 'interrupted'
    | 'activated'
    | 'failed'
    | 'left';

/** The client the board is registered as at a provider. The client SECRET lives inside the provider hooks. */
export interface AuthorizationClient {
    clientId: string;
    scopesFor(access: AuthorizationAccess): readonly string[];
}

/** Closed diagnostics: an event name, an authorization ID and a failure code, never a code, state or token. */
export interface AuthorizationEvent {
    event: 'started' | 'consumed' | 'completed' | 'failed' | 'recovered' | 'error';
    authorizationId: string;
    failure?: AuthorizationFailure;
}

export interface AuthorizationFlowDeps {
    sql: Sql;
    orgId: string;
    secrets: SecretStore;
    lineage: GrantLineage;
    providers: OAuthProviderLookup;
    clients: (provider: string) => AuthorizationClient | undefined;
    /** The public origin of the board, or null when none is configured (`startAuthorization` then refuses). */
    callbackOrigin: string | null;
    /** How long a started transaction waits for its callback. */
    ttlMs?: number;
    log?: (event: AuthorizationEvent) => void;
}

export interface FlowCtx {
    sql: Sql;
    orgId: string;
    secrets: SecretStore;
    lineage: GrantLineage;
    providers: OAuthProviderLookup;
    clients: AuthorizationFlowDeps['clients'];
    callbackOrigin: string | null;
    ttlMs: number;
    log: (event: AuthorizationEvent['event'], authorizationId: string, failure?: AuthorizationFailure) => void;
}

/** Ten minutes. */
export const DEFAULT_AUTHORIZATION_TTL_MS = 600_000;

/** The path `routes/integrations.ts` serves; the redirect URI a provider is told is built from it. */
export const callbackPath = (provider: string): string => `/api/integrations/${encodeURIComponent(provider)}/callback`;

export function redirectUriOf(fc: Pick<FlowCtx, 'callbackOrigin'>, provider: string): string | null {
    return fc.callbackOrigin === null ? null : new URL(callbackPath(provider), fc.callbackOrigin).toString();
}
