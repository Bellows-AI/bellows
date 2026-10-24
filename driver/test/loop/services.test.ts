import { describe, expect, it } from 'vitest';
import type { DeadService } from '../../src/runner.js';
import { Inconclusive } from '../../src/runner.js';
import { StepChannelClosed } from '../../src/step-control.js';
import type { PublishResult } from '../../src/publish/publish.js';
import { drive, gatedJob, job, ok, stubBoard, stubGateStack, stubRunner } from '../fixtures/loop-stubs.js';

describe('a dead declared service (issue #423)', () => {
    /**
     * A service that died before the gates run makes every gate fail on an environment the agent
     * cannot fix. The gates are skipped, the verdict names the service — its exit and its last
     * log lines — and lands as `services`, never `gate`, so the workflow's gate-fix edge cannot
     * spend a round on it.
     */
    const mongo: DeadService = {
        name: 'test-mongo',
        image: 'mongo:8.0.11',
        state: 'failed',
        exitCode: 1,
        reason: 'Error',
        logTail: 'chown: changing ownership of /data/db: Operation not permitted',
    };

    const draftPr: PublishResult = {
        ok: true,
        published: true,
        branch: 'factory/1',
        prUrl: 'https://github.com/Bellows-AI/factory/pull/7',
        reason: null,
        cause: null,
        repository: 'Bellows-AI/factory',
        baseBranch: 'main',
        prNumber: 7,
    };

    it('restarts a fleet found dead before the gates, then runs them (issue #560)', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        let probes = 0;
        const runner = stubRunner(async () => ok({ output: 'agent did the work' }), {
            deadServices: async () => (probes++ === 0 ? [mongo] : []),
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(runner.restartedServices).toEqual([gatedJob(1).id]);
        expect(stack.stack.ran.names).toEqual(['test', 'lint']);
        const complete = board.board.completed[0]!;
        expect(complete).toMatchObject({ status: 'succeeded', exitCode: 0 });
        expect(complete).not.toHaveProperty('failureKind');
        // Not a fault, but never silent: the loss is on the verdict the board shows.
        expect(complete.output).toContain(
            '[driver] service "test-mongo" (mongo:8.0.11) failed — exit 1 (Error); restarted before the declared gates'
        );
        expect(runner.servicesReleased).toEqual([gatedJob(1).id]);
    });

    it('a failed restart skips the gates, fails as services naming the cause, and drafts the work (issue #560)', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok({ output: 'agent did the work' }), {
            deadServices: async () => [mongo],
            restartServices: async () => {
                throw new Error('service "test-mongo" is not running after 300s');
            },
            publish: draftPr,
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.ran.names).toEqual([]);
        expect(board.board.gatesReported).toEqual([]);
        const complete = board.board.completed[0]!;
        expect(complete).toMatchObject({ status: 'failed', failureKind: 'services', exitCode: 0 });
        expect(complete.output).toContain('agent did the work');
        expect(complete.output).toContain(
            '[driver] service "test-mongo" (mongo:8.0.11) failed — exit 1 (Error); ' +
                'restart failed: service "test-mongo" is not running after 300s; declared gates skipped'
        );
        expect(complete.output).toContain('chown: changing ownership of /data/db: Operation not permitted');
        // The finished work stays recoverable: a draft PR, recorded on the verdict.
        expect(runner.publishOptions).toEqual([{ draft: true }]);
        expect(complete.output).toContain(
            '[driver] published factory/1 — https://github.com/Bellows-AI/factory/pull/7'
        );
        expect(complete.publication).toMatchObject({ prNumber: 7 });
        expect(runner.servicesReleased).toEqual([gatedJob(1).id]);
    });

    it('parks a Stop that lands during the restart at once, aborting it and running no gates (issue #560)', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([gatedJob(1)], options);
        const stack = stubGateStack();
        let restartSignal: AbortSignal | undefined;
        const runner = stubRunner(async () => ok(), {
            deadServices: async () => [mongo],
            // A restart that would wait out its whole budget: only the abort ends it.
            restartServices: (signal) => {
                restartSignal = signal;
                options.cancelRequested = true;
                return new Promise(() => {});
            },
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(restartSignal?.aborted).toBe(true);
        expect(stack.stack.ran.names).toEqual([]);
        expect(board.board.completed).toEqual([]);
        expect(board.board.suspended).toEqual([gatedJob(1).id]);
        expect(runner.published).toEqual([]);
    });

    // R2-1: a restart whose supervisor was lost, or whose pod could not be read, is the attempt's
    // infrastructure loss — interrupted for the next claim, never a `services` verdict.
    it.each([
        ['lost its supervisor', () => new StepChannelClosed('the service restart')],
        ['could not read the task pod', () => new Inconclusive('the task pod could not be listed (HTTP 503)')],
    ])('interrupts an attempt whose pre-gate restart %s, running no gates', async (_label, lost) => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok({ output: 'agent did the work' }), {
            deadServices: async () => [mongo],
            restartServices: async () => {
                throw lost();
            },
            publish: draftPr,
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.ran.names).toEqual([]);
        expect(board.board.completed).toEqual([]);
        expect(runner.published).toEqual([]);
        expect(board.board.interrupted).toHaveLength(1);
        expect(board.board.interrupted[0]?.reason).toContain(lost().message);
    });

    it('drafts nothing when the services failed under a gates-required policy, or the board reserves publication', async () => {
        const board = stubBoard([
            { ...gatedJob(1), policy: { gates: true } },
            { ...gatedJob(2), publish: false },
        ]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok(), {
            deadServices: async () => [mongo],
            restartServices: async () => {
                throw new Error('no node');
            },
            publish: draftPr,
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(runner.published).toEqual([]);
        expect(board.board.completed.map((c) => c.failureKind)).toEqual(['services', 'services']);
    });

    it('runs the gates when every service is alive, probing once', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        expect(runner.deadServiceProbes).toBe(1);
        expect(stack.stack.ran.names).toEqual(['test', 'lint']);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it('runs the gates when the probe itself fails, and logs why', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const logs: string[] = [];
        const runner = stubRunner(async () => ok(), {
            deadServices: async () => {
                throw new Error('the API server is away');
            },
        });

        await drive({ ...board, runner, gates: stack.gates, log: (m) => logs.push(m) });

        expect(stack.stack.ran.names).toEqual(['test', 'lint']);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
        expect(logs.some((m) => m.includes('the API server is away'))).toBe(true);
    });

    it('never probes a refused run or an ungated job', async () => {
        const board = stubBoard([gatedJob(1), job(2)]);
        const stack = stubGateStack();
        // By id, not by call order: the two attempts' setups interleave.
        const runner = stubRunner(
            async (claimed) =>
                claimed.id === gatedJob(1).id ? ok({ exitCode: 1, output: 'refused', refused: true }) : ok(),
            { deadServices: async () => [mongo] }
        );

        await drive({ ...board, runner, gates: stack.gates });

        expect(runner.deadServiceProbes).toBe(0);
        // By id too: the two attempts' verdicts land in either order.
        expect(Object.fromEntries(board.board.completed.map((c) => [c.id, c.failureKind ?? null]))).toEqual({
            [gatedJob(1).id]: 'runner_error',
            [job(2).id]: null,
        });
    });

    it('names the dead service when the gates are skipped — an unclean exit or a blocked agent (issue #487)', async () => {
        const board = stubBoard([gatedJob(1), gatedJob(2)]);
        const stack = stubGateStack();
        let ran = 0;
        const runner = stubRunner(
            async () =>
                ran++ === 0 ? ok({ exitCode: 1 }) : ok({ output: 'FACTORY_BLOCKED: acli is not authenticated' }),
            { deadServices: async () => [mongo] }
        );

        await drive({ ...board, runner, gates: stack.gates });

        expect(runner.deadServiceProbes).toBe(2);
        expect(runner.restartedServices).toEqual([]);
        expect(stack.stack.ran.names).toEqual([]);
        expect(board.board.completed.map((c) => c.failureKind ?? null)).toEqual(['services', 'blocked']);
        for (const complete of board.board.completed) {
            expect(complete.output).toContain('[driver] service "test-mongo" (mongo:8.0.11) failed — exit 1 (Error)');
            expect(complete.output).toContain('chown: changing ownership of /data/db: Operation not permitted');
            expect(complete.output).not.toContain('declared gates skipped');
        }
    });

    it('ranks a timeout above the dead service', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok({ exitCode: 124, timedOut: true }), {
            deadServices: async () => [mongo],
            restartServices: async () => {
                throw new Error('no node');
            },
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.ran.names).toEqual([]);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'timeout' });
    });
});

describe('a service that dies during the gates (issue #437)', () => {
    const mongo: DeadService = {
        name: 'test-mongo',
        image: 'mongo:8.0.11',
        state: 'failed',
        exitCode: 137,
        reason: 'OOMKilled',
        logTail: 'killed',
    };

    it('re-probes after a failed gate and blames the service, not the code', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack({ test: 1 });
        let probes = 0;
        const runner = stubRunner(async () => ok(), { deadServices: async () => (probes++ === 0 ? [] : [mongo]) });

        await drive({ ...board, runner, gates: stack.gates });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'services' });
    });

    it('does not re-probe when the gates pass', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        expect(runner.deadServiceProbes).toBe(1);
    });

    it('keeps a failed gate a gate failure when every service is still alive', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack({ test: 1 });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'gate' });
    });
});
