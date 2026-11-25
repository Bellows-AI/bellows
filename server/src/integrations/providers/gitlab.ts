import { CONTENT_TYPE_HEADER, GITLAB_OAUTH_SCOPE, gitlabHostOf, JSON_CONTENT_TYPE } from '@factory-ai/core';
import type { GitlabApplication } from '../../db/forge-connections.js';
import type { GitlabApi, GitlabResponse } from '../../gitlab/gitlab-api.js';
import type { AuthorizationClient } from '../authorization-types.js';
import type { DiscoveredIdentity, ExchangeResult, OAuthProviderHooks } from '../oauth-provider.js';
import { answerOf, isRecord } from './oauth-http.js';

/**
 * The outbound OAuth hooks of a connected GitLab (docs/connections.md). Unlike Jira's and Linear's they are not one
 * set per deployment: the application (client id, secret, CA bundle) is the organization's own, so each hook set is
 * made for one organization and one host and reads that application back at the moment of a call. Two organizations
 * on the same host get two sets that share nothing; a restarted board rebuilds them from the connection rows, so the
 * lineage's recovery finds the right client without any in-memory registration.
 */

export interface GitlabProviderDeps {
    api: GitlabApi;
    /** The org's live connection application for a host; null for a confirmed absence, a throw for an unconfirmed read. */
    applicationOf(orgId: string, host: string): Promise<GitlabApplication | null>;
    /** Where a browser is sent to authorize at a host: `https` always, a test points it at the fake. */
    originOf?: (host: string) => string;
}

export interface GitlabProvider {
    /** The hooks for one org's `gitlab:<host>` provider; undefined when `provider` is not a GitLab one. */
    hooksFor(orgId: string, provider: string): OAuthProviderHooks | undefined;
    /** The org's OAuth client for a host, read back; null when the org has no live connection to it. */
    clientOf(orgId: string, host: string): Promise<AuthorizationClient | null>;
}

const HTTP_OK = 200;
const HTTP_MULTIPLE = 300;
const HTTP_SERVER_ERROR = 500;
const HTTP_TOO_MANY = 429;

const scopesOf = (scope: unknown): string[] | null =>
    typeof scope === 'string' ? scope.split(' ').filter(Boolean) : null;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The token endpoint's answer, split by whether GitLab can have consumed the code or refresh token (see `tokenCall`). */
function tokenAnswer(answer: GitlabResponse): ExchangeResult {
    if (!answer.ok) return { ok: false, failure: answer.sent ? 'ambiguous' : 'not-sent' };
    const { status } = answer;
    if (status >= HTTP_SERVER_ERROR || status === HTTP_TOO_MANY) return { ok: false, failure: 'not-sent' };
    return answerOf({ ok: status >= HTTP_OK && status < HTTP_MULTIPLE, status }, answer.text, scopesOf);
}

/** The JSON of a 2xx answer, or null for anything else. */
const jsonOf = (answer: GitlabResponse): unknown => {
    if (!answer.ok || answer.status < HTTP_OK || answer.status >= HTTP_MULTIPLE) return null;
    try {
        return JSON.parse(answer.text);
    } catch {
        return null;
    }
};

export function createGitlabProvider({
    api,
    applicationOf,
    originOf = (host) => `https://${host}`,
}: GitlabProviderDeps): GitlabProvider {
    const cache = new Map<string, OAuthProviderHooks>();

    function createHooks(orgId: string, provider: string, host: string): OAuthProviderHooks {
        /** The application, or null when it cannot be read: a call that never reached GitLab is `not-sent`. */
        const application = (): Promise<GitlabApplication | null> => applicationOf(orgId, host).catch(() => null);

        /**
         * GitLab spends a refresh token the moment it processes the request, so an unconfirmed answer is split: refused
         * before it could have been consumed (never connected, a 5xx or 429, which issue no token) is `not-sent` and
         * retried; anything else after dispatch (a timeout, a cut or malformed answer) may have consumed it and is
         * `ambiguous`, which the lineage ends in reconnect-required (`retryTransientRefresh` is off): the spent token is
         * never replayed.
         */
        async function tokenCall(grant: Record<string, string>, signal: AbortSignal): Promise<ExchangeResult> {
            if (signal.aborted) return { ok: false, failure: 'not-sent' };
            const app = await application();
            if (!app || signal.aborted) return { ok: false, failure: 'not-sent' };
            const answer = await api.request({
                host,
                path: '/oauth/token',
                method: 'POST',
                headers: { [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE },
                body: JSON.stringify({ ...grant, client_id: app.clientId, client_secret: app.clientSecret }),
                caBundle: app.caBundle,
                signal,
            });
            return tokenAnswer(answer);
        }

        return {
            id: provider,
            supportsPkce: true,
            rotatesRefreshToken: true,
            revokeScope: 'none',
            authorizeUrl: ({ clientId, redirectUri, state, codeChallenge }) => {
                const url = new URL('/oauth/authorize', originOf(host));
                url.searchParams.set('client_id', clientId);
                url.searchParams.set('redirect_uri', redirectUri);
                url.searchParams.set('response_type', 'code');
                url.searchParams.set('scope', GITLAB_OAUTH_SCOPE);
                url.searchParams.set('state', state);
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
            discoverIdentity: async ({ accessToken, signal }): Promise<DiscoveredIdentity | null> => {
                const app = await application();
                if (!app) return null;
                const user = jsonOf(
                    await api.request({
                        host,
                        path: '/api/v4/user',
                        headers: bearer(accessToken),
                        caBundle: app.caBundle,
                        signal,
                    })
                );
                if (!isRecord(user) || typeof user.id !== 'number' || typeof user.username !== 'string') return null;
                if (user.username === '') return null;
                return {
                    externalAccountId: String(user.id),
                    label: user.username,
                    resources: [],
                    authority: { scopes: [] },
                };
            },
        };
    }

    const hooksOf = (orgId: string, provider: string, host: string): OAuthProviderHooks => {
        const key = `${orgId}\0${provider}`;
        let hooks = cache.get(key);
        if (!hooks) {
            hooks = createHooks(orgId, provider, host);
            cache.set(key, hooks);
        }
        return hooks;
    };

    return {
        hooksFor(orgId, provider) {
            const host = gitlabHostOf(provider);
            return host === null ? undefined : hooksOf(orgId, provider, host);
        },
        async clientOf(orgId, host) {
            const app = await applicationOf(orgId, host);
            return app ? { clientId: app.clientId, scopesFor: () => [GITLAB_OAUTH_SCOPE] } : null;
        },
    };
}
