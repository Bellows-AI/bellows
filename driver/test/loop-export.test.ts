import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { agentFaults } from '../src/loop-ledger.js';
import { attachTranscriptExport, createExportRelay, drainTranscriptExport, newExportRun } from '../src/loop-export.js';
import { newJobState } from '../src/loop-attempt.js';
import type { AttemptCtx, LoopRuntime } from '../src/loop-types.js';
import type { RunOutcome } from '../src/runner.js';

/**
 * The loop's half of the continuous transcript export: the relay's board calls, the spool-cap
 * stop, and the check after the run. The drain itself belongs to the supervisor in the run's pod
 * (`supervisor.test.ts`), so the loop has nothing to order or to end.
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

function setup(options: { supervised?: boolean } = {}) {
    const run = newExportRun();
    const board = {
        putArtifactChunk: vi.fn(async () => ({ result: 'stored' as const })),
        finalizeArtifact: vi.fn(async () => 'stored' as const),
    };
    const kill = vi.fn(async () => {});
    const stopAgent = vi.fn(async () => {});
    const raiseKill = vi.fn();
    const rt = {
        board,
        runner: { kill, ...(options.supervised === false ? {} : { stopAgent }) },
        gates: { server: { raiseKill } },
        log: vi.fn(),
    } as unknown as LoopRuntime;
    const state = newJobState();
    state.control = 'token';
    state.transcriptExport = run;
    const ctx = { rt, job, state } as unknown as AttemptCtx;
    return { run, board, kill, stopAgent, raiseKill, rt, ctx, relay: createExportRelay(rt, job, run, 'token') };
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

    it('keeps the exporter vitals and ends the agent once, under its supervisor, when the spool is full', () => {
        const { relay, run, kill, stopAgent, raiseKill } = setup();
        relay.report({ pendingBytes: 10, oldestUnackedMs: 5, spoolFull: false, done: false });
        expect(run.vitals).toEqual({ pendingBytes: 10, oldestUnackedMs: 5 });
        expect(stopAgent).not.toHaveBeenCalled();
        relay.report({ pendingBytes: 2_000_000_000, oldestUnackedMs: 9, spoolFull: true, done: false });
        relay.report({ pendingBytes: 2_000_000_001, oldestUnackedMs: 10, spoolFull: true, done: false });
        expect(run.spoolFull).toBe(true);
        // The kill order for the supervisor, then the bounded wait for the pod to wind down: the
        // exporter drains what the agent wrote before anything is deleted.
        expect(raiseKill).toHaveBeenCalledExactlyOnceWith('token');
        expect(stopAgent).toHaveBeenCalledTimes(1);
        expect(kill).not.toHaveBeenCalled();
    });

    it('falls back to the hard kill on a runner that supervises nothing', () => {
        const { relay, kill, raiseKill } = setup({ supervised: false });
        relay.report({ pendingBytes: 2_000_000_000, oldestUnackedMs: 9, spoolFull: true, done: false });
        expect(kill).toHaveBeenCalledTimes(1);
        expect(raiseKill).not.toHaveBeenCalled();
    });

    it('remembers the exporter reported done', () => {
        const { relay, run } = setup();
        relay.report({ pendingBytes: 0, oldestUnackedMs: 0, spoolFull: false, done: true });
        expect(run.done).toBe(true);
    });
});

describe('the check after the run', () => {
    it('stamps a spool-cap stop on the outcome so the attempt fails with its cause', () => {
        const { ctx, relay } = setup();
        relay.report({ pendingBytes: 4096, oldestUnackedMs: 1, spoolFull: true, done: true });
        const finished = outcome({ exitCode: 137 });
        drainTranscriptExport(ctx, finished);
        expect(finished.artifactSpoolFull).toBe('4096 bytes');
        const [fault] = agentFaults(finished).filter((f) => f.note?.includes('artifact_spool_full'));
        expect(fault).toMatchObject({ kind: 'runner_error', gatesStillRun: false });
    });

    it('waits for nothing: the pod ended only after the supervisor had the exporter drain', () => {
        const { ctx, rt, relay } = setup();
        relay.report({ pendingBytes: 0, oldestUnackedMs: 0, spoolFull: false, done: true });
        drainTranscriptExport(ctx, outcome());
        expect(rt.log).not.toHaveBeenCalled();
    });

    it('says so when the exporter never reported done, and leaves the bytes on the volume', () => {
        const { ctx, rt } = setup();
        drainTranscriptExport(ctx, outcome());
        expect(rt.log).toHaveBeenCalledWith(expect.stringContaining('did not report done'));
    });

    it('checks once', () => {
        const { ctx, rt } = setup();
        drainTranscriptExport(ctx, outcome());
        drainTranscriptExport(ctx, outcome());
        expect(rt.log).toHaveBeenCalledTimes(1);
    });
});
