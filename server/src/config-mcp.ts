/**
 * The board-hosted MCP server (docs/configuration.md). Environment only, parsed by `loadConfig`; the chart's
 * `mcp.*` values render to exactly these variables. Off means no route: `/api/mcp` answers 404 before any
 * credential is read.
 */
export type McpConfig =
    | { readonly enabled: false }
    | {
          readonly enabled: true;
          /** The RFC 8707 resource identifier an access token must be bound to: `<public origin>/api/mcp`. */
          readonly resource: string;
          /** Browser origins besides the public one that may call the endpoint; exact matches only. */
          readonly trustedOrigins: readonly string[];
      };

/** The path the MCP endpoint is served at, and so the tail of its resource identifier. */
export const MCP_PATH = '/api/mcp';

const LOOPBACK_ORIGIN_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

function parseTrustedOrigins(raw: string | undefined): string[] {
    const entries = (raw ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
    return entries.map((entry) => {
        let origin: string | null = null;
        try {
            const url = new URL(entry);
            if ((url.protocol === 'http:' || url.protocol === 'https:') && !entry.includes('*')) origin = url.origin;
        } catch {
            // Falls through to the refusal below.
        }
        if (origin !== entry) {
            throw new Error(
                `MCP_TRUSTED_ORIGINS entries must be exact http(s) origins such as "https://app.example" (no wildcard, path or trailing slash), got "${entry}"`
            );
        }
        return entry;
    });
}

/**
 * `origin` is the board's public origin (`PUBLIC_URL`, else the loopback bind's own) and `loopbackBind` says whether
 * `HOST` is a loopback address. A bearer credential crosses the wire here, so plain http is only allowed where the
 * wire is the loopback interface.
 */
export function loadMcpConfig(
    env: NodeJS.ProcessEnv,
    enabled: boolean,
    origin: URL | null,
    loopbackBind: boolean
): McpConfig {
    if (!enabled) return { enabled: false };
    if (!origin) {
        throw new Error(
            'MCP_ENABLED is on but PUBLIC_URL is not set: it names the resource an access token is bound to and cannot be derived from a request.'
        );
    }
    if (origin.protocol === 'http:') {
        if (!LOOPBACK_ORIGIN_HOSTS.has(origin.hostname)) {
            throw new Error(
                `MCP_ENABLED is on but PUBLIC_URL is "${origin.origin}": the MCP endpoint carries bearer tokens, so it needs an https PUBLIC_URL (http is allowed only for a loopback address).`
            );
        }
        if (!loopbackBind) {
            throw new Error(
                'MCP_ENABLED is on with an http loopback PUBLIC_URL but HOST is reachable from off this machine: bind HOST to a loopback address, or serve the board over https and set PUBLIC_URL to it.'
            );
        }
    }
    return {
        enabled: true,
        resource: `${origin.origin}${MCP_PATH}`,
        trustedOrigins: parseTrustedOrigins(env.MCP_TRUSTED_ORIGINS),
    };
}
