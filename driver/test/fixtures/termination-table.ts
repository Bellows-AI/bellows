import { neverStartedWhy } from '../../src/loop-fence.js';
import { agentFaults, kindOf } from '../../src/loop-ledger.js';
import type { RunOutcome } from '../../src/runner.js';

/**
 * How a started run ends, one row per way, with the decision the loop takes on its outcome — the
 * conformance table both executors run (`docker.test.ts`, `k8s.test.ts`), each row through its own
 * harness. Typed as a `Record`, so neither suite can leave a row out. Not rows here: a cache loss
 * (the watch is docker-only, refused at boot under kubernetes — `config.test.ts`) and a refused
 * start (owned elsewhere).
 */
export const TERMINATION_TABLE = {
    'an agent that exits 0 under a finalizing supervisor': 'succeeded',
    'an agent its run budget ended': 'timeout',
    'a group the driver hard-killed mid-run': 'runner_error',
    'a runner the platform took away mid-run': 'interruption',
    'a runner the platform took away after the budget ended its agent': 'timeout',
    'a supervisor that ended without finalizing, nothing initiating it': 'interruption',
    'a supervisor that reported, then crashed before the verdict read': 'succeeded',
} as const;

export type TerminationRow = keyof typeof TERMINATION_TABLE;

/**
 * The loop's decision on a run's outcome, in its own order (`concludeUnreported`, then the ledger):
 * an infrastructure loss and a container that never started are both handed back as an interruption.
 */
export function decisionOf(outcome: RunOutcome): string {
    if (outcome.infraLoss || neverStartedWhy(outcome)) return 'interruption';
    return kindOf(agentFaults(outcome)) ?? 'succeeded';
}

export const TERMINATION_ROWS = Object.entries(TERMINATION_TABLE) as [TerminationRow, string][];
