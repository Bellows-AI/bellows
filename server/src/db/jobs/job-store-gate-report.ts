/** The gate verdict shapes a job read and a claim carry; re-exported by `job-store-types.ts`. Types only. */

import type { GateResult } from '@factory-ai/core';

/** Where one declared gate is, right now. 'pending' is a gate not yet started, 'running' the worker's claim, the others its verdict. */
export interface GateReport {
    name: string;
    status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
    exitCode: number | null;
    /** When the gate started (ISO): a `running` entry's, kept on the settled one; absent on a gate not run. */
    startedAt?: string;
    /** When the gate settled (ISO); only on a settled entry that ran. */
    finishedAt?: string;
    /** The deadline the gate ran under, in ms; only on a settled entry that ran. */
    timeoutMs?: number;
    /** The gate's tail. Bounded by the driver's window; truncated again at the route. */
    output: string | null;
    /** The recorded execution this entry is; absent for a gate no record covers. */
    executionId?: string;
    /** What the gate recorded beside its tail: failed tests, selection, slowest files, resources. */
    result?: GateResult;
    /** Set when the gate was not launched but served from an earlier verified pass. */
    reused?: { executionId: string; finishedAt: string | null; reason: string };
}

/**
 * The latest stored verdict of one declared gate in the task's thread, as a claim carries it: what
 * `factory-gate <name> --last` answers. `output` is bounded like `{{gate.output}}`.
 */
export interface LastGateReport {
    name: string;
    status: 'passed' | 'failed';
    exitCode: number | null;
    output: string | null;
    /** What the gate recorded beside its tail, when it did. */
    result?: GateResult;
    /** The recorded run this report is — for a reused pass, the run it was served from: the key of its log stream. */
    executionId?: string;
}
