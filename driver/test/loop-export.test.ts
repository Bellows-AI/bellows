import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { agentFaults } from '../src/loop/loop-ledger.js';
import {
    attachTranscriptExport,
    createExportRelay,
    createVolumeExportOpener,
    drainTranscriptExport,
    newExportRun,
    VOLUME_EXPORT_CAUSE,
} from '../src/loop/loop-export.js';
import { killAgent, newJobState } from '../src/loop/loop-attempt.js';
import type { AttemptCtx, LoopRuntime } from '../src/loop/loop-types.js';
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

function setup(options: { gates?: boolean } = {}) {
    const run = newExportRun();
    const board = {
        putArtifactChunk: vi.fn(async () => ({ result: 'stored' as const })),
        finalizeArtifact: vi.fn(async () => 'stored' as const),
    };
    const kill = vi.fn(async () => {});
    const stopAgent = vi.fn(async () => {});
    const raiseKill = vi.fn();
    const recordKill = vi.fn(async () => {});
    const rt = {
        board,
        runner: { kill, stopAgent, recordKill },
        ...(options.gates === false ? {} : { gates: { server: { raiseKill } } }),
        log: vi.fn(),
    } as unknown as LoopRuntime;
    const state = newJobState();
    state.control = 'token';
    state.transcriptExport = run;
    const ctx = { rt, job, state } as unknown as AttemptCtx;
    const relay = createExportRelay(rt, job, run, (kill) => killAgent(rt, job, 'token', kill));
    return { run, board, kill, stopAgent, raiseKill, recordKill, rt, ctx, relay };
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

    it('keeps the exporter vitals and ends the agent once, under its supervisor, when the spool is full', async () => {
        const { relay, run, kill, stopAgent, raiseKill, ctx } = setup();
        relay.report({ pendingBytes: 10, oldestUnackedMs: 5, spoolFull: false, done: false });
        expect(run.vitals).toEqual({ pendingBytes: 10, oldestUnackedMs: 5 });
        expect(stopAgent).not.toHaveBeenCalled();
        relay.report({ pendingBytes: 2_000_000_000, oldestUnackedMs: 9, spoolFull: true, done: false });
        relay.report({ pendingBytes: 2_000_000_001, oldestUnackedMs: 10, spoolFull: true, done: false });
        expect(run.spoolFull).toBe(true);
        // Failure evidence, not an ending (issue #828): the attempt still concludes with its verdict.
        expect(ctx.state.ending).toBeNull();
        await vi.waitFor(() => expect(stopAgent).toHaveBeenCalledTimes(1));
        // The kill order for the supervisor, then the bounded wait for the pod to wind down: the
        // exporter drains what the agent wrote before anything is deleted.
        expect(raiseKill).toHaveBeenCalledExactlyOnceWith('token');
        expect(stopAgent).toHaveBeenCalledTimes(1);
        expect(kill).not.toHaveBeenCalled();
    });

    it('records a full spool on the runner before the kill order, for a claim adopting the run', async () => {
        const { relay, stopAgent, raiseKill, recordKill } = setup();
        relay.report({ pendingBytes: 2_000_000_000, oldestUnackedMs: 9, spoolFull: true, done: false });
        await vi.waitFor(() => expect(stopAgent).toHaveBeenCalledTimes(1));
        expect(recordKill).toHaveBeenCalledExactlyOnceWith(job, {
            reason: 'artifact_spool_full',
            detail: '2000000000 bytes',
        });
        expect(recordKill.mock.invocationCallOrder[0]).toBeLessThan(raiseKill.mock.invocationCallOrder[0] as number);
    });

    it('falls back to the hard kill with no control endpoint to raise the kill order on', async () => {
        const { relay, kill, raiseKill } = setup({ gates: false });
        relay.report({ pendingBytes: 2_000_000_000, oldestUnackedMs: 9, spoolFull: true, done: false });
        await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1));
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

describe('the volume export channel (issue #938)', () => {
    const attempt = { jobId: job.id, claimSeq: 3 };
    const open = async (answer: object = { result: 'stored' }, finalized = 'stored') => {
        const board = {
            putArtifactChunk: vi.fn(async () => answer),
            finalizeArtifact: vi.fn(async () => finalized),
        };
        const server = {
            listen: vi.fn(async () => 4321),
            openControl: vi.fn(),
            grantExporter: vi.fn(),
            revokeExporter: vi.fn(),
            closeControl: vi.fn(),
        };
        const gates = { server, advertiseUrl: (port: number) => `http://driver:${port}` };
        const channel = await createVolumeExportOpener({ board, gates, log: vi.fn() } as never)(attempt);
        const relay = server.grantExporter.mock.calls[0]![2] as ReturnType<typeof createExportRelay>;
        return { board, server, channel: channel!, relay };
    };
    const MANIFEST = { session: 's', state: 'partial' as const, startedAt: 'a', finishedAt: 'b' };

    it('has no channel without a control endpoint', async () => {
        expect(await createVolumeExportOpener({ board: {}, log: vi.fn() } as never)(attempt)).toBeNull();
    });

    it('hands the exporter the endpoint and a token of its own, and files its chunks under the attempt', async () => {
        const { board, server, channel, relay } = await open();
        expect(channel.url).toBe('http://driver:4321');
        expect(server.grantExporter).toHaveBeenCalledWith(expect.any(String), channel.token, expect.anything());
        await relay.putChunk('s', 0, new Uint8Array([1]));
        expect(board.putArtifactChunk).toHaveBeenCalledWith(
            expect.objectContaining({ id: job.id, claimSeq: 3 }),
            { executor: 'claude-code', session: 's', stream: 'transcript' },
            0,
            new Uint8Array([1])
        );
    });

    it('is drained only once the exporter reported done, with nothing refused and every stream closed by the order', async () => {
        const { channel, relay } = await open();
        expect(channel.proof()).toMatchObject({ drained: false, why: expect.stringContaining('did not report done') });
        await relay.putChunk('s', 0, new Uint8Array([1]));
        await relay.finalize({ ...MANIFEST, terminalCause: VOLUME_EXPORT_CAUSE });
        relay.report({ pendingBytes: 0, oldestUnackedMs: 0, spoolFull: false, done: true });
        expect(channel.proof()).toEqual({ drained: true });
    });

    it.each([['conflict'], ['rejected']])(
        'is not drained after a chunk the board answered %s, whatever the exporter says',
        async (result) => {
            const { channel, relay } = await open({ result });
            await relay.putChunk('s', 0, new Uint8Array([1]));
            relay.report({ pendingBytes: 0, oldestUnackedMs: 0, spoolFull: false, done: true });
            expect(channel.proof()).toMatchObject({ drained: false, why: expect.stringContaining(result) });
        }
    );

    it('leaves a 409 that names the recorded chunk to the exporter: drained once it closed the stream by the order', async () => {
        const { channel, relay } = await open({ result: 'conflict', recorded: { length: 1, sha256: 'a'.repeat(64) } });
        await relay.putChunk('s', 0, new Uint8Array([1, 2]));
        await relay.finalize({ ...MANIFEST, terminalCause: VOLUME_EXPORT_CAUSE });
        relay.report({ pendingBytes: 0, oldestUnackedMs: 0, spoolFull: false, done: true });
        expect(channel.proof()).toEqual({ drained: true });
    });

    it.each([['rejected'], ['conflict']])('is not drained after a manifest the board answered %s', async (answer) => {
        const { channel, relay } = await open({ result: 'stored' }, answer);
        await relay.finalize({ ...MANIFEST, terminalCause: VOLUME_EXPORT_CAUSE });
        relay.report({ pendingBytes: 0, oldestUnackedMs: 0, spoolFull: false, done: true });
        expect(channel.proof()).toMatchObject({ drained: false, why: expect.stringContaining(answer) });
    });

    it('is not drained when a stream was closed with another cause than the order, or truncated', async () => {
        const { channel, relay } = await open();
        relay.report({ pendingBytes: 0, oldestUnackedMs: 0, spoolFull: false, done: true });
        await relay.finalize({ ...MANIFEST, terminalCause: 'upload_rejected' });
        expect(channel.proof()).toMatchObject({ drained: false, why: expect.stringContaining('upload_rejected') });
    });

    it('revokes both tokens once, however often it is closed', async () => {
        const { server, channel } = await open();
        channel.close();
        channel.close();
        expect(server.revokeExporter).toHaveBeenCalledTimes(1);
        expect(server.revokeExporter).toHaveBeenCalledWith(channel.token);
        expect(server.closeControl).toHaveBeenCalledTimes(1);
    });
});
