import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE, jiraApiBase, jiraScopesFor } from '@factory-ai/core';
import type { DiscoveredIdentity, ExchangeResult, IssuedTokens, OAuthProviderHooks } from '../oauth-provider.js';

/** Atlassian 3LO hooks for the outbound OAuth runtime (docs/connections.md). Client credentials come from config only. */
export interface JiraHooksConfig {
    clientId: string;
    clientSecret: string;
    authorizeUrl: string;
    tokenUrl: string;
    apiOrigin: string;
}

type FetchFn = typeof fetch;

const MAX_BODY_BYTES = 65_536;
const MS_PER_SECOND = 1000;
const SITE_LIMIT = 255;
const REFUSALS = new Set(['invalid_grant', 'invalid_request', 'unauthorized_client', 'access_denied']);
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const REFUSAL_STATUSES = new Set([HTTP_BAD_REQUEST, HTTP_UNAUTHORIZED, HTTP_FORBIDDEN]);
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

class BodyTooLarge extends Error {}

/** Reads at most 64 KiB; rejects on a transport error, an abort or a premature close. */
async function readCapped(res: Response): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > MAX_BODY_BYTES) throw new BodyTooLarge();
            chunks.push(next.value);
        }
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    }
    return Buffer.concat(chunks).toString('utf8');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const sortedScopes = (scopes: Iterable<string>): string[] => [...new Set(scopes)].sort();

/** A token answer, or null when it is not one: the provider may have spent the code, so null is never definitive. */
function tokensFrom(json: unknown): IssuedTokens | null {
    if (!isRecord(json)) return null;
    const { access_token: accessToken, expires_in: expiresIn, refresh_token: refreshToken, scope } = json;
    if (typeof accessToken !== 'string' || accessToken === '') return null;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
    if (refreshToken !== undefined && typeof refreshToken !== 'string') return null;
    if (scope !== undefined && typeof scope !== 'string') return null;
    return {
        accessToken,
        expiresAt: Date.now() + expiresIn * MS_PER_SECOND,
        refreshToken: refreshToken || null,
        ...(scope === undefined ? {} : { authority: { scopes: sortedScopes(scope.split(' ').filter(Boolean)) } }),
    };
}

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

/** Every accessible site and the account behind the token; null on anything unconfirmed, never "no sites". */
async function discover(
    cfg: JiraHooksConfig,
    fetchFn: FetchFn,
    accessToken: string,
    signal: AbortSignal
): Promise<DiscoveredIdentity | null> {
    try {
        const list = await getJson(fetchFn, `${cfg.apiOrigin}/oauth/token/accessible-resources`, accessToken, signal);
        if (!Array.isArray(list) || list.length === 0) return null;
        const resources = list.map(resourceFrom);
        const sites = resources.filter((r): r is NonNullable<typeof r> => r !== null);
        const first = sites[0];
        if (sites.length !== resources.length || !first) return null;
        const me = await getJson(fetchFn, `${jiraApiBase(cfg.apiOrigin, first.id)}/myself`, accessToken, signal);
        if (!isRecord(me) || typeof me.accountId !== 'string' || me.accountId === '') return null;
        const label = [me.emailAddress, me.displayName].find((v) => typeof v === 'string' && v !== '');
        return {
            externalAccountId: me.accountId,
            label: typeof label === 'string' ? label : me.accountId,
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

/** What main.ts registers with the runtime: the hooks and the OAuth client for Jira, or nothing when unconfigured. */
export function jiraRegistration(cfg: JiraHooksConfig | null) {
    const hooks = cfg ? createJiraHooks(cfg) : undefined;
    return {
        providers: (provider: string) => (provider === 'jira' ? hooks : undefined),
        clients: (provider: string) =>
            provider === 'jira' && cfg ? { clientId: cfg.clientId, scopesFor: jiraScopesFor } : undefined,
    };
}

/** A token endpoint answer: tokens, a refusal the provider meant, or unconfirmed. */
function answerOf(res: Response, text: string): ExchangeResult {
    let json: unknown = null;
    try {
        json = JSON.parse(text);
    } catch {
        json = null;
    }
    if (res.ok) {
        const tokens = tokensFrom(json);
        return tokens ? { ok: true, tokens } : { ok: false, failure: 'ambiguous' };
    }
    const error = isRecord(json) ? json.error : undefined;
    const refused = REFUSAL_STATUSES.has(res.status) && typeof error === 'string' && REFUSALS.has(error);
    return { ok: false, failure: refused ? 'definitive' : 'ambiguous' };
}

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
        return answerOf(res, text);
    }

    return {
        id: 'jira',
        supportsPkce: false,
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
    };
}
