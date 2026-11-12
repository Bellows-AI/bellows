import type { BoardJob } from '../board/board.js';
import { raceStep } from './loop-attempt.js';
import type { GateReport, GateSession } from './loop-gates.js';
import type { LoopRuntime } from './loop-types.js';

/** The output a gate carries when the task changed nothing and the gate was not launched. */
export const NO_CHANGES = 'no changes';

/**
 * The gates phase of a task confirmed to have produced no change, logged; null when it
 * did, or when the read failed, timed out or was aborted — inconclusive, so the gates run.
 */
export async function noChangeSkip(ctx: {
    rt: LoopRuntime;
    job: BoardJob;
    gateSession: GateSession;
    state: { signal: AbortSignal };
}) {
    const { rt, job, gateSession, state } = ctx;
    const raced = await raceStep(
        state.signal,
        rt.runner.probeNoChange(job, state.signal).catch(() => false)
    );
    if (raced?.value !== true) return null;
    const why = 'the task produced no change (no diff against its base)';
    rt.log(`job ${job.id}: gates skipped — ${why}`);
    // Each declared gate is told apart from a pass: nothing ran, so nothing passed, and no
    // gate-run row is written (a skip can never become a reusable pass).
    const reports: GateReport[] = gateSession.declared.map((gate) => ({
        name: gate.name,
        status: 'skipped',
        exitCode: null,
        output: NO_CHANGES,
    }));
    gateSession.lastReports = reports;
    if (reports.length > 0) {
        // Best effort, like every gate report: losing it loses freshness, never the verdict.
        await raceStep(
            state.signal,
            rt.board.gates(job, [...reports]).catch((e: unknown) => {
                rt.log(`job ${job.id}: could not report skipped gates, continuing: ${(e as Error).message}`);
            })
        );
    }
    return { failure: null, deadServices: [], gatesSkipped: why, noChange: true, recoveredServices: [], reports };
}
