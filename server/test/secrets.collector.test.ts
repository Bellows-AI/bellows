import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSecretCollector } from '../src/secrets/secret-collector.js';

afterEach(() => {
    vi.useRealTimers();
});

/** The collector is housekeeping behind a guarded delete: a missed or failed pass is repaired by the next tick. */
describe('startSecretCollector', () => {
    it('runs at once and then on every interval, and stops', async () => {
        vi.useFakeTimers();
        const collect = vi.fn(async () => {});
        const stop = startSecretCollector({ collect }, 1000);
        await vi.advanceTimersByTimeAsync(0);
        expect(collect).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2500);
        expect(collect).toHaveBeenCalledTimes(3);
        stop();
        await vi.advanceTimersByTimeAsync(5000);
        expect(collect).toHaveBeenCalledTimes(3);
    });

    it('never overlaps a pass that is still running', async () => {
        vi.useFakeTimers();
        let release: () => void = () => {};
        const collect = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
        const stop = startSecretCollector({ collect }, 1000);
        await vi.advanceTimersByTimeAsync(3500);
        expect(collect).toHaveBeenCalledTimes(1);
        release();
        await vi.advanceTimersByTimeAsync(1000);
        expect(collect).toHaveBeenCalledTimes(2);
        stop();
    });

    it('survives a failing pass and logs the message only', async () => {
        vi.useFakeTimers();
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const collect = vi
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(new Error('db down'))
            .mockResolvedValue(undefined);
        const stop = startSecretCollector({ collect }, 1000);
        await vi.advanceTimersByTimeAsync(1500);
        expect(collect).toHaveBeenCalledTimes(2);
        expect(error).toHaveBeenCalledTimes(1);
        expect(String(error.mock.calls[0]?.[0])).toContain('db down');
        stop();
        error.mockRestore();
    });
});
