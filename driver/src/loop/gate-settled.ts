import type { DeclaredGate } from '../board/board.js';
import { SETUP_FAILED_PREFIX } from '../gate-cause.js';
import { failureExcerpt } from '../gate-excerpt.js';
import { gateDeadlineMs, type GateRun } from '../gate-manager.js';
import { compactResult, type GateResult } from '../gate-result.js';
import { declaredTimeoutMs } from '../gates.js';
import { tailBytes } from '../runner.js';
import type { GateReport } from './loop-gates.js';

/** The report must fit the board's 128 KiB body: the raw per-gate tail budget, and its floor. */
const GATES_REPORT_BUDGET_BYTES = 16384;
const PER_GATE_OUTPUT_FLOOR_BYTES = 1024;
/** A passed gate's excerpt: nobody reads its output for a reason, so it costs the least. */
const PASSED_OUTPUT_BYTES = 512;
/**
 * The whole serialized gates list, under the board's 128 KiB body (`BODY_LIMIT` in
 * server/src/routes/jobs/job-limits.ts) with room for the envelope around it.
 */
const REPORT_BODY_BUDGET_BYTES = 122_880;
/** The failures and in-flight files each result keeps on the way down, before results are dropped whole. */
const FIT_FEW = 3;
const FIT_ONE = 1;
const FIT_LIST_STEPS = [FIT_FEW, FIT_ONE] as const;

/** A result cut to `keep` failures and in-flight files, without its slowest files and resources; the cut failures are counted. */
function trimmedResult(result: GateResult, keep: number): GateResult {
    const { slowest: _slowest, resources: _resources, ...rest } = result;
    const failures = result.failures?.slice(0, keep);
    const more = (result.moreFailures ?? 0) + (result.failures?.length ?? 0) - (failures?.length ?? 0);
    return {
        ...rest,
        ...(failures ? { failures } : {}),
        ...(more > 0 ? { moreFailures: more } : {}),
        ...(result.inFlight ? { inFlight: result.inFlight.slice(0, keep) } : {}),
    };
}

/** Every entry with its result passed through `shrink`; an entry whose result shrinks to nothing goes without one. */
function withResults(results: readonly GateReport[], shrink: (result: GateResult) => GateResult | null): GateReport[] {
    return results.map((entry) => {
        if (!entry.result) return entry;
        const { result, ...rest } = entry;
        const shrunk = shrink(result);
        return shrunk ? { ...rest, result: shrunk } : rest;
    });
}

/**
 * The gates list cut to fit the board's body as a whole. Each gate's output and result are bounded on
 * their own, but sixteen failed gates side by side add up past the limit, and a refused report leaves
 * the board on stale gate states. Outputs are budgeted to fit already (`outputBudgets`), so the results
 * give way: first to a few failures each, then dropped. A list that fits goes as it is.
 */
export function fitReport(results: readonly GateReport[]): GateReport[] {
    const fits = (gates: readonly GateReport[]) => Buffer.byteLength(JSON.stringify(gates)) <= REPORT_BODY_BUDGET_BYTES;
    if (fits(results)) return [...results];
    for (const keep of FIT_LIST_STEPS) {
        const trimmed = withResults(results, (result) => trimmedResult(result, keep));
        if (fits(trimmed)) return trimmed;
    }
    return withResults(results, () => null);
}

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
 * on the settled one; `finishedAt`, `timeoutMs` (the deadline it ran under) and `timedOut` (killed at
 * it) only on a settled entry that ran. A skipped or reused gate carries none.
 */
export type GateTiming = { startedAt?: string; finishedAt?: string; timeoutMs?: number; timedOut?: true };

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
            // A setup killed at its own deadline is not this gate timing out: the gate never ran.
            ...(outcome.timedOut && !outcome.setupFailed ? { timedOut: true as const } : {}),
        },
        text,
    };
}
