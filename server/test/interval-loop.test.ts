import { afterEach, describe, expect, it, vi } from 'vitest';
import { startIntervalLoop } from '../src/interval-loop.js';

/** The shared outbox loop (commerce, notifications): a pass never overlaps itself and a throw never stops it. */
afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('interval loop', () => {
    it('never overlaps a pass', async () => {
        vi.useFakeTimers();
        let running = 0;
        let peak = 0;
        let release: () => void = () => {};
        const pass = vi.fn(async () => {
            running += 1;
            peak = Math.max(peak, running);
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            running -= 1;
        });
        const stop = startIntervalLoop('test', pass, 10);
        await vi.advanceTimersByTimeAsync(55);
        expect(peak).toBe(1);
        expect(pass).toHaveBeenCalledTimes(1);
        release();
        await vi.advanceTimersByTimeAsync(15);
        expect(pass.mock.calls.length).toBeGreaterThan(1);
        const stopped = stop();
        release();
        await stopped;
    });

    it('a throwing pass does not stop the loop and is logged under its label', async () => {
        vi.useFakeTimers();
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const pass = vi.fn(async () => {
            throw new Error('boom');
        });
        const stop = startIntervalLoop('test', pass, 10);
        await vi.advanceTimersByTimeAsync(35);
        expect(pass.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(error).toHaveBeenCalledWith('[test] pass failed: boom');
        await stop();
    });

    it('stop() resolves only once the pass in flight has settled, and aborts its signal', async () => {
        vi.useFakeTimers();
        let release: () => void = () => {};
        let seen: AbortSignal | undefined;
        const pass = vi.fn(async (signal: AbortSignal) => {
            seen = signal;
            await new Promise<void>((resolve) => {
                release = resolve;
            });
        });
        const stop = startIntervalLoop('test', pass, 10);
        await vi.advanceTimersByTimeAsync(5);
        let stopped = false;
        const pending = stop().then(() => {
            stopped = true;
        });
        await vi.advanceTimersByTimeAsync(50);
        expect(stopped).toBe(false);
        expect(seen?.aborted).toBe(true);
        release();
        await pending;
        expect(stopped).toBe(true);
        expect(stop()).toBe(stop());
    });

    it('starts no pass after stop(), and `immediate: false` skips the startup pass', async () => {
        vi.useFakeTimers();
        const pass = vi.fn(async () => {});
        const stop = startIntervalLoop('test', pass, 10, { immediate: false });
        expect(pass).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(15);
        expect(pass).toHaveBeenCalledTimes(1);
        await stop();
        await vi.advanceTimersByTimeAsync(100);
        expect(pass).toHaveBeenCalledTimes(1);
    });
});
