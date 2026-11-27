import { describe, expect, it } from 'vitest';
import type { DeclaredGate } from '../src/board/board.js';
import { compactResult, type GateResult, MAX_FAILURES } from '../src/gate-result.js';
import { fitReport, outputBudgets, settledGate } from '../src/loop/gate-settled.js';
import { replayGates } from '../src/loop/loop-phase-checkpoints.js';
import type { GateReport } from '../src/loop/loop-gates.js';

/** The board's body limit on POST /api/jobs/:id/gates (server/src/routes/jobs/job-limits.ts). */
const BOARD_BODY_LIMIT_BYTES = 128 * 1024;
const GATES = 16;
/** A quote JSON-escapes to two bytes: the cheapest way to make every capped field cost more than its length. */
const heavy = (chars: number) => '"'.repeat(chars);

const body = (gates: readonly GateReport[]) => Buffer.byteLength(JSON.stringify({ leaseToken: 'l'.repeat(64), gates }));

const fullResult = (): GateResult =>
    compactResult({
        failures: Array.from({ length: MAX_FAILURES }, (_, i) => ({
            file: `${i}${heavy(400)}`,
            test: heavy(400),
            message: heavy(2000),
        })),
        inFlight: Array.from({ length: 20 }, () => heavy(400)),
    });

describe('the gate report a run sends the board', () => {
    // Sixteen parallel gates failing at once, each within its own caps, used to add up past the board's
    // 128 KiB body: the board refused the report and kept stale gate states.
    it('fits the board body limit as a whole, however many gates fail with full results', () => {
        const declared: DeclaredGate[] = Array.from({ length: GATES }, (_, i) => ({
            name: `g${i}`,
            command: 'npm test',
            parallel: true,
        }));
        const budgets = outputBudgets(declared);
        const results: GateReport[] = declared.map((gate) => ({
            name: gate.name,
            status: 'failed',
            exitCode: 1,
            output: 'x'.repeat(budgets.failed),
            result: fullResult(),
        }));
        expect(body(results)).toBeGreaterThan(BOARD_BODY_LIMIT_BYTES);

        const fitted = fitReport(results);
        expect(body(fitted)).toBeLessThanOrEqual(BOARD_BODY_LIMIT_BYTES);
        expect(fitted.map((gate) => [gate.name, gate.status, gate.output])).toEqual(
            results.map((gate) => [gate.name, gate.status, gate.output])
        );
        // What survives still names the first failures, with the count of the ones cut.
        expect(fitted[0]?.result?.failures?.length).toBeGreaterThan(0);
        expect(fitted[0]?.result?.moreFailures).toBeGreaterThan(0);
    });

    it('sends a report that already fits unchanged', () => {
        const results: GateReport[] = [
            { name: 'test', status: 'failed', exitCode: 1, output: 'boom', result: fullResult() },
        ];
        expect(fitReport(results)).toEqual(results);
    });

    // A phase served from its checkpoint posts the reports it kept; a checkpoint written before they were
    // fitted (or a list that outgrew the body) must not be refused on replay.
    it('replays a checkpointed report cut to the board body', async () => {
        const reports: GateReport[] = Array.from({ length: GATES }, (_, i) => ({
            name: `g${i}`,
            status: 'failed',
            exitCode: 1,
            output: 'x'.repeat(1024),
            result: fullResult(),
        }));
        const posted: GateReport[][] = [];
        const ctx = {
            rt: { board: { gates: async (_job: unknown, gates: GateReport[]) => posted.push(gates) }, log: () => {} },
            job: { id: 'j', setupFailure: null },
        };
        await replayGates(ctx as never, { reports } as never);
        expect(posted).toHaveLength(1);
        expect(body(posted[0] ?? [])).toBeLessThanOrEqual(BOARD_BODY_LIMIT_BYTES);
    });
});

describe('a settled gate entry', () => {
    // Setup runs to the platform default, not the gate's own deadline, and the gate never ran: the
    // entry must not read "timed out at" the gate's deadline.
    it('carries no timeout outcome for a setup that timed out', () => {
        const gate: DeclaredGate = { name: 'test', command: 'npm test', timeoutMinutes: 30 };
        const config = { jobTimeoutMs: 28_800_000, gateTimeoutMs: 1_200_000 };
        const budgets = { passed: 512, failed: 4096 };
        const setup = settledGate(
            gate,
            { exitCode: 124, output: 'setup killed', setupFailed: true, timedOut: true },
            budgets,
            { running: {}, config }
        );
        expect(setup.entry).not.toHaveProperty('timedOut');
        const own = settledGate(gate, { exitCode: 124, output: 'killed', timedOut: true }, budgets, {
            running: {},
            config,
        });
        expect(own.entry.timedOut).toBe(true);
    });
});
