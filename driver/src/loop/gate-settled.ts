import type { DeclaredGate } from '../board/board.js';
import { SETUP_FAILED_PREFIX } from '../gate-cause.js';
import { failureExcerpt } from '../gate-excerpt.js';
import { gateDeadlineMs, type GateRun } from '../gate-manager.js';
import { compactResult } from '../gate-result.js';
import { declaredTimeoutMs } from '../gates.js';
import { tailBytes } from '../runner.js';
import type { GateReport } from './loop-gates.js';

/** The report must fit the board's 128 KiB body: the raw per-gate tail budget, and its floor. */
const GATES_REPORT_BUDGET_BYTES = 16384;
const PER_GATE_OUTPUT_FLOOR_BYTES = 1024;
/** A passed gate's excerpt: nobody reads its output for a reason, so it costs the least. */
const PASSED_OUTPUT_BYTES = 512;

/** How much output a gate's report entry keeps, by its verdict. */
export interface OutputBudgets {
    passed: number;
    failed: number;
}

/**
 * The declared gates in the order they run, as segments: a run of consecutive `parallel` gates is one
 * segment, and every other gate is a segment of its own. Each entry keeps its place in the declared list.
 */
export function segmentsOf(declared: readonly DeclaredGate[]): [DeclaredGate, number][][] {
    const segments: [DeclaredGate, number][][] = [];
    for (const [index, gate] of declared.entries()) {
        const open = segments.at(-1);
        if (gate.parallel && declared[index - 1]?.parallel && open) open.push([gate, index]);
        else segments.push([[gate, index]]);
    }
    return segments;
}

/**
 * The report must fit the board's 128 KiB body however many gates declared and however verbose they
 * were — JSON escaping can inflate bytes six-fold — so the raw budget is split by verdict: a passed
 * gate keeps a short tail, and the failed ones share what the rest leave. The gates that can fail
 * together are those of one parallel segment (a serial walk stops at the first failure); the
 * floor keeps 16 gates at 1 KiB each at the least.
 */
export function outputBudgets(declared: readonly DeclaredGate[]): OutputBudgets {
    const together = Math.max(1, ...segmentsOf(declared).map((segment) => segment.length));
    const passing = Math.max(0, declared.length - together);
    return {
        passed: PASSED_OUTPUT_BYTES,
        failed: Math.max(
            PER_GATE_OUTPUT_FLOOR_BYTES,
            Math.floor((GATES_REPORT_BUDGET_BYTES - passing * PASSED_OUTPUT_BYTES) / together)
        ),
    };
}

/**
 * When a gate ran, as its report entry tells the board. `startedAt` is on the `running` entry and kept
 * on the settled one; `finishedAt` and `timeoutMs` (the deadline it ran under, so a gate that ended at it
 * timed out) only on a settled entry that ran. A skipped or reused gate carries none.
 */
export type GateTiming = { startedAt?: string; finishedAt?: string; timeoutMs?: number };

/** What a gate's settled entry measures against: its own `running` entry's start, and the driver's deadlines. */
interface SettledContext {
    running: GateTiming;
    config: { jobTimeoutMs: number; gateTimeoutMs: number };
}

/** A finished gate's report entry, and the text a failure carries to the board. */
export function settledGate(
    gate: DeclaredGate,
    outcome: GateRun,
    budgets: OutputBudgets,
    { running, config }: SettledContext
): { entry: GateReport; text: string } {
    // A failed setup is not this gate's verdict: the output names it so the board's `gates`
    // and the job's `output` tell the two apart.
    const prefix = outcome.setupFailed ? SETUP_FAILED_PREFIX : '';
    const text = `${prefix}${outcome.output}`;
    const failed = outcome.exitCode !== 0;
    return {
        entry: {
            name: gate.name,
            status: failed ? 'failed' : 'passed',
            exitCode: outcome.exitCode,
            // A failure keeps its failing lines first: the run's answer is already an excerpt of the uncut output,
            // so these lines are cut again to this gate's share, never taken from the capped log stream.
            output: failed ? failureExcerpt(text, budgets.failed) : tailBytes(text, budgets.passed),
            ...(outcome.result ? { result: compactResult(outcome.result) } : {}),
            ...(running.startedAt === undefined ? {} : { startedAt: running.startedAt }),
            finishedAt: new Date().toISOString(),
            timeoutMs: gateDeadlineMs(config, config.gateTimeoutMs, declaredTimeoutMs(gate)),
        },
        text,
    };
}
