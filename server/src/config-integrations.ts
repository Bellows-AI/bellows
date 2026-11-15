/**
 * The outbound OAuth providers' client configuration (docs/configuration.md, docs/connections.md). Environment only,
 * parsed by `loadConfig`; the chart's `integrations.<provider>.clientId` and `secret.*ClientSecret` render to exactly
 * these variables.
 */
export interface JiraOAuthConfig {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly authorizeUrl: string;
    readonly tokenUrl: string;
    readonly apiOrigin: string;
}

const ATLASSIAN_DEFAULTS = {
    ATLASSIAN_AUTHORIZE_URL: 'https://auth.atlassian.com/authorize',
    ATLASSIAN_TOKEN_URL: 'https://auth.atlassian.com/oauth/token',
    ATLASSIAN_API_URL: 'https://api.atlassian.com',
} as const;

/** An absolute http(s) URL override, or the default when unset. Anything else is fatal: a typo must not become a host. */
function overrideUrl<Name extends string>(
    env: NodeJS.ProcessEnv,
    name: Name,
    defaults: Readonly<Record<Name, string>>
): { url: string; set: boolean } {
    const raw = env[name]?.trim();
    if (!raw) return { url: defaults[name], set: false };
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error(`${name} is not an absolute http(s) URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`${name} is not an absolute http(s) URL`);
    }
    return { url: raw, set: true };
}

/**
 * Both `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET`, or neither: one alone is a half-configured connector, named
 * individually like the GitHub sign-in keys. The three URL overrides exist for a stub identity provider and warn loudly:
 * a configurable host is somewhere to send a client secret.
 */
export function loadJiraOAuth(env: NodeJS.ProcessEnv): JiraOAuthConfig | null {
    const clientId = env.ATLASSIAN_CLIENT_ID?.trim();
    const clientSecret = env.ATLASSIAN_CLIENT_SECRET?.trim();
    if (!clientId && !clientSecret) return null;
    for (const [label, value] of [
        ['ATLASSIAN_CLIENT_ID', clientId],
        ['ATLASSIAN_CLIENT_SECRET', clientSecret],
    ] as const) {
        if (!value)
            throw new Error(
                `${label} is not set. Jira OAuth needs both ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET.`
            );
    }
    const authorize = overrideUrl(env, 'ATLASSIAN_AUTHORIZE_URL', ATLASSIAN_DEFAULTS);
    const token = overrideUrl(env, 'ATLASSIAN_TOKEN_URL', ATLASSIAN_DEFAULTS);
    const api = overrideUrl(env, 'ATLASSIAN_API_URL', ATLASSIAN_DEFAULTS);
    if (authorize.set || token.set || api.set) {
        console.warn('[config] NOT using the Atlassian endpoints: an ATLASSIAN_*_URL override is set');
    }
    return Object.freeze({
        clientId: clientId!,
        clientSecret: clientSecret!,
        authorizeUrl: authorize.url,
        tokenUrl: token.url,
        apiOrigin: api.url.replace(/\/+$/, ''),
    });
}

export interface LinearOAuthConfig {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly authorizeUrl: string;
    /** Token (`/oauth/token`), revoke (`/oauth/revoke`) and GraphQL (`/graphql`) all live under it. */
    readonly apiOrigin: string;
}

const LINEAR_DEFAULTS = {
    LINEAR_AUTHORIZE_URL: 'https://linear.app/oauth/authorize',
    LINEAR_API_URL: 'https://api.linear.app',
} as const;

/** `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET`, both or neither, like Jira; the two URL overrides warn the same way. */
export function loadLinearOAuth(env: NodeJS.ProcessEnv): LinearOAuthConfig | null {
    const clientId = env.LINEAR_CLIENT_ID?.trim();
    const clientSecret = env.LINEAR_CLIENT_SECRET?.trim();
    if (!clientId && !clientSecret) return null;
    for (const [label, value] of [
        ['LINEAR_CLIENT_ID', clientId],
        ['LINEAR_CLIENT_SECRET', clientSecret],
    ] as const) {
        if (!value)
            throw new Error(`${label} is not set. Linear OAuth needs both LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET.`);
    }
    const authorize = overrideUrl(env, 'LINEAR_AUTHORIZE_URL', LINEAR_DEFAULTS);
    const api = overrideUrl(env, 'LINEAR_API_URL', LINEAR_DEFAULTS);
    if (authorize.set || api.set) {
        console.warn('[config] NOT using the Linear endpoints: a LINEAR_*_URL override is set');
    }
    return Object.freeze({
        clientId: clientId!,
        clientSecret: clientSecret!,
        authorizeUrl: authorize.url,
        apiOrigin: api.url.replace(/\/+$/, ''),
    });
}
