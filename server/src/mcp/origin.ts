const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);

export interface OriginPolicy {
    /** The board's public origin, `https://board.example`; the origin a browser page of the board itself sends. */
    readonly publicOrigin: string;
    readonly trustedOrigins: readonly string[];
    /** `github`: `Host` must be the public host. `none`: `Host` must be a loopback name on the bound port. */
    readonly mode: 'github' | 'none';
    /** The port the request arrived on. */
    readonly port: number | undefined;
}

export interface OriginHeaders {
    readonly origin: string | undefined;
    readonly host: string | undefined;
    readonly forwardedHost: string | undefined;
}

/** `localhost:8080` -> `localhost` and `8080`; an IPv6 literal keeps its brackets. */
const splitHost = (host: string): { name: string; port: string } | null => {
    const match = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d+))?$/.exec(host.trim().toLowerCase());
    return match?.[1] ? { name: match[1], port: match[2] ?? '' } : null;
};

const hostAllowed = (policy: OriginPolicy, headers: OriginHeaders): boolean => {
    if (policy.mode === 'github') {
        const publicHost = new URL(policy.publicOrigin).host;
        const scheme = new URL(policy.publicOrigin).protocol;
        const defaultPort = scheme === 'https:' ? ':443' : ':80';
        const bare = (host: string | undefined): string | undefined => {
            const lower = host?.toLowerCase();
            return lower?.endsWith(defaultPort) ? lower.slice(0, -defaultPort.length) : lower;
        };
        // `X-Forwarded-Host` counts only when it is the very host the board is published under, so a caller cannot
        // steer the check by naming another one.
        return bare(headers.host) === publicHost || bare(headers.forwardedHost) === publicHost;
    }
    const parts = headers.host ? splitHost(headers.host) : null;
    if (!parts || !LOOPBACK_NAMES.has(parts.name)) return false;
    return policy.port === undefined || parts.port === String(policy.port);
};

const originAllowed = (policy: OriginPolicy, origin: string | undefined): boolean =>
    // A browser always sends Origin on a cross-origin POST; native clients and the vendor cloud send none.
    origin === undefined || origin === policy.publicOrigin || policy.trustedOrigins.includes(origin);

/**
 * The DNS-rebinding and cross-origin guard of the MCP endpoint: a present `Origin` must be the board's own or an
 * exactly trusted one (no wildcard), and `Host` must be the name the board is published under.
 */
export const originPermitted = (policy: OriginPolicy, headers: OriginHeaders): boolean =>
    originAllowed(policy, headers.origin) && hostAllowed(policy, headers);
