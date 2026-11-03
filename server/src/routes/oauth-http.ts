import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE, hashToken, unsign } from '../auth/session.js';
import type { OAuthClient, OAuthStore } from '../auth/oauth-store.js';
import type { AuthStore } from '../auth/store.js';
import type { AppConfig } from '../config.js';
import type { RegistrationLimits } from './oauth-register.js';

/** The authorization server's endpoints, under the public origin. One place, so metadata and routes cannot drift. */
export const OAUTH_PATHS = {
    authorize: '/api/oauth/authorize',
    resume: '/api/oauth/authorize/resume',
    token: '/api/oauth/token',
    revoke: '/api/oauth/revoke',
    register: '/api/oauth/register',
    consent: '/api/oauth/consent/:id',
    approve: '/api/oauth/consent/approve',
    deny: '/api/oauth/consent/deny',
} as const;

/** The SPA page that renders the consent screen (BEL-103); the transaction travels in its fragment, never to a server. */
export const CONSENT_PAGE_PATH = '/oauth/consent';

export const HTTP_BAD_REQUEST = 400;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_UNAVAILABLE = 503;

/** What every OAuth route needs: the github-mode config with MCP on, the stores, and the client lookup. */
export interface OAuthRouteDeps {
    config: AppConfig;
    auth: AuthStore;
    oauth: OAuthStore;
    /**
     * Resolves a client id to a registered client, or null when none is known. A throw means the answer could not be
     * confirmed. Defaults to the store's rows; the CIMD fetch (`oauth/client-resolver.ts`) plugs in here. The signal
     * is the request's: a caller that went away cancels an in-flight fetch.
     */
    resolveClient?: ((clientId: string, signal?: AbortSignal) => Promise<OAuthClient | null>) | undefined;
    /** Dynamic Client Registration limits (this process only); the defaults apply when absent. */
    registrationLimits?: RegistrationLimits | undefined;
}

/** The board's origin as the OAuth issuer, and the resource an access token is bound to. */
export const identityOf = (config: AppConfig): { issuer: string; resource: string; sessionSecret: string } => {
    if (!config.mcp.enabled || config.auth.mode !== 'github') {
        throw new Error('OAuth routes need MCP_ENABLED and AUTH_MODE=github');
    }
    return {
        issuer: new URL(config.mcp.resource).origin,
        resource: config.mcp.resource,
        sessionSecret: config.auth.sessionSecret,
    };
};

/** RFC 6749 section 5.2: a JSON error, never cached. */
export const oauthError = (reply: FastifyReply, status: number, error: string, description?: string) =>
    reply
        .code(status)
        .header('cache-control', 'no-store')
        .send({ error, ...(description ? { error_description: description } : {}) });

export const noStore = (reply: FastifyReply): void => {
    reply.header('cache-control', 'no-store');
    reply.header('pragma', 'no-cache');
};

/**
 * A request's parameters as strings, or null when any value is repeated or not a string: an OAuth parameter may
 * appear once (RFC 6749 section 3.1), and a smuggled second value must not be resolved by luck.
 */
export const readParams = (raw: unknown): Map<string, string> | null => {
    if (raw === undefined || raw === null) return new Map();
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    const params = new Map<string, string>();
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== 'string') return null;
        params.set(key, value);
    }
    return params;
};

/** Aborts when the client goes away before the reply is finished, so work done for it (a CIMD fetch) stops. */
export const closeSignal = (reply: FastifyReply): AbortSignal => {
    const controller = new AbortController();
    reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) controller.abort();
    });
    return controller.signal;
};

/** The session token behind the request's cookie (never a bearer), as the hash the consent transaction binds to. */
export const sessionHashOf = (request: FastifyRequest, secret: string): Buffer | null => {
    const token = unsign(request.cookies[SESSION_COOKIE], secret);
    return token ? hashToken(token) : null;
};

/** `redirectUri` with the response parameters set and `iss` (RFC 9207) always present. */
export const redirectWith = (
    redirectUri: string,
    issuer: string,
    params: Record<string, string | undefined>
): string => {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
    url.searchParams.set('iss', issuer);
    return url.toString();
};

export const scopesOf = (raw: string): string[] => raw.split(' ').filter((scope) => scope !== '');
