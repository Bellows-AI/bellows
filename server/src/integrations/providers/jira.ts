import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE, jiraApiBase, jiraScopesFor } from '@factory-ai/core';
import type { DiscoveredIdentity, ExchangeResult, OAuthProviderHooks } from '../oauth-provider.js';
import { combineRegistrations, type ProviderRegistration, type ProviderRegistry } from '../provider-registry.js';
import { answerOf, isRecord, readCapped, sortedScopes } from './oauth-http.js';

/** Atlassian 3LO hooks for the outbound OAuth runtime (docs/connections.md). Client credentials come from config only. */
export interface JiraHooksConfig {
    clientId: string;
    clientSecret: string;
    authorizeUrl: string;
    tokenUrl: string;
    apiOrigin: string;
}

type FetchFn = typeof fetch;

const SITE_LIMIT = 255;
const SITE_HOST = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/i;

/** A Jira Cloud site host from a bare host or an https URL, or null when it is neither. */
export function jiraSiteHost(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length > SITE_LIMIT) return null;
    const host = raw
        .trim()
        .replace(/^https:\/\//i, '')
        .replace(/\/+$/, '');
    return SITE_HOST.test(host) ? host.toLowerCase() : null;
}

/** Atlassian answers its scopes space-separated; any other shape is not a token answer. */
const jiraScopes = (scope: unknown): string[] | null =>
    typeof scope === 'string' ? scope.split(' ').filter(Boolean) : null;

function resourceFrom(entry: unknown): { id: string; label: string; scopes: string[] } | null {
    if (!isRecord(entry)) return null;
    const { id, url, name, scopes } = entry;
    if (typeof id !== 'string' || id === '' || typeof name !== 'string' || typeof url !== 'string') return null;
    if (!Array.isArray(scopes) || !scopes.every((s): s is string => typeof s === 'string')) return null;
    try {
        const parsed = new URL(url);
        const host = jiraSiteHost(parsed.hostname);
        if (parsed.protocol !== 'https:' || host === null || parsed.port !== '') return null;
        return { id, label: host, scopes };
    } catch {
        return null;
    }
}

/** The sites the token reaches; null on anything unconfirmed (a failed, empty or malformed answer), never "no sites". */
async function listSites(
    cfg: JiraHooksConfig,
    fetchFn: FetchFn,
    accessToken: string,
    signal: AbortSignal
): Promise<NonNullable<ReturnType<typeof resourceFrom>>[] | null> {
    try {
        const list = await getJson(fetchFn, `${cfg.apiOrigin}/oauth/token/accessible-resources`, accessToken, signal);
        if (!Array.isArray(list) || list.length === 0) return null;
        const resources = list.map(resourceFrom);
        const sites = resources.filter((r): r is NonNullable<typeof r> => r !== null);
        return sites.length === resources.length ? sites : null;
    } catch {
        return null;
    }
}

/**
 * Every accessible site and the account behind the token; null on anything unconfirmed, never "no sites". Only the
 * account id is kept from `/myself`: the email and display name are personal data the board reads when shown, never stores.
 */
async function discover(
    cfg: JiraHooksConfig,
    fetchFn: FetchFn,
    accessToken: string,
    signal: AbortSignal
): Promise<DiscoveredIdentity | null> {
    try {
        const sites = await listSites(cfg, fetchFn, accessToken, signal);
        const first = sites?.[0];
        if (!sites || !first) return null;
        const me = await getJson(fetchFn, `${jiraApiBase(cfg.apiOrigin, first.id)}/myself`, accessToken, signal);
        if (!isRecord(me) || typeof me.accountId !== 'string' || me.accountId === '') return null;
        return {
            externalAccountId: me.accountId,
            label: null,
            resources: sites.map(({ id, label: host }) => ({ id, label: host })),
            authority: { scopes: sortedScopes(sites.flatMap((s) => s.scopes)) },
        };
    } catch {
        return null;
    }
}

async function getJson(fetchFn: FetchFn, url: string, accessToken: string, signal: AbortSignal): Promise<unknown> {
    const res = await fetchFn(url, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { authorization: `Bearer ${accessToken}`, accept: JSON_CONTENT_TYPE },
    });
    const text = await readCapped(res);
    if (!res.ok) throw new Error('not a 2xx answer');
    return JSON.parse(text);
}

const NOT_CONFIGURED =
    'Jira OAuth is not configured on this deployment: the operator sets ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET (docs/jira-app-runbook.md)';

/** What main.ts registers for Jira: the hooks and the OAuth client, or neither when unconfigured. */
export function jiraProvider(cfg: JiraHooksConfig | null, callbackOrigin: string | null): ProviderRegistration {
    return {
        id: 'jira',
        // Without a callback origin every start refuses, so Connect must not be offered.
        configured: cfg !== null && callbackOrigin !== null,
        hooks: cfg ? createJiraHooks(cfg) : undefined,
        client: cfg ? { clientId: cfg.clientId, scopesFor: jiraScopesFor } : undefined,
        apiBaseOf: (resource) => (cfg ? jiraApiBase(cfg.apiOrigin, resource) : null),
        notConfigured: NOT_CONFIGURED,
    };
}

/** Jira alone as a registry: the lookups a runtime over Jira only takes. */
export const jiraRegistration = (cfg: JiraHooksConfig | null, callbackOrigin: string | null): ProviderRegistry =>
    combineRegistrations([jiraProvider(cfg, callbackOrigin)]);

export function createJiraHooks(cfg: JiraHooksConfig, fetchFn: FetchFn = fetch): OAuthProviderHooks {
    async function tokenCall(grant: Record<string, string>, signal: AbortSignal): Promise<ExchangeResult> {
        if (signal.aborted) return { ok: false, failure: 'not-sent' };
        let res: Response;
        let text: string;
        try {
            res = await fetchFn(cfg.tokenUrl, {
                method: 'POST',
                redirect: 'manual',
                signal,
                headers: { [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE, accept: JSON_CONTENT_TYPE },
                body: JSON.stringify({ ...grant, client_id: cfg.clientId, client_secret: cfg.clientSecret }),
            });
            text = await readCapped(res);
        } catch {
            return { ok: false, failure: 'ambiguous' };
        }
        return answerOf(res, text, jiraScopes);
    }

    return {
        id: 'jira',
        supportsPkce: false,
        siteOf: jiraSiteHost,
        rotatesRefreshToken: true,
        revokeScope: 'none',
        authorizeUrl: ({ clientId, redirectUri, scopes, state }) => {
            const url = new URL(cfg.authorizeUrl);
            url.searchParams.set('audience', 'api.atlassian.com');
            url.searchParams.set('client_id', clientId);
            url.searchParams.set('scope', scopes.join(' '));
            url.searchParams.set('redirect_uri', redirectUri);
            url.searchParams.set('state', state);
            url.searchParams.set('response_type', 'code');
            url.searchParams.set('prompt', 'consent');
            return url.toString();
        },
        exchangeCode: ({ code, redirectUri, signal }) =>
            tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, signal),
        refresh: ({ refreshToken, signal }) =>
            tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken }, signal),
        discoverIdentity: ({ accessToken, signal }) => discover(cfg, fetchFn, accessToken, signal),
        // Atlassian's consent is revoked by the person, and the refresh then answers `invalid_grant` for good.
        revokesOnRefusal: true,
        accessibleResources: async ({ accessToken, signal }) =>
            (await listSites(cfg, fetchFn, accessToken, signal))?.map(({ id, label }) => ({ id, label })) ?? null,
    };
}
