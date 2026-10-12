import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBatchReconciler } from '../src/batch-reconciler.js';

afterEach(() => {
    vi.useRealTimers();
});

describe('startBatchReconciler', () => {
    it('reconciles at once and then on every interval', async () => {
        vi.useFakeTimers();
        const reconcileBatches = vi.fn(async () => {});
        const stop = startBatchReconciler({ reconcileBatches }, 1000);
        await vi.advanceTimersByTimeAsync(0);
        expect(reconcileBatches).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2500);
        expect(reconcileBatches).toHaveBeenCalledTimes(3);
        stop();
        await vi.advanceTimersByTimeAsync(5000);
        expect(reconcileBatches).toHaveBeenCalledTimes(3);
    });

    it('never overlaps a pass that is still running', async () => {
        vi.useFakeTimers();
        let release: () => void = () => {};
        const reconcileBatches = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
        const stop = startBatchReconciler({ reconcileBatches }, 1000);
        await vi.advanceTimersByTimeAsync(3500);
        expect(reconcileBatches).toHaveBeenCalledTimes(1);
        release();
        await vi.advanceTimersByTimeAsync(1000);
        expect(reconcileBatches).toHaveBeenCalledTimes(2);
        stop();
    });

    it('survives a failing pass: the next tick is the retry', async () => {
        vi.useFakeTimers();
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const reconcileBatches = vi
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(new Error('db down'))
            .mockResolvedValue(undefined);
        const stop = startBatchReconciler({ reconcileBatches }, 1000);
        await vi.advanceTimersByTimeAsync(1500);
        expect(reconcileBatches).toHaveBeenCalledTimes(2);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('db down'));
        stop();
        error.mockRestore();
    });
});
