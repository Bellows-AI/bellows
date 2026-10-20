import { neverStartedWhy } from '../../src/loop-fence.js';
import { agentFaults, kindOf } from '../../src/loop-ledger.js';
import type { RunOutcome } from '../../src/runner.js';

/**
 * How a started run ends, one row per way, with the decision the loop takes on its outcome — the
 * conformance table both executors run (`docker.test.ts`, `k8s.test.ts`), each row through its own
 * harness. Typed as a `Record`, so neither suite can leave a row out. Not rows here: a cache loss
 * (the watch is docker-only, refused at boot under kubernetes — `config.test.ts`) and a refused
 * start (`startup-table.ts`).
 */
export const TERMINATION_TABLE = {
    'an agent that exits 0 under a finalizing supervisor': 'succeeded',
    'an agent its run budget ended': 'timeout',
    'a group the driver hard-killed mid-run': 'runner_error',
    'a runner the platform took away mid-run': 'interruption',
    'a runner the platform took away after the budget ended its agent': 'timeout',
    'a supervisor that ended without finalizing, nothing initiating it': 'interruption',
    'a supervisor that reported, then crashed before the verdict read': 'succeeded',
    'a supervisor that reported an unlaunched group, then crashed': 'interruption',
    'a supervisor that reported its agent lost, then crashed': 'interruption',
    'a runner the platform took away after the supervisor reported its agent lost': 'interruption',
} as const;

export type TerminationRow = keyof typeof TERMINATION_TABLE;

/**
 * The loop's decision on a run's outcome, in its own order (`unreportedDecision`, then the ledger):
 * an infrastructure loss and a container that never started are both handed back as an interruption.
 */
export function decisionOf(outcome: RunOutcome): string {
    if (outcome.infraLoss || neverStartedWhy(outcome)) return 'interruption';
    return kindOf(agentFaults(outcome)) ?? 'succeeded';
}

/** The rows whose run was lost to the platform: the outcome is the loss and what was known of it, no more. */
export const LOSS_ROWS = [
    'a runner the platform took away mid-run',
    'a runner the platform took away after the supervisor reported its agent lost',
] as const satisfies readonly TerminationRow[];

/** What an infrastructure loss carries past the loss itself: the keys a lost run must not have. */
export function carriedPastLoss(outcome: RunOutcome): string[] {
    const loss = ['exitCode', 'output', 'timedOut', 'started', 'infraLoss'];
    return Object.keys(outcome).filter((key) => !loss.includes(key));
}

export const TERMINATION_ROWS = Object.entries(TERMINATION_TABLE) as [TerminationRow, string][];
