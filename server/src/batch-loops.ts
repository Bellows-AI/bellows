import { startBatchPrObserver, startPrFollower } from './batch-pr-observer.js';
import { startBatchReconciler } from './batch-reconciler.js';
import type { OrgRegistry } from './orgs.js';

/**
 * Starts the board's PR-driven background loops. The batch reconciler and observer (which also runs the merger)
 * start only when batches are enabled: off means no execution path, and in-flight batches freeze until the flag is
 * turned back on (docs/batches.md). The single-task PR follower is not a batch feature and always runs.
 * Returns the stop for everything started.
 */
export function startBatchLoops({
    batchesEnabled,
    orgs,
    timedPass,
}: {
    batchesEnabled: boolean;
    orgs: Pick<OrgRegistry, 'reconcileBatches' | 'observeBatchPrs' | 'followPrs'>;
    timedPass: <T>(loop: string, fn: () => Promise<T>) => Promise<T>;
}): () => Promise<void> {
    const stops = [
        startPrFollower({
            followPrs: () => timedPass('pr_follow', () => orgs.followPrs()),
        }),
    ];
    if (batchesEnabled) {
        stops.push(
            startBatchReconciler({
                reconcileBatches: () => timedPass('batch_reconcile', () => orgs.reconcileBatches()),
            }),
            startBatchPrObserver({
                observeBatchPrs: () => timedPass('batch_pr_observe', () => orgs.observeBatchPrs()),
            })
        );
    }
    return async () => {
        await Promise.all(stops.map((stop) => stop()));
    };
}
