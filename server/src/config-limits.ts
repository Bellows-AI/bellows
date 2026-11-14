/**
 * The request limits (docs/limits.md): the proxies whose `X-Forwarded-For` names the client, the human request rate
 * per credential and per organization, the MCP streams an organization may hold open, and the pool's statement
 * timeout. Environment only, parsed by `loadConfig`; the chart renders the same variables.
 */
import { isIP } from 'node:net';

export interface RequestLimits {
    /** Human requests one credential may make per window, on one replica. */
    readonly perCredential: number;
    /** Human requests one organization's credentials may make together per window, on one replica. */
    readonly perOrg: number;
    readonly windowMs: number;
    /** MCP requests one organization may hold open at once, on one replica. */
    readonly streamsPerOrg: number;
}

const MINUTE_MS = 60_000;

export const DEFAULT_REQUEST_LIMITS: RequestLimits = Object.freeze({
    perCredential: 600,
    perOrg: 3000,
    windowMs: MINUTE_MS,
    streamsPerOrg: 16,
});

/** One statement's wall-clock budget on the board's pools; migrations, lock waits and the backfill lift it. */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 60_000;

const V4_FAMILY = 4;
const V4_BITS = 32;
const V6_BITS = 128;
const PREFIX = /^\d{1,3}$/;

/** `TRUSTED_PROXIES`: addresses and CIDRs, comma-separated. Empty trusts no proxy, so `X-Forwarded-For` is ignored. */
export function parseTrustedProxies(raw: string | undefined): string[] {
    const entries = (raw ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
    for (const entry of entries) {
        const [address = '', prefix, ...rest] = entry.split('/');
        const family = isIP(address);
        const bits = family === V4_FAMILY ? V4_BITS : V6_BITS;
        const prefixOk = prefix === undefined || (PREFIX.test(prefix) && Number(prefix) <= bits);
        if (family === 0 || rest.length > 0 || !prefixOk) {
            throw new Error(`TRUSTED_PROXIES must list IP addresses or CIDRs, comma-separated; got "${entry}"`);
        }
    }
    return entries;
}

/** A positive integer; zero is refused, since no variable here means "unlimited". */
function positive(raw: string | undefined, fallback: number, label: string): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer, got "${raw}"`);
    return value;
}

export function loadRequestLimits(env: NodeJS.ProcessEnv): RequestLimits {
    return Object.freeze({
        perCredential: positive(
            env.RATE_LIMIT_PER_CREDENTIAL,
            DEFAULT_REQUEST_LIMITS.perCredential,
            'RATE_LIMIT_PER_CREDENTIAL'
        ),
        perOrg: positive(env.RATE_LIMIT_PER_ORG, DEFAULT_REQUEST_LIMITS.perOrg, 'RATE_LIMIT_PER_ORG'),
        windowMs: DEFAULT_REQUEST_LIMITS.windowMs,
        streamsPerOrg: positive(env.MCP_STREAMS_PER_ORG, DEFAULT_REQUEST_LIMITS.streamsPerOrg, 'MCP_STREAMS_PER_ORG'),
    });
}

export const loadStatementTimeoutMs = (env: NodeJS.ProcessEnv): number =>
    positive(env.DB_STATEMENT_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS, 'DB_STATEMENT_TIMEOUT_MS');
