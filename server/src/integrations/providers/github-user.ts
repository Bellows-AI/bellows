import { JSON_CONTENT_TYPE, JSON_HEADERS } from '@factory-ai/core';
import type { DiscoveredIdentity, ExchangeResult, OAuthProviderHooks } from '../oauth-provider.js';
import { isRecord, readCapped } from './oauth-http.js';

/**
 * The GitHub App's user-authorization hooks for the grant lineage (docs/connections.md): the refresh of a member's
 * `ghr_` token against the App's own client. Not a connect flow — sign-in (`auth/github.ts`) is what issues the pair —
 * so it is looked up by the lineage but never registered as a provider a person can start. A refresh rotates both
 * tokens; the client credentials come from config inside the hooks, never from a payload.
 */
export interface GitHubUserHooksConfig {
    clientId: string;
    clientSecret: string;
    authorizeUrl: string;
    tokenUrl: string;
    /** `GET /user`, asked with the access token to identify its account. */
    userUrl: string;
}

/** The grant's `provider`: a member's GitHub grant is keyed by member and forge. */
export const GITHUB_FORGE = 'github';

type FetchFn = typeof fetch;

const MS_PER_SECOND = 1000;
/**
 * What GitHub says when it has refused for good. It reports every token error with a 200 and an `error` field, so
 * only these named answers are a verdict; anything else is unconfirmed and leaves the grant alone.
 */
const REFUSALS = new Set(['bad_refresh_token', 'incorrect_client_credentials', 'expired_token']);

/** The new pair, or null when the answer is not one. */
function tokensFrom(json: unknown): Extract<ExchangeResult, { ok: true }>['tokens'] | null {
    if (!isRecord(json)) return null;
    const { access_token: accessToken, expires_in: expiresIn, refresh_token: refreshToken } = json;
    if (typeof accessToken !== 'string' || accessToken === '') return null;
    if (typeof refreshToken !== 'string' || refreshToken === '') return null;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
    // An App user token has no scopes: its reach is the App's permissions intersected with the member's.
    return {
        accessToken,
        expiresAt: Date.now() + expiresIn * MS_PER_SECOND,
        refreshToken,
        authority: { scopes: [] },
    };
}

/** A token endpoint answer: tokens, a refusal GitHub meant, or unconfirmed. */
function answerOf(res: Response, text: string): ExchangeResult {
    let json: unknown = null;
    try {
        json = JSON.parse(text);
    } catch {
        json = null;
    }
    const error = isRecord(json) ? json.error : undefined;
    if (res.ok && typeof error === 'string' && REFUSALS.has(error)) return { ok: false, failure: 'definitive' };
    if (!res.ok) return { ok: false, failure: 'ambiguous' };
    const tokens = tokensFrom(json);
    return tokens ? { ok: true, tokens } : { ok: false, failure: 'ambiguous' };
}

async function discover(
    cfg: GitHubUserHooksConfig,
    fetchFn: FetchFn,
    accessToken: string,
    signal: AbortSignal
): Promise<DiscoveredIdentity | null> {
    try {
        const res = await fetchFn(cfg.userUrl, {
            redirect: 'manual',
            signal,
            headers: {
                authorization: `Bearer ${accessToken}`,
                accept: 'application/vnd.github+json',
                // GitHub rejects an API request with no User-Agent outright.
                'user-agent': 'factory-ai',
            },
        });
        const text = await readCapped(res);
        if (!res.ok) return null;
        const json: unknown = JSON.parse(text);
        if (!isRecord(json) || typeof json.id !== 'number' || typeof json.login !== 'string' || json.login === '') {
            return null;
        }
        return { externalAccountId: String(json.id), label: json.login, resources: [], authority: { scopes: [] } };
    } catch {
        return null;
    }
}

export function createGitHubUserHooks(cfg: GitHubUserHooksConfig, fetchFn: FetchFn = fetch): OAuthProviderHooks {
    async function tokenCall(grant: Record<string, string>, signal: AbortSignal): Promise<ExchangeResult> {
        if (signal.aborted) return { ok: false, failure: 'not-sent' };
        try {
            const res = await fetchFn(cfg.tokenUrl, {
                method: 'POST',
                redirect: 'manual',
                signal,
                headers: { accept: JSON_CONTENT_TYPE, ...JSON_HEADERS },
                body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...grant }),
            });
            return answerOf(res, await readCapped(res));
        } catch {
            return { ok: false, failure: 'ambiguous' };
        }
    }

    return {
        id: GITHUB_FORGE,
        supportsPkce: false,
        rotatesRefreshToken: true,
        // A 5xx or a transport error is a refresh that did not happen, not a spent token: retry, never reconnect.
        retryTransientRefresh: true,
        revokeScope: 'none',
        authorizeUrl: ({ clientId, redirectUri, state }) => {
            const url = new URL(cfg.authorizeUrl);
            url.searchParams.set('client_id', clientId);
            url.searchParams.set('redirect_uri', redirectUri);
            url.searchParams.set('state', state);
            return url.toString();
        },
        exchangeCode: ({ code, redirectUri, signal }) => tokenCall({ code, redirect_uri: redirectUri }, signal),
        refresh: ({ refreshToken, signal }) =>
            tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken }, signal),
        discoverIdentity: ({ accessToken, signal }) => discover(cfg, fetchFn, accessToken, signal),
    };
}
