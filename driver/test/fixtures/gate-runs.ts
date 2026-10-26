import type { BoardJob } from '../../src/board/board.js';
import type { GateRunRecord } from '../../src/board/board-gate-runs.js';
import { gateIdentity } from '../../src/gate-identity.js';
import { stableGateEnvBody } from '../../src/loop/loop-gates.js';
import { config } from './loop-stubs.js';

/** The tree a recorded pass and the completion probe agree on in the reuse suites. */
export const SAME_TREE = 'h:same';

/**
 * The gate-run row an earlier ad-hoc pass of `gate` left on the board for `job` (issue #983): the
 * identity is the driver's own computation, so a case changes one field to make a row ineligible.
 */
export function gateRunRow(job: BoardJob, gate: string, over: Partial<GateRunRecord> = {}): GateRunRecord {
    const declared = job.gates!.gates.find((candidate) => candidate.name === gate)!;
    return {
        executionId: `7777777${gate.length}-7777-4777-8777-777777777777`,
        gate,
        identity: gateIdentity(config().boardToken, job, declared, stableGateEnvBody(job)),
        filtered: false,
        source: 'adhoc',
        outcome: 'passed',
        exitCode: 0,
        treeBefore: SAME_TREE,
        treeAfter: SAME_TREE,
        mutatedSince: false,
        startedAt: '2026-10-26T10:00:00.000Z',
        finishedAt: '2026-10-26T10:01:00.000Z',
        runClaimSeq: job.claimSeq,
        claimSeq: job.claimSeq,
        ...over,
    };
}
