import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { agentFaults } from '../src/loop-ledger.js';
import {
    attachTranscriptExport,
    createExportRelay,
    drainOf,
    drainTranscriptExport,
    newExportRun,
} from '../src/loop-export.js';
import { newJobState } from '../src/loop-attempt.js';
import type { AttemptCtx, LoopRuntime } from '../src/loop-types.js';
import type { RunOutcome } from '../src/runner.js';

/**
 * The loop's half of the continuous transcript export: the relay's board calls, the spool-cap
 * stop, and the drain after the agent's end (normal exit, kill, timeout).
 */

const job = {
    id: '55555555-5555-4555-8555-555555555555',
    leaseToken: '66666666-6666-4666-8666-666666666666',
    claimSeq: 3,
    executorType: 'claude-code',
} as unknown as BoardJob;

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
    exitCode: 0,
    output: '',
    timedOut: false,
    started: true,
    ...over,
});

function setup(options: { stoppable?: boolean; drainMs?: number } = {}) {
    const run = newExportRun();
    const board = {
        putArtifactChunk: vi.fn(async () => ({ result: 'stored' as const })),
        finalizeArtifact: vi.fn(async () => 'stored' as const),
    };
    const kill = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const drains: unknown[] = [];
    const rt = {
        board,
        runner: { kill, ...(options.stoppable === false ? {} : { stopTranscriptExport: stop }) },
        gates: { server: { drainExport: (_token: string, drain: unknown) => drains.push(drain) } },
        log: vi.fn(),
        exportDrainMs: options.drainMs ?? 5000,
    } as unknown as LoopRuntime;
    const state = newJobState();
    state.control = 'token';
    state.transcriptExport = run;
    const ctx = { rt, job, state } as unknown as AttemptCtx;
    return { run, board, kill, stop, drains, rt, ctx, relay: createExportRelay(rt, job, run) };
}

describe('attaching the export to a control token', () => {
    const attached = (executorType: string) => {
        const attach = vi.fn();
        const state = newJobState();
        const rt = { gates: { server: { attachExporter: attach } }, board: {}, runner: {}, log: vi.fn() } as never;
        attachTranscriptExport({ rt, job: { ...job, executorType } as BoardJob, state }, 'token');
        return { attach, state };
    };

    it('gives a claude-code run a relay and an export run on its state', () => {
        const { attach, state } = attached('claude-code');
        expect(attach).toHaveBeenCalledWith('token', expect.objectContaining({ putChunk: expect.any(Function) }));
        expect(state.transcriptExport).not.toBeNull();
    });

    it('leaves any other executor on its close-time read', () => {
        const { attach, state } = attached('opencode');
        expect(attach).not.toHaveBeenCalled();
        expect(state.transcriptExport).toBeNull();
    });
});

describe('the export relay', () => {
    it('forwards a chunk and a manifest to the board under the attempt, for the transcript stream of that session', async () => {
        const { relay, board } = setup();
        await relay.putChunk('sess-1', 1024, new Uint8Array([1, 2, 3]));
        expect(board.putArtifactChunk).toHaveBeenCalledWith(
            job,
            { executor: 'claude-code', session: 'sess-1', stream: 'transcript' },
            1024,
            new Uint8Array([1, 2, 3])
        );
        await relay.finalize({
            session: 'sess-1',
            state: 'partial',
            terminalCause: 'agent_killed',
            startedAt: 'a',
            finishedAt: 'b',
        });
        expect(board.finalizeArtifact).toHaveBeenCalledWith(
            job,
            { executor: 'claude-code', session: 'sess-1', stream: 'transcript' },
            {
                producer: 'exporter',
                schemaVersion: 1,
                startedAt: 'a',
                finishedAt: 'b',
                state: 'partial',
                terminalCause: 'agent_killed',
            }
        );
    });

    it('keeps the exporter vitals and kills the run once, when the spool is full', () => {
        const { relay, run, kill } = setup();
        relay.report({ pendingBytes: 10, oldestUnackedMs: 5, spoolFull: false, done: false });
        expect(run.vitals).toEqual({ pendingBytes: 10, oldestUnackedMs: 5 });
        expect(kill).not.toHaveBeenCalled();
        relay.report({ pendingBytes: 2_000_000_000, oldestUnackedMs: 9, spoolFull: true, done: false });
        relay.report({ pendingBytes: 2_000_000_001, oldestUnackedMs: 10, spoolFull: true, done: false });
        expect(run.spoolFull).toBe(true);
        expect(kill).toHaveBeenCalledTimes(1);
    });
});

describe('what the agent’s end means for its transcript', () => {
    it('is complete after a normal exit, even a failing one', () => {
        const run = newExportRun();
        expect(drainOf(outcome(), run)).toEqual({ state: 'complete', cause: null });
        expect(drainOf(outcome({ exitCode: 1 }), run)).toEqual({ state: 'complete', cause: null });
    });

    it('is partial after a kill, a timeout or a spool-cap stop, each with its own cause', () => {
        const run = newExportRun();
        expect(drainOf(outcome({ exitCode: 137 }), run)).toEqual({ state: 'partial', cause: 'agent_killed' });
        expect(drainOf(outcome({ exitCode: 137, timedOut: true }), run)).toEqual({
            state: 'partial',
            cause: 'timeout',
        });
        run.spoolFull = true;
        expect(drainOf(outcome({ exitCode: 137 }), run)).toEqual({ state: 'partial', cause: 'artifact_spool_full' });
    });
});

describe('the drain after the agent', () => {
    it('orders the drain, waits for done, then ends the exporter', async () => {
        const { ctx, run, drains, stop, relay } = setup();
        const draining = drainTranscriptExport(ctx, outcome({ exitCode: 137 }));
        expect(drains).toEqual([{ state: 'partial', cause: 'agent_killed' }]);
        expect(stop).not.toHaveBeenCalled();
        relay.report({ pendingBytes: 0, oldestUnackedMs: 0, spoolFull: false, done: true });
        await draining;
        expect(run.done).toBe(true);
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('gives up after its deadline, says so, and still ends the exporter', async () => {
        const { ctx, rt, stop } = setup({ drainMs: 30 });
        await drainTranscriptExport(ctx, outcome());
        expect(rt.log).toHaveBeenCalledWith(expect.stringContaining('did not finish draining'));
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('stamps a spool-cap stop on the outcome so the attempt fails with its cause', async () => {
        const { ctx, relay, run } = setup();
        relay.report({ pendingBytes: 4096, oldestUnackedMs: 1, spoolFull: true, done: false });
        const finished = outcome({ exitCode: 137 });
        const draining = drainTranscriptExport(ctx, finished);
        run.markDone();
        await draining;
        expect(finished.artifactSpoolFull).toBe('4096 bytes');
        const [fault] = agentFaults(finished).filter((f) => f.note?.includes('artifact_spool_full'));
        expect(fault).toMatchObject({ kind: 'runner_error', gatesStillRun: false });
    });

    it('does not wait on a runner that has no exporter to end', async () => {
        const { ctx, drains } = setup({ stoppable: false });
        await drainTranscriptExport(ctx, outcome());
        expect(drains).toEqual([]);
    });

    it('drains once', async () => {
        const { ctx, run, stop } = setup();
        run.markDone();
        await drainTranscriptExport(ctx, outcome());
        await drainTranscriptExport(ctx, outcome());
        expect(stop).toHaveBeenCalledTimes(1);
    });
});
