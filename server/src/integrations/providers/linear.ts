import {
    CONTENT_TYPE_HEADER,
    JSON_CONTENT_TYPE,
    LINEAR_OPERATIONS,
    linearApiBase,
    linearScopesFor,
} from '@factory-ai/core';
import type { DiscoveredIdentity, ExchangeResult, OAuthProviderHooks } from '../oauth-provider.js';
import { combineRegistrations, type ProviderRegistration, type ProviderRegistry } from '../provider-registry.js';
import { answerOf, isRecord, readCapped } from './oauth-http.js';

/**
 * Linear OAuth2 hooks for the outbound OAuth runtime (docs/connections.md): `actor=user`, PKCE S256, form-encoded token
 * calls, a refresh token that rotates on every refresh, and a token revoked at the provider. Credentials come from config.
 */
export interface LinearHooksConfig {
    clientId: string;
    clientSecret: string;
    authorizeUrl: string;
    /** Token, revoke and GraphQL endpoints all live under it. */
    apiOrigin: string;
}

type FetchFn = typeof fetch;

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const KEY_LIMIT = 255;
const WORKSPACE_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A Linear workspace `urlKey` from a bare key or a `https://linear.app/<key>` URL, or null when it is neither. */
export function linearWorkspaceKey(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length > KEY_LIMIT) return null;
    const key = raw
        .trim()
        .replace(/^https:\/\/linear\.app\//i, '')
        .replace(/\/+$/, '')
        .toLowerCase();
    return WORKSPACE_KEY.test(key) ? key : null;
}

/** Linear answers its scopes as a space or comma string, or as an array; anything else is not a token answer. */
function linearScopes(scope: unknown): string[] | null {
    if (typeof scope === 'string') return scope.split(/[ ,]+/).filter(Boolean);
    if (Array.isArray(scope) && scope.every((s): s is string => typeof s === 'string')) return scope;
    return null;
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** Discovery runs before any workspace is known; the viewer query reads no resource, so none is named. */
const VIEWER_BODY = JSON.stringify(LINEAR_OPERATIONS.viewer.request({}, { id: '', label: '' }).body);

/** The viewer and its workspace; null on anything unconfirmed (a non-2xx, GraphQL errors, a missing field), never "no workspace". */
async function discover(
    cfg: LinearHooksConfig,
    fetchFn: FetchFn,
    accessToken: string,
    signal: AbortSignal
): Promise<DiscoveredIdentity | null> {
    try {
        const res = await fetchFn(linearApiBase(cfg.apiOrigin), {
            method: 'POST',
            redirect: 'manual',
            signal,
            headers: {
                authorization: `Bearer ${accessToken}`,
                [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE,
                accept: JSON_CONTENT_TYPE,
            },
            body: VIEWER_BODY,
        });
        const text = await readCapped(res);
        if (!res.ok) return null;
        const json: unknown = JSON.parse(text);
        if (!isRecord(json) || json.errors !== undefined || !isRecord(json.data)) return null;
        const viewer = json.data.viewer;
        if (!isRecord(viewer) || !nonEmpty(viewer.id) || !isRecord(viewer.organization)) return null;
        const { id: orgId, urlKey } = viewer.organization;
        const workspace = linearWorkspaceKey(urlKey);
        if (!nonEmpty(orgId) || workspace === null) return null;
        const label = [viewer.email, viewer.name].find(nonEmpty) ?? viewer.id;
        return {
            externalAccountId: viewer.id,
            label,
            resources: [{ id: orgId, label: workspace }],
            // The conservative fallback: used only when the token answer carried no scope.
            authority: { scopes: ['read'] },
        };
    } catch {
        return null;
    }
}

const NOT_CONFIGURED =
    'Linear OAuth is not configured on this deployment: the operator sets LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET (docs/linear-app-runbook.md)';

/** What main.ts registers for Linear: the hooks and the OAuth client, or neither when unconfigured. */
export function linearProvider(
    cfg: LinearHooksConfig | null,
    callbackOrigin: string | null,
    fetchFn: FetchFn = fetch
): ProviderRegistration {
    return {
        id: 'linear',
        // Without a callback origin every start refuses, so Connect must not be offered.
        configured: cfg !== null && callbackOrigin !== null,
        hooks: cfg ? createLinearHooks(cfg, fetchFn) : undefined,
        client: cfg ? { clientId: cfg.clientId, scopesFor: linearScopesFor } : undefined,
        // One GraphQL endpoint serves every workspace the token reaches.
        apiBaseOf: () => (cfg ? linearApiBase(cfg.apiOrigin) : null),
        notConfigured: NOT_CONFIGURED,
    };
}

/** Linear alone as a registry: the lookups a runtime over Linear only takes. */
export const linearRegistration = (
    cfg: LinearHooksConfig | null,
    callbackOrigin: string | null,
    fetchFn: FetchFn = fetch
): ProviderRegistry => combineRegistrations([linearProvider(cfg, callbackOrigin, fetchFn)]);

export function createLinearHooks(cfg: LinearHooksConfig, fetchFn: FetchFn = fetch): OAuthProviderHooks {
    const postForm = (path: string, form: Record<string, string>, signal: AbortSignal) =>
        fetchFn(`${cfg.apiOrigin}${path}`, {
            method: 'POST',
            redirect: 'manual',
            signal,
            headers: { [CONTENT_TYPE_HEADER]: FORM_CONTENT_TYPE, accept: JSON_CONTENT_TYPE },
            body: new URLSearchParams(form).toString(),
        });

    async function tokenCall(grant: Record<string, string>, signal: AbortSignal): Promise<ExchangeResult> {
        if (signal.aborted) return { ok: false, failure: 'not-sent' };
        let res: Response;
        let text: string;
        try {
            res = await postForm(
                '/oauth/token',
                { ...grant, client_id: cfg.clientId, client_secret: cfg.clientSecret },
                signal
            );
            text = await readCapped(res);
        } catch {
            return { ok: false, failure: 'ambiguous' };
        }
        return answerOf(res, text, linearScopes);
    }

    return {
        id: 'linear',
        supportsPkce: true,
        siteOf: linearWorkspaceKey,
        rotatesRefreshToken: true,
        revokeScope: 'token',
        authorizeUrl: ({ clientId, redirectUri, scopes, state, codeChallenge }) => {
            const url = new URL(cfg.authorizeUrl);
            url.searchParams.set('client_id', clientId);
            url.searchParams.set('redirect_uri', redirectUri);
            url.searchParams.set('response_type', 'code');
            url.searchParams.set('scope', scopes.join(','));
            url.searchParams.set('state', state);
            url.searchParams.set('actor', 'user');
            url.searchParams.set('prompt', 'consent');
            if (codeChallenge) {
                url.searchParams.set('code_challenge', codeChallenge);
                url.searchParams.set('code_challenge_method', 'S256');
            }
            return url.toString();
        },
        exchangeCode: ({ code, redirectUri, codeVerifier, signal }) =>
            tokenCall(
                {
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: redirectUri,
                    ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
                },
                signal
            ),
        refresh: ({ refreshToken, signal }) =>
            tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken }, signal),
        revoke: async ({ token, signal }) => {
            try {
                const res = await postForm('/oauth/revoke', { token }, signal);
                await readCapped(res);
                return res.ok ? 'revoked' : 'failed';
            } catch {
                return 'failed';
            }
        },
        discoverIdentity: ({ accessToken, signal }) => discover(cfg, fetchFn, accessToken, signal),
    };
}
