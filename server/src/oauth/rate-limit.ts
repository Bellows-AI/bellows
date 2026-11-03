/**
 * A fixed-window counter per key, in this process only: each replica counts its own callers (docs/mcp.md states the
 * limit). Expired windows are dropped once the table is large, so an address sweep cannot grow it without bound.
 */
export interface RateLimiter {
    /** Counts one hit; `retryAfterSeconds` is set when the key is over its limit. */
    hit(key: string): { ok: true } | { ok: false; retryAfterSeconds: number };
}

const PRUNE_AT = 10_000;
const MS = 1000;

export const createRateLimiter = ({
    limit,
    windowMs,
    now = Date.now,
}: {
    limit: number;
    windowMs: number;
    now?: () => number;
}): RateLimiter => {
    const windows = new Map<string, { count: number; resetAt: number }>();
    return {
        hit(key) {
            const at = now();
            if (windows.size > PRUNE_AT) {
                for (const [k, w] of windows) if (w.resetAt <= at) windows.delete(k);
            }
            const current = windows.get(key);
            const window = current && current.resetAt > at ? current : { count: 0, resetAt: at + windowMs };
            window.count += 1;
            windows.set(key, window);
            return window.count <= limit
                ? { ok: true }
                : { ok: false, retryAfterSeconds: Math.ceil((window.resetAt - at) / MS) };
        },
    };
};
