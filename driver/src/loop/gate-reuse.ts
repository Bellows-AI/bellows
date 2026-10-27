import type { DeclaredGate } from '../board/board.js';
import type { GateRunRecord } from '../board/board-gate-runs.js';
import type { GateReport } from './loop-gates.js';

/** The longest the one read of a run's gate record may take: bounded, never retried, never a reason to fail. */
export const GATE_RUNS_READ_MS = 10_000;

/** What a reuse is compared against: the gate's identity now, the completion tree's content key, the run's claim. */
export interface ReuseWant {
    identity: string;
    tree: string | null;
    runClaimSeq: number;
}

/**
 * The earlier run a declared gate may be reported `passed` from without launching it (issue #983), or
 * null — and then the gate runs, as it always did. The LATEST row of the gate, of any scope, decides:
 * a newer running, failed, incomplete or filtered row beats an older pass, and a row the board could
 * not confirm never existed. It is reusable only when it is a full ad-hoc pass of the same gate
 * identity, under the same run claim, whose tree before and after are known, equal to each other and
 * to the completion tree, and whose run touched no shipped path (`mutatedSince === false`).
 * `rows` is oldest first: the last row of a gate is its latest.
 */
export function reusableRun(
    rows: readonly GateRunRecord[] | null,
    gate: DeclaredGate,
    want: ReuseWant
): GateRunRecord | null {
    if (rows === null || want.tree === null) return null;
    const latest = rows.filter((row) => row.gate === gate.name).at(-1);
    if (!latest) return null;
    const eligible =
        latest.outcome === 'passed' &&
        !latest.filtered &&
        latest.source === 'adhoc' &&
        latest.identity === want.identity &&
        latest.runClaimSeq === want.runClaimSeq &&
        latest.treeBefore === want.tree &&
        latest.treeAfter === want.tree &&
        latest.mutatedSince === false;
    return eligible ? latest : null;
}

/** The gate's report entry when it is served from `run`: passed, naming the execution it came from. */
export function reusedReport(gate: DeclaredGate, run: GateRunRecord): GateReport {
    const at = run.finishedAt ?? 'an earlier moment';
    return {
        name: gate.name,
        status: 'passed',
        exitCode: 0,
        output: `[reused] passed on this very tree at ${at} (execution ${run.executionId}); not run again`,
        executionId: run.executionId,
        reused: {
            executionId: run.executionId,
            finishedAt: run.finishedAt,
            reason: 'the tree is unchanged since this full, unfiltered pass and nothing touched it while it ran',
        },
    };
}
