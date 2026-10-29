import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attemptsLive, replay } from '../src/integrations/lineage-commit.js';
import type { LineageCtx } from '../src/integrations/lineage-types.js';
import type { SecretError, SecretResult, SecretVersion } from '../src/secrets/secret-store.js';

/**
 * BEL-138 review r1 (A1): a SecretStore mutation never starts after its deadline, is bounded by the time the claim
 * has left, and stays accounted for until it really settles, so recovery cannot mistake "no operation observed" for
 * "never happened" while an attempt may still land.
 */
const ctx = { timing: { retryDelayMs: 100 } } as LineageCtx;
const KEY = 'grant:test';
const VERSION = 'ver_1' as SecretVersion;
const ok = (): SecretResult<{ version: SecretVersion }> => ({ ok: true, version: VERSION });
const unavailable = (): SecretResult<{ version: SecretVersion }> => ({
    ok: false,
    error: { code: 'unavailable', reason: 'provider-unavailable' } satisfies SecretError,
});

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('replay: the deadline bounds every attempt', () => {
    it('never starts an attempt once the deadline has passed', async () => {
        const attempt = vi.fn(async () => ok());
        expect(await replay(ctx, KEY, attempt, { fenceAt: Date.now() - 1, retryUntil: Date.now() + 10_000 })).toEqual({
            kind: 'pending',
        });
        expect(attempt).not.toHaveBeenCalled();
    });

    it('a spent retry budget still allows the first attempt inside the fence, and no second one', async () => {
        const attempt = vi.fn(async () => unavailable());
        const limits = { fenceAt: Date.now() + 10_000, retryUntil: Date.now() };
        const running = replay(ctx, KEY, attempt, limits);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await running).toEqual({ kind: 'pending' });
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    it('stops retrying at the fence: no attempt starts after it', async () => {
        const attempt = vi.fn(async (_signal: AbortSignal) => unavailable());
        const running = replay(ctx, KEY, attempt, { fenceAt: Date.now() + 250, retryUntil: Date.now() + 10_000 });
        await vi.advanceTimersByTimeAsync(1000);
        expect(await running).toEqual({ kind: 'pending' });
        const calls = attempt.mock.calls.length;
        expect(calls).toBeGreaterThanOrEqual(2);
        await vi.advanceTimersByTimeAsync(5000);
        expect(attempt.mock.calls.length).toBe(calls);
    });

    it('an attempt that ignores its signal is abandoned at the deadline but stays live until it settles', async () => {
        let settle!: (result: SecretResult<{ version: SecretVersion }>) => void;
        let seen: AbortSignal | undefined;
        const attempt = vi.fn((signal: AbortSignal) => {
            seen = signal;
            return new Promise<SecretResult<{ version: SecretVersion }>>((resolve) => {
                settle = resolve;
            });
        });
        const running = replay(ctx, KEY, attempt, { fenceAt: Date.now() + 500, retryUntil: Date.now() + 10_000 });
        await vi.advanceTimersByTimeAsync(0);
        expect(attemptsLive(KEY)).toBe(true);

        await vi.advanceTimersByTimeAsync(500);
        expect(await running).toEqual({ kind: 'pending' });
        expect(seen?.aborted).toBe(true);
        // The parked mutation may still land: nobody may treat "no operation observed" as "never happened".
        expect(attemptsLive(KEY)).toBe(true);

        settle(ok());
        await vi.advanceTimersByTimeAsync(0);
        expect(attemptsLive(KEY)).toBe(false);
        expect(attempt).toHaveBeenCalledTimes(1);
    });
});
