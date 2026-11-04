/**
 * A fixed-window counter per key, in this process only: each replica counts its own callers (docs/mcp.md states the
 * limit). The table is bounded: expired windows are dropped first, then the oldest, so an address sweep cannot grow it.
 */
import { expandV6, v4Of } from './special-use-address.js';

const V6_PREFIX_GROUPS = 4;
const MAPPED_GROUPS = 6;
const GROUP_HEX = 16;
const MAPPED_PREFIX = '0,0,0,0,0,65535';

/**
 * The key a caller is counted under: an IPv4 address whole (an IPv4-mapped IPv6 address as its IPv4 address), an IPv6
 * address by its /64, since one subscriber holds a whole /64 and could otherwise mint a fresh key per request.
 */
export const addressKey = (address: string): string => {
    const groups = expandV6(address);
    if (groups === null) return address;
    if (groups.slice(0, MAPPED_GROUPS).join(',') === MAPPED_PREFIX) {
        const [high = 0, low = 0] = groups.slice(MAPPED_GROUPS);
        return v4Of(high, low);
    }
    return `${groups
        .slice(0, V6_PREFIX_GROUPS)
        .map((g) => g.toString(GROUP_HEX))
        .join(':')}::/64`;
};

export interface RateLimiter {
    /** Counts one hit; `retryAfterSeconds` is set when the key is over its limit. */
    hit(key: string): { ok: true } | { ok: false; retryAfterSeconds: number };
    /** How many keys the table holds. */
    size(): number;
}

const MAX_KEYS = 10_000;
const MS = 1000;

/** Drops expired windows, then the oldest live ones, until a new key fits: the table stays bounded under a sweep. */
const makeRoom = (windows: Map<string, { resetAt: number }>, at: number, maxKeys: number): void => {
    for (const [k, w] of windows) if (w.resetAt <= at) windows.delete(k);
    for (const k of windows.keys()) {
        if (windows.size < maxKeys) break;
        windows.delete(k);
    }
};

export const createRateLimiter = ({
    limit,
    windowMs,
    maxKeys = MAX_KEYS,
    now = Date.now,
}: {
    limit: number;
    windowMs: number;
    maxKeys?: number;
    now?: () => number;
}): RateLimiter => {
    const windows = new Map<string, { count: number; resetAt: number }>();
    return {
        hit(key) {
            const at = now();
            if (windows.size >= maxKeys && !windows.has(key)) makeRoom(windows, at, maxKeys);
            const current = windows.get(key);
            const window = current && current.resetAt > at ? current : { count: 0, resetAt: at + windowMs };
            window.count += 1;
            windows.set(key, window);
            return window.count <= limit
                ? { ok: true }
                : { ok: false, retryAfterSeconds: Math.ceil((window.resetAt - at) / MS) };
        },
        size: () => windows.size,
    };
};
