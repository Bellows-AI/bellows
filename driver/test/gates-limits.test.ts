import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { createSupervisedGateManager, type GateManager } from '../src/gates.js';
import { newJobState } from '../src/loop-attempt.js';
import { runDeclaredGates, type GateSession } from '../src/loop-gates.js';
import type { LoopRuntime } from '../src/loop-types.js';
import type { StepResult } from '../src/supervisor-contract.js';

const KEY = 'bellows/44444444-4444-4444-8444-444444444444/.worktrees/55555555-5555-4555-8555-555555555555';
const config = loadDriverConfig({});
const JOB = {
    id: '55555555-5555-4555-8555-555555555555',
    leaseToken: '22222222-2222-4222-8222-222222222222',
} as BoardJob;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settledWithin = (work: Promise<unknown>, ms: number) =>
    Promise.race([work.then(() => 'settled'), delay(ms).then(() => 'hung')]);

describe('Stop during the declared gates', () => {
    const rtWith = (manager: GateManager): LoopRuntime =>
        ({
            gates: { manager, server: {} as never, advertiseUrl: () => '' },
            log: () => {},
            board: { gates: async () => 'held' },
        }) as unknown as LoopRuntime;
    const session: GateSession = {
        key: KEY,
        token: 't',
        image: 'node:24',
        envBody: '',
        declared: [{ name: 'test', command: 'npm test' }],
        endPass: true,
    };

    it('honours a Stop while the per-gate re-acquire hangs', async () => {
        const manager: GateManager = {
            acquire: () => new Promise(() => {}),
            runGate: async () => ({ exitCode: 0, output: '' }),
            runSetup: async () => null,
            release: () => {},
            stop: async () => {},
        };
        const state = newJobState();
        const gates = runDeclaredGates(rtWith(manager), JOB, session, state);
        await delay(5);
        state.stopped = true;
        state.abortNow();

        expect(await settledWithin(gates, 200)).toBe('settled');
    });

    it('honours a Stop while the declared gate is queued behind another run on the same checkout', async () => {
        let runs = 0;
        const manager = createSupervisedGateManager({
            config,
            runner: {
                runGate: () =>
                    runs++ === 0
                        ? new Promise<StepResult>(() => {})
                        : Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
            },
        });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        void manager.runGate(KEY, 'test', 'npm test'); // a previous attempt's orphaned ad-hoc run
        const state = newJobState();
        const gates = runDeclaredGates(rtWith(manager), JOB, session, state);
        await delay(5);
        state.stopped = true;
        state.abortNow();

        expect(await settledWithin(gates, 200)).toBe('settled');
        await manager.stop();
    });
});
