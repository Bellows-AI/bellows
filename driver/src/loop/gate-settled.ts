import type { DeclaredGate } from '../board/board.js';
import { SETUP_FAILED_PREFIX } from '../gate-cause.js';
import { gateDeadlineMs, type GateRun } from '../gate-manager.js';
import { compactResult } from '../gate-result.js';
import { declaredTimeoutMs } from '../gates.js';
import { tailBytes } from '../runner.js';
import type { GateReport } from './loop-gates.js';

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
    perGate: number,
    { running, config }: SettledContext
): { entry: GateReport; text: string } {
    // A failed setup is not this gate's verdict: the output names it so the board's `gates`
    // and the job's `output` tell the two apart.
    const text = outcome.setupFailed ? `${SETUP_FAILED_PREFIX}${outcome.output}` : outcome.output;
    return {
        entry: {
            name: gate.name,
            status: outcome.exitCode !== 0 ? 'failed' : 'passed',
            exitCode: outcome.exitCode,
            output: tailBytes(text, perGate),
            ...(outcome.result ? { result: compactResult(outcome.result) } : {}),
            ...(running.startedAt === undefined ? {} : { startedAt: running.startedAt }),
            finishedAt: new Date().toISOString(),
            timeoutMs: gateDeadlineMs(config, config.gateTimeoutMs, declaredTimeoutMs(gate)),
        },
        text,
    };
}
