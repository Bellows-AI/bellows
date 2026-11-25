import type { GrantAuthority } from './grant-credentials.js';

/**
 * What the board needs from a provider to keep a grant's lineage alive. Each provider registers one hook set,
 * keyed by its definition ID. The client ID and secret come from server config inside the hooks, never from a
 * payload. Every exchange hook classifies its own failure, and a cancellation is classified the same way:
 *  - `definitive`: the provider answered and refused (an `invalid_grant`); the token will never work.
 *  - `not-sent`: the request provably never left, e.g. the signal aborted before dispatch.
 *  - `ambiguous`: dispatched with no answer, aborted after dispatch, or timed out; the token may be spent.
 */
export type ExchangeFailure = 'definitive' | 'not-sent' | 'ambiguous';

export interface IssuedTokens {
    accessToken: string;
    /** Epoch milliseconds, or null for a token that does not expire. */
    expiresAt: number | null;
    refreshToken: string | null;
    /** What the provider actually granted; absent when it does not say, so the grant keeps its own. */
    authority?: GrantAuthority | undefined;
}

export type ExchangeResult = { ok: true; tokens: IssuedTokens } | { ok: false; failure: ExchangeFailure };

export interface DiscoveredIdentity {
    externalAccountId: string;
    /** What a person calls the account (an email, else a display name); shown on the connection. */
    label: string;
    resources: { id: string; label: string }[];
    authority: GrantAuthority;
}

export interface OAuthProviderHooks {
    id: string;
    supportsPkce: boolean;
    /** True when a refresh answer carries a new refresh token and spends the old one. */
    rotatesRefreshToken: boolean;
    /**
     * A rotating refresh whose answer is unconfirmed (a 5xx, a transport error) did not spend the token: the claim is
     * released, the grant stays active and the next refresh retries, instead of ending in `reconnect_required`. Only a
     * provider that rotates on success alone may say so; absent, an unconfirmed rotating refresh needs the person.
     */
    retryTransientRefresh?: boolean;
    revokeScope: 'token' | 'grant' | 'none';
    /** The provider's form of a site a start names, or null when it is not one; absent, a named site is refused. */
    siteOf?(raw: unknown): string | null;
    authorizeUrl(input: {
        clientId: string;
        redirectUri: string;
        scopes: readonly string[];
        state: string;
        codeChallenge?: string | undefined;
    }): string;
    exchangeCode(input: {
        code: string;
        redirectUri: string;
        codeVerifier?: string | undefined;
        signal: AbortSignal;
    }): Promise<ExchangeResult>;
    refresh(input: { refreshToken: string; signal: AbortSignal }): Promise<ExchangeResult>;
    /** One bounded attempt; only called when `revokeScope` is `token`. */
    revoke?(input: { token: string; signal: AbortSignal }): Promise<'revoked' | 'failed'>;
    discoverIdentity(input: { accessToken: string; signal: AbortSignal }): Promise<DiscoveredIdentity | null>;
}

/**
 * The hooks of a provider. `orgId` names the organization asking: a provider whose OAuth application is the org's own
 * (GitLab) answers per org, and the runtime always passes it; one registered per deployment ignores it.
 */
export type OAuthProviderLookup = (provider: string, orgId?: string) => OAuthProviderHooks | undefined;
