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
        stop();
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
        stop();
    });
});
