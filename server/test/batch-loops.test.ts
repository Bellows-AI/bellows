import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBatchLoops } from '../src/batch-loops.js';

afterEach(() => {
    vi.useRealTimers();
});

const rig = () => {
    const orgs = {
        reconcileBatches: vi.fn(async () => {}),
        observeBatchPrs: vi.fn(async () => {}),
        followPrs: vi.fn(async () => {}),
    };
    const timedPass = <T>(_loop: string, fn: () => Promise<T>) => fn();
    return { orgs, timedPass };
};

describe('startBatchLoops', () => {
    it('starts the reconciler, the batch observer and the PR follower when batches are enabled', async () => {
        vi.useFakeTimers();
        const { orgs, timedPass } = rig();
        const stop = startBatchLoops({ batchesEnabled: true, orgs, timedPass });
        await vi.advanceTimersByTimeAsync(0);
        expect(orgs.reconcileBatches).toHaveBeenCalledTimes(1);
        expect(orgs.observeBatchPrs).toHaveBeenCalledTimes(1);
        expect(orgs.followPrs).toHaveBeenCalledTimes(1);
        await stop();
    });

    it('starts neither batch loop when batches are disabled, but the single-task PR follower still runs', async () => {
        vi.useFakeTimers();
        const { orgs, timedPass } = rig();
        const stop = startBatchLoops({ batchesEnabled: false, orgs, timedPass });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(orgs.reconcileBatches).not.toHaveBeenCalled();
        expect(orgs.observeBatchPrs).not.toHaveBeenCalled();
        expect(orgs.followPrs).toHaveBeenCalled();
        await stop();
    });

    it('stops every loop it started', async () => {
        vi.useFakeTimers();
        const { orgs, timedPass } = rig();
        const stop = startBatchLoops({ batchesEnabled: true, orgs, timedPass });
        await vi.advanceTimersByTimeAsync(0);
        await stop();
        orgs.followPrs.mockClear();
        orgs.reconcileBatches.mockClear();
        await vi.advanceTimersByTimeAsync(600_000);
        expect(orgs.followPrs).not.toHaveBeenCalled();
        expect(orgs.reconcileBatches).not.toHaveBeenCalled();
    });
});
