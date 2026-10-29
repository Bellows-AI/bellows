/**
 * The optional commerce service (docs/configuration.md). Environment only, parsed by `loadConfig`;
 * the chart's `dashboard.commerce` values render to exactly these variables. Off means no network
 * and no route, so a disabled board ignores the URL and the token.
 */
export type CommerceConfig =
    | { readonly enabled: false }
    | { readonly enabled: true; readonly url: string; readonly token: string };

/** The `JOB_BOARD_TOKEN` floor: a bearer secret the board presents to another service. */
const MIN_COMMERCE_TOKEN_LENGTH = 32;

export function loadCommerceConfig(env: NodeJS.ProcessEnv): CommerceConfig {
    const flag = env.COMMERCE_ENABLED?.trim();
    if (flag === undefined || flag === '' || flag === 'false') return { enabled: false };
    if (flag !== 'true') {
        throw new Error(`COMMERCE_ENABLED must be "true" or "false", got "${flag}"`);
    }

    const url = env.COMMERCE_URL?.trim();
    if (!url) throw new Error('COMMERCE_ENABLED is "true" but COMMERCE_URL is not set');
    let protocol: string;
    try {
        protocol = new URL(url).protocol;
    } catch {
        throw new Error('COMMERCE_URL must be an http(s) URL');
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
        throw new Error('COMMERCE_URL must be an http(s) URL');
    }

    const token = env.COMMERCE_TOKEN?.trim();
    if (!token) {
        throw new Error(
            'COMMERCE_ENABLED is "true" but COMMERCE_TOKEN is not set. Generate one with: openssl rand -hex 32.'
        );
    }
    if (token.length < MIN_COMMERCE_TOKEN_LENGTH) {
        throw new Error(
            `COMMERCE_TOKEN must be at least ${MIN_COMMERCE_TOKEN_LENGTH} characters, got ${token.length}. Generate one with: openssl rand -hex 32.`
        );
    }
    return { enabled: true, url, token };
}
