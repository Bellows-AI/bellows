import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBatchPrObserver } from '../src/batch-pr-observer.js';
import { startBatchReconciler } from '../src/batch-reconciler.js';

afterEach(() => {
    vi.useRealTimers();
});

/**
 * Both starters are the periodic backstop behind a notification (docs/architecture.md, "Polling is
 * the authority"): a lost callback or a failed pass is repaired by the next tick. They share a
 * shape, so they share the cases.
 */
describe.each([
    ['startBatchReconciler', 'reconcileBatches', startBatchReconciler],
    ['startBatchPrObserver', 'observeBatchPrs', startBatchPrObserver],
] as const)('%s', (_name, method, start) => {
    const pass = (impl: () => Promise<void>) => {
        const fn = vi.fn(impl);
        return {
            fn,
            orgs: { reconcileBatches: fn, observeBatchPrs: fn } as Record<typeof method, () => Promise<void>>,
        };
    };

    it('runs at once and then on every interval, and stops', async () => {
        vi.useFakeTimers();
        const { fn, orgs } = pass(async () => {});
        const stop = start(orgs as never, 1000);
        await vi.advanceTimersByTimeAsync(0);
        expect(fn).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2500);
        expect(fn).toHaveBeenCalledTimes(3);
        stop();
        await vi.advanceTimersByTimeAsync(5000);
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('never overlaps a pass that is still running', async () => {
        vi.useFakeTimers();
        let release: () => void = () => {};
        const { fn, orgs } = pass(() => new Promise<void>((resolve) => (release = resolve)));
        const stop = start(orgs as never, 1000);
        await vi.advanceTimersByTimeAsync(3500);
        expect(fn).toHaveBeenCalledTimes(1);
        release();
        await vi.advanceTimersByTimeAsync(1000);
        expect(fn).toHaveBeenCalledTimes(2);
        stop();
    });

    it('survives a failing pass: the next tick is the retry', async () => {
        vi.useFakeTimers();
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const fn = vi
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(new Error('db down'))
            .mockResolvedValue(undefined);
        const stop = start({ reconcileBatches: fn, observeBatchPrs: fn } as never, 1000);
        await vi.advanceTimersByTimeAsync(1500);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('db down'));
        stop();
        error.mockRestore();
    });
});
