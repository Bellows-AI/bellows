import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { Inconclusive } from '../../src/runner.js';
import type { GateRun } from '../../src/gates.js';
import { setupTimeoutMs } from '../../src/claim.js';
import { ServicesNotRunning } from '../../src/service-restart.js';
import { config, drive, gatedJob, job, ok, stubBoard, stubGateStack, stubRunner } from '../fixtures/loop-stubs.js';

// Issue #733: environment.setup runs in the task worktree before the agent's first turn.
describe('environment.setup before the agent starts', () => {
    const setupJob = (n: number, gates = gatedJob(n).gates?.gates ?? []): BoardJob => ({
        ...gatedJob(n),
        turnContext: 'Factory turn context',
        gates: { image: 'node:24', setup: 'npm ci', gates },
    });

    it('runs setup before the runner, under the capped setup timeout, and reports how long it took', async () => {
        const board = stubBoard([setupJob(1)]);
        const { stack, gates } = stubGateStack({}, { setup: { exitCode: 0, output: 'installed' } });
        let setupsBeforeRun = -1;
        let seenSetupMs: number | undefined;
        const runner = stubRunner(async (j) => {
            setupsBeforeRun = stack.setups.length;
            seenSetupMs = j.setupMs;
            return ok();
        });

        await drive({ ...board, runner, gates });

        expect(setupsBeforeRun).toBe(1);
        expect(stack.setups[0]?.timeoutMs).toBe(setupTimeoutMs(config()));
        expect(stack.setups[0]?.signal).toBeInstanceOf(AbortSignal);
        expect(seenSetupMs).toBeGreaterThanOrEqual(0);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded', setupMs: seenSetupMs });
    });

    it('still launches the agent after a failed setup, with the exit code and tail in its turn context', async () => {
        const board = stubBoard([setupJob(1)]);
        const { gates } = stubGateStack({}, { setup: { exitCode: 7, output: 'npm ERR! registry down' } });
        let seen: string | undefined;
        const runner = stubRunner(async (j) => {
            seen = j.turnContext;
            return ok();
        });

        await drive({ ...board, runner, gates });

        expect(seen).toContain('Factory turn context');
        expect(seen).toContain('exit 7');
        expect(seen).toContain('npm ERR! registry down');
        expect(board.board.completed).toHaveLength(1);
    });

    it('treats a setup the harness could not run as a failed setup, and still launches', async () => {
        const board = stubBoard([setupJob(1)]);
        const { stack, gates } = stubGateStack();
        stack.manager.runSetup = async () => {
            throw new Error('gate environment is gone');
        };
        let seen: string | undefined;
        const runner = stubRunner(async (j) => {
            seen = j.turnContext;
            return ok();
        });

        await drive({ ...board, runner, gates });

        expect(seen).toContain('gate environment is gone');
        expect(board.board.completed).toHaveLength(1);
    });

    it('spawns nothing when a Stop lands during setup', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([setupJob(1)], options);
        const { stack, gates } = stubGateStack();
        let seen: AbortSignal | undefined;
        stack.manager.runSetup = async (_key, setupOptions) => {
            seen = setupOptions?.signal;
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { exitCode: 0, output: '' };
        };
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });

        await drive({ ...board, runner, gates });

        expect(seen?.aborted).toBe(true);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
        expect(stack.released).toHaveLength(1);
    });

    it('runs setup for a checkout that declares setup and no gates', async () => {
        const board = stubBoard([setupJob(1, [])]);
        const { stack, gates } = stubGateStack({}, { setup: { exitCode: 0, output: '' } });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates });

        expect(stack.setups).toHaveLength(1);
        expect(stack.ran.names).toEqual([]);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    // Review round 1: a failed setup must be visible on the task, gates declared or not.
    /** A runSetup whose answers are popped in order: the pre-agent run, then the end-of-run retry. */
    const scriptedSetups = (stack: ReturnType<typeof stubGateStack>['stack'], answers: GateRun[]) => {
        stack.manager.runSetup = async (_key, setupOptions = {}) => {
            stack.setups.push(setupOptions);
            return answers.shift() ?? null;
        };
    };
    const SETUP_FAILED: GateRun = { exitCode: 7, output: 'npm ERR! registry down' };

    it('fails a setup-only task whose setup still fails after the agent, as a setup-failed gate', async () => {
        const board = stubBoard([setupJob(1, [])]);
        const { stack, gates } = stubGateStack();
        scriptedSetups(stack, [SETUP_FAILED, SETUP_FAILED]);
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates });

        expect(stack.setups).toHaveLength(2);
        expect(stack.ran.names).toEqual([]);
        const complete = board.board.completed[0]!;
        expect(complete).toMatchObject({ status: 'failed', failureKind: 'gate', exitCode: 7 });
        expect(complete.output).toContain('[setup failed — the gate did not run]');
        expect(complete.output).toContain('npm ERR! registry down');
    });

    it('passes a setup-only task once the agent fixed the setup', async () => {
        const board = stubBoard([setupJob(1, [])]);
        const { stack, gates } = stubGateStack();
        scriptedSetups(stack, [SETUP_FAILED, { exitCode: 0, output: 'installed' }]);
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates });

        expect(stack.setups).toHaveLength(2);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
        expect(board.board.completed[0]?.output).not.toContain('environment.setup failed');
    });

    it('notes the failed setup on the verdict when the gate pass is skipped', async () => {
        const board = stubBoard([setupJob(1)]);
        const { stack, gates } = stubGateStack();
        scriptedSetups(stack, [SETUP_FAILED]);
        const runner = stubRunner(async () => ok({ exitCode: 2, output: 'agent gave up' }));

        await drive({ ...board, runner, gates });

        expect(stack.ran.names).toEqual([]);
        const output = board.board.completed[0]?.output ?? '';
        expect(output).toContain('environment.setup failed before the agent started (exit 7)');
        expect(output).toContain('npm ERR! registry down');
    });

    it('adds no setup note once the declared gates passed (the agent fixed the setup)', async () => {
        const board = stubBoard([setupJob(1)]);
        const { stack, gates } = stubGateStack();
        scriptedSetups(stack, [SETUP_FAILED]);
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates });

        expect(stack.ran.names).toEqual(['test', 'lint']);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
        expect(board.board.completed[0]?.output).not.toContain('environment.setup failed');
    });

    it('says how much of the run budget setup took when the run timed out', async () => {
        const board = stubBoard([setupJob(1)]);
        const { gates } = stubGateStack({}, { setup: { exitCode: 0, output: '' } });
        const runner = stubRunner(async () => ok({ exitCode: 137, timedOut: true, output: 'still working' }));

        await drive({ ...board, runner, gates });

        expect(board.board.completed[0]?.output).toMatch(/ms of the \d+ms run budget went to environment\.setup/);
    });

    // Review (PR 737): setup that migrates or seeds a declared service needs the fleet up first.
    it('starts the services before the gate environment and setup, once, and never through the launch', async () => {
        const board = stubBoard([setupJob(1)]);
        const { stack, gates } = stubGateStack({}, { setup: { exitCode: 0, output: '' } });
        const order: string[] = [];
        const runner = stubRunner(async () => {
            order.push('run');
            return ok();
        });
        const rawStart = runner.startServices.bind(runner);
        runner.startServices = async (started) => {
            order.push('services');
            return rawStart(started);
        };
        const rawAcquire = stack.manager.acquire.bind(stack.manager);
        stack.manager.acquire = async (...args) => {
            order.push('acquire');
            return rawAcquire(...args);
        };
        const rawSetup = stack.manager.runSetup.bind(stack.manager);
        stack.manager.runSetup = async (...args) => {
            order.push('setup');
            return rawSetup(...args);
        };

        await drive({ ...board, runner, gates });

        expect(order.slice(0, 4)).toEqual(['services', 'acquire', 'setup', 'run']);
        expect(runner.startedServices).toEqual([setupJob(1).id]);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it('fails a refused service start as before, spawning no agent and running no setup', async () => {
        const board = stubBoard([setupJob(1)]);
        const { stack, gates } = stubGateStack({}, { setup: { exitCode: 0, output: '' } });
        const refusal = '.bellows.yaml: unknown key "ports"';
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });
        runner.startServices = async () => ({
            exitCode: null,
            output: refusal,
            timedOut: false,
            started: true,
            refused: true,
        });

        await drive({ ...board, runner, gates });

        expect(stack.setups).toEqual([]);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', output: refusal });
        expect(runner.servicesReleased).toEqual([setupJob(1).id]);
    });

    it('spawns nothing when a Stop lands while the services start, and releases what the start left', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([setupJob(1)], options);
        const { stack, gates } = stubGateStack();
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });
        runner.startServices = async () => {
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return null;
        };

        await drive({ ...board, runner, gates });
        // The abandoned start settles on its own timer and its fleet is released then.
        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(stack.acquired).toEqual([]);
        expect(board.board.suspended).toEqual([setupJob(1).id]);
        expect(board.board.completed).toEqual([]);
        expect(runner.servicesReleased).toEqual([setupJob(1).id]);
    });

    // Review: setup must not race a fleet still being scheduled or pulled. The runners wait until
    // every service runs; one that never does fails the run the way the pre-gate restart does.
    it('fails the run as a services fault when a service never runs, before any setup or agent', async () => {
        const board = stubBoard([setupJob(1)]);
        const { stack, gates } = stubGateStack({}, { setup: { exitCode: 0, output: '' } });
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });
        let seen: AbortSignal | undefined;
        runner.startServices = async (_started, signal) => {
            seen = signal;
            throw new ServicesNotRunning('service "db" exited after the start');
        };

        await drive({ ...board, runner, gates });

        expect(seen).toBeInstanceOf(AbortSignal);
        expect(stack.setups).toEqual([]);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'services' });
        expect(board.board.completed[0]?.output).toContain('service "db" exited after the start');
        expect(runner.servicesReleased).toEqual([setupJob(1).id]);
    });

    // Issue #822: the daemon's or the cluster's refusal, said by a live driver — handed back with its
    // reason inside the interruption budget, never left to a lease the board records as silence.
    it('hands a service start the daemon or cluster refused back as an interruption', async () => {
        const board = stubBoard([setupJob(1)]);
        const { stack, gates } = stubGateStack();
        const logs: string[] = [];
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });
        runner.startServices = async () => {
            throw new Error('could not create the services network: daemon refused');
        };

        await drive({ ...board, runner, gates, log: (line) => logs.push(line) });

        expect(stack.acquired).toEqual([]);
        expect(board.board.completed).toEqual([]);
        expect(board.board.interrupted).toEqual([
            {
                id: setupJob(1).id,
                reason: 'could not start the services: could not create the services network: daemon refused',
                release: true,
            },
        ]);
        expect(
            logs.some((line) => line.includes('could not start the services') && line.includes('interruption'))
        ).toBe(true);
    });

    // R2-1: readiness whose listing never answered proves nothing about the services.
    it('interrupts an attempt whose service readiness could never be read, never failing it', async () => {
        const board = stubBoard([setupJob(1)]);
        const { stack, gates } = stubGateStack({}, { setup: { exitCode: 0, output: '' } });
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });
        runner.startServices = async () => {
            throw new Inconclusive('the services could not be listed 300s after the start: the API server is away');
        };

        await drive({ ...board, runner, gates });

        expect(stack.setups).toEqual([]);
        expect(board.board.completed).toEqual([]);
        expect(board.board.interrupted[0]?.reason).toContain('the services could not be listed 300s after the start');
    });

    it('reports a refused service start on the last attempt, once the interruption budget is spent', async () => {
        const board = stubBoard([{ ...setupJob(1), lastAttempt: true }], { interruptVerdict: 'exhausted' });
        const { gates } = stubGateStack();
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });
        runner.startServices = async () => {
            throw new Error('could not create the services network: daemon refused');
        };

        await drive({ ...board, runner, gates });

        expect(board.board.interrupted).toHaveLength(1);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'runner_error' });
        expect(board.board.completed[0]?.output).toContain('could not start the services');
    });

    it('releases the started services even when the setup conclusion itself throws', async () => {
        const board = stubBoard([setupJob(1)]);
        const { stack, gates } = stubGateStack();
        stack.manager.acquire = async () => {
            throw new Error('image pull refused');
        };
        const runner = stubRunner(async () => ok());
        runner.releaseFence = async () => {
            throw new Error('the claim could not be released');
        };

        await drive({ ...board, runner, gates });

        expect(runner.servicesReleased).toEqual([setupJob(1).id]);
    });

    it('releases the started services when the gate environment cannot start', async () => {
        const board = stubBoard([setupJob(1)]);
        const { stack, gates } = stubGateStack();
        stack.manager.acquire = async () => {
            throw new Error('image pull refused');
        };
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'runner_error' });
        expect(runner.servicesReleased).toEqual([setupJob(1).id]);
    });

    it('runs no setup and reports no setup time for a gated checkout without setup', async () => {
        const board = stubBoard([gatedJob(1)]);
        const { gates } = stubGateStack();
        let seenSetupMs: number | undefined = -1;
        const runner = stubRunner(async (j) => {
            seenSetupMs = j.setupMs;
            return ok();
        });

        await drive({ ...board, runner, gates });

        expect(seenSetupMs).toBeUndefined();
        expect(board.board.completed[0]).not.toHaveProperty('setupMs');
    });
});

describe('verification gates', () => {
    it('runs every declared gate after the agent finishes, and only then reports success', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        let ranBeforeOutcome = false;
        const runner = stubRunner(async () => {
            ranBeforeOutcome = stack.stack.acquired.length > 0;
            return ok({ output: 'agent did the work' });
        });

        await drive({ ...board, runner, gates: stack.gates });

        // The environment was ensured BEFORE the agent ran — the ad-hoc channel needs it live
        // mid-run, not after it.
        expect(ranBeforeOutcome).toBe(true);
        expect(stack.stack.ran.names).toEqual(['test', 'lint']);
        expect(board.board.gatesReported.map((r) => r.results.map((g) => g.status))).toEqual([
            ['running'],
            ['passed'],
            ['passed', 'running'],
            ['passed', 'passed'],
        ]);
        const complete = board.board.completed[0]!;
        expect(complete.status).toBe('succeeded');
        // The verdict lands after every gate report — a reader never sees a succeeded task whose
        // checks are still shown as running.
        expect(board.board.gatesReported.length).toBeGreaterThan(0);
        // The environment goes back to its cooldown either way — filed under the task's worktree.
        expect(stack.stack.released).toEqual([`${gatedJob(1).id}/factory`]);
        expect(stack.stack.unregistered).toBe(1);
    });

    it('uploads the run’s log under its claim sequence before the gates, and still succeeds', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok({ fullLog: 'line one\nline two\n', sessionId: 'sess-1' }));

        await drive({ ...board, runner, gates: stack.gates });

        expect(board.board.artifactChunks).toEqual([
            {
                id: gatedJob(1).id,
                claimSeq: gatedJob(1).claimSeq,
                stream: 'log',
                offset: 0,
                text: 'line one\nline two\n',
            },
        ]);
        expect(board.board.artifactManifests).toEqual([
            { id: gatedJob(1).id, claimSeq: gatedJob(1).claimSeq, stream: 'log', state: 'complete' },
        ]);
        expect(board.board.completed[0]!.status).toBe('succeeded');
    });

    it('keeps a passing verdict when every artifact upload fails', async () => {
        const board = stubBoard([gatedJob(1)], { artifactsDown: true });
        const stack = stubGateStack();
        const logs: string[] = [];
        const runner = stubRunner(async () =>
            ok({ fullLog: 'line one\n', transcript: '{"a":1}\n', sessionId: 'sess-1' })
        );

        await drive({ ...board, runner, gates: stack.gates, log: (m) => logs.push(m) });

        expect(stack.stack.ran.names).toEqual(['test', 'lint']);
        expect(board.board.completed[0]!.status).toBe('succeeded');
        expect(board.board.artifactManifests).toEqual([]);
        expect(logs.some((m) => m.includes('artifact') && m.includes('failed'))).toBe(true);
    });

    it('fails the job with the first failing gate, and relays its output', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack({ lint: 3 });
        const runner = stubRunner(async () => ok({ output: 'agent did the work' }));

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.ran.names).toEqual(['test', 'lint']);
        const complete = board.board.completed[0]!;
        // Issue #581: the cause rides beside the kind — a gate's real exit is a verification failure.
        expect(complete).toMatchObject({ status: 'failed', failureKind: 'gate', failureCause: 'verification' });
        expect(complete.exitCode).toBe(3);
        expect(complete.output).toContain('lint');
        expect(complete.output).toContain('lint failed badly');
        expect(complete.output).toContain('agent did the work');
    });

    it('keeps the heartbeat beating while the gates run', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        let beatsWhenRunnerResolved = 0;
        const runner = stubRunner(async () => {
            beatsWhenRunnerResolved = board.board.beats;
            // The gates take real time; a lease could expire under them.
            await new Promise((resolve) => setTimeout(resolve, 5));
            return ok();
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
        // settle() — the heartbeat's stop signal — waits until AFTER the gates have run, so the
        // lease is kept alive through a gate phase that can outlast it. (This is what stopped a
        // minutes-long suite from losing the lease mid-gates and double-running the job.)
        expect(board.board.beats).toBeGreaterThan(beatsWhenRunnerResolved);
    });

    it('releases the checkout fence when the gate environment fails to start', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        stack.gates.server.listen = async () => {
            throw new Error('EADDRNOTAVAIL');
        };
        const runner = stubRunner(async () => ok());
        const released: string[] = [];
        runner.releaseFence = async (j) => {
            released.push(j.id);
        };

        await drive({ ...board, runner, gates: stack.gates });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'runner_error' });
        expect(released).toEqual([gatedJob(1).id]);
    });

    it('reclaims the tree after a gate-environment failure once the thread is done, like every other refusal', async () => {
        const board = stubBoard([gatedJob(1)], { reclaimId: 'reclaim-1' });
        const stack = stubGateStack();
        stack.gates.server.listen = async () => {
            throw new Error('EADDRNOTAVAIL');
        };
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });
        for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(board.board.completed[0]).toMatchObject({ status: 'failed' });
        expect(runner.reclaimed.map((j) => j.id)).toEqual([gatedJob(1).id]);
    });

    it('releases the environment when registration fails after the container came up', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        // The endpoint cannot bind — the container, however, is already up.
        stack.gates.server.listen = async () => {
            throw new Error('EADDRNOTAVAIL');
        };
        const runner = stubRunner(async () => {
            throw new Error('the runner must never be reached');
        });

        await drive({ ...board, runner, gates: stack.gates });

        // The job fails with the reason — and the environment goes back to its cooldown instead
        // of leaking, one live container per failed claim until the driver restarts.
        expect(board.board.completed[0]).toMatchObject({ status: 'failed' });
        expect(board.board.completed[0]?.output).toContain('could not be started');
        expect(stack.stack.released).toEqual([`${gatedJob(1).id}/factory`]);
    });

    // The worktree (issue #35) is the checkout the gates share with the coding agent: the
    // environment is acquired, and every gate runs, in `<root id>/<repo segment>` —
    // the tree the run edits — never in the pristine clone. The acquire repeats before every
    // gate: the cooldown may have torn the environment down mid-run, and acquire is the revive.
    it('acquires the gate environment under the task worktree key', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        // One acquire in beginGates plus one per declared gate (2 in the fixture).
        expect(stack.stack.acquired).toEqual([
            `${gatedJob(1).id}/factory`,
            `${gatedJob(1).id}/factory`,
            `${gatedJob(1).id}/factory`,
        ]);
        expect(stack.stack.ran.key).toBe(`${gatedJob(1).id}/factory`);
    });

    it('registers the ad-hoc token and releases it, and never leaves it registered', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.registered).toBe(1);
        expect(stack.stack.unregistered).toBe(1);
        expect(stack.stack.advertised).toBe('http://host.docker.internal:9099');
    });

    // A gate that cannot RUN at all — the harness failed, docker exec refused — is a failed gate
    // with the reason, not a crash of the run and not a silent pass.
    it('fails the gate, not the run, when the gate itself cannot be executed', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        stack.gates.manager.runGate = async () => {
            throw Object.assign(new Error('Error response from daemon: No such container'), { code: 125 });
        };
        const runner = stubRunner(async () => ok({ output: 'agent did the work' }));

        await drive({ ...board, runner, gates: stack.gates });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', exitCode: 125 });
        expect(board.board.completed[0]?.output).toContain('No such container');
    });

    // The close-of-run gates re-acquire before each gate, exactly as the ad-hoc endpoint does: each
    // gate run files the attempt again with an env (a GitHub token) of its own, so an environment
    // forgotten mid-run can never fail a finished run at the finish line.
    it('re-acquires the gate environment before each gate, so an environment forgotten mid-run cannot fail the close-of-run gates', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        let up = true;
        const acquired: string[] = [];
        const ran: string[] = [];
        stack.gates.manager.acquire = async (key: string) => {
            up = true;
            acquired.push(key);
        };
        stack.gates.manager.runGate = async (key: string, name: string) => {
            if (!up) throw Object.assign(new Error(`no gate environment for ${key}`), { code: 125 });
            ran.push(name);
            return { exitCode: 0, output: `${name} ok` };
        };
        const key = `${gatedJob(1).id}/factory`;
        // The environment was forgotten while the agent kept working.
        const runner = stubRunner(async () => {
            up = false;
            return ok({ output: 'agent did the work' });
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
        expect(board.board.completed[0]?.output).not.toContain('no gate environment');
        expect(ran).toEqual(['test', 'lint']);
        expect(acquired).toEqual([key, key, key]);
    });

    // A gate's own `timeout:` (issue #576) reaches the manager in ms; an undeclared one stays undefined.
    it("hands each declared gate's timeout to the manager in ms", async () => {
        const timed: BoardJob = {
            ...gatedJob(1),
            gates: {
                image: 'node:24',
                gates: [
                    { name: 'test', command: 'npm test' },
                    { name: 'ui', command: 'npm run verify:ui', timeoutMinutes: 45 },
                ],
            },
        };
        const board = stubBoard([timed]);
        const stack = stubGateStack();
        const timeouts: (number | undefined)[] = [];
        stack.gates.manager.runGate = async (_key, name, _command, options) => {
            timeouts.push(options?.timeoutMs);
            return { exitCode: 0, output: `${name} ok` };
        };

        await drive({ ...board, runner: stubRunner(async () => ok({ output: 'done' })), gates: stack.gates });

        expect(timeouts).toEqual([undefined, 2_700_000]);
    });

    // An `on_demand` gate is the agent's to call ad hoc: registered with the token, never in the pass.
    it('skips an on-demand gate in the end-of-run pass, yet registers it for the ad-hoc channel', async () => {
        const onDemand: BoardJob = {
            ...gatedJob(1),
            gates: {
                image: 'node:24',
                gates: [
                    { name: 'test', command: 'npm test' },
                    { name: 'ui', command: 'npm run verify:ui', onDemand: true },
                ],
            },
        };
        const board = stubBoard([onDemand]);
        const stack = stubGateStack({ ui: 1 });
        const registered: string[][] = [];
        stack.gates.server.register = (_token, claim) => {
            registered.push(claim.gates.map((gate) => gate.name));
        };

        await drive({ ...board, runner: stubRunner(async () => ok({ output: 'done' })), gates: stack.gates });

        expect(registered).toEqual([['test', 'ui']]);
        expect(stack.stack.ran.names).toEqual(['test']);
        expect(board.board.gatesReported.at(-1)?.results.map((gate) => gate.name)).toEqual(['test']);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    // A gate that cannot run at all is a failed gate — an environment that cannot be re-acquired
    // at the gates pass is the same shape, never a silent pass and never a run crash.
    it('fails the gate, not the run, when the environment cannot be re-acquired at the gates pass', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        let acquires = 0;
        stack.gates.manager.acquire = async (_key: string) => {
            acquires += 1;
            if (acquires > 1) throw new Error('daemon unreachable');
        };
        const ran: string[] = [];
        stack.gates.manager.runGate = async (_key: string, name: string) => {
            ran.push(name);
            return { exitCode: 0, output: `${name} ok` };
        };
        const runner = stubRunner(async () => ok({ output: 'agent did the work' }));

        await drive({ ...board, runner, gates: stack.gates });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', exitCode: 125 });
        expect(board.board.completed[0]?.output).toContain('daemon unreachable');
        expect(ran).toEqual([]);
    });

    // The lease is checked BEFORE the re-acquire, but the heartbeat can mark it lost while the
    // acquire is still pending — a slow docker revival or cluster request outlives that beat. A
    // superseded attempt must not start its gate on a checkout another attempt owns.
    it('does not start the gate when the lease is lost while the environment is being re-acquired', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        let loseLease = false;
        board.board.heartbeat = async () => {
            board.board.beats += 1;
            return loseLease ? 'lost' : { result: 'held', cancelRequested: false };
        };
        const realGates = board.board.gates.bind(board.board);
        board.board.gates = async (claimed, results) => {
            // The gates pass opens with its first report; the lease is reclaimed from that moment.
            loseLease = true;
            return realGates(claimed, results);
        };
        let acquires = 0;
        stack.gates.manager.acquire = async () => {
            acquires += 1;
            if (acquires === 1) return; // beginGates, before the run — no re-acquire yet.
            // The revival is slow: the heartbeat's lost verdict lands while this is pending.
            await new Promise((resolve) => setTimeout(resolve, 5));
        };
        const ran: string[] = [];
        stack.gates.manager.runGate = async (_key: string, name: string) => {
            ran.push(name);
            return { exitCode: 0, output: `${name} ok` };
        };
        const runner = stubRunner(async () => ok({ output: 'agent did the work' }));

        await drive({ ...board, runner, gates: stack.gates });

        // The heartbeat did mark the lease lost while the re-acquire was pending — past the launch it kills nothing…
        expect(runner.killed).toEqual([]);
        // …and the gate never ran against the checkout the next attempt now owns — nor does a
        // verdict land: a lost lease settles the attempt the way a lost run does, unreported.
        expect(ran).toEqual([]);
        expect(board.board.completed).toHaveLength(0);
    });

    // The report must fit the board's body however many gates declared and however verbose they
    // were: the per-gate tail shrinks as the list grows.
    it('bounds the total reported gate output', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        stack.gates.manager.runGate = async (_key, _name) => ({
            exitCode: 0,
            output: 'x'.repeat(40_000),
        });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        const last = board.board.gatesReported.at(-1)!.results;
        expect(last).toHaveLength(2);
        for (const gate of last) {
            expect((gate.output ?? '').length).toBeLessThanOrEqual((16 * 1024) / 2);
        }
    });

    // The kubernetes executor has its own gate manager (a Job per gate run), so a gated job
    // runs and gates there exactly as it does under docker: the environment is acquired with
    // the attempt's job as context, every declared gate runs, and the verdict follows them.
    it('runs a gated job under the kubernetes executor like any other', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack({ test: 0, lint: 0 });
        let ran = 0;
        const runner = stubRunner(async () => {
            ran += 1;
            return ok();
        });

        await drive({ ...board, runner, gates: stack.gates }, { EXECUTOR: 'kubernetes' });

        expect(ran).toBe(1);
        expect(stack.stack.ran.names).toEqual(['test', 'lint']);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    // No gate stack configured (an operator who never asked for gates) but a repo declares them:
    // the same refusal, because running the task WITHOUT its gates and calling it success would
    // be exactly the lie the feature exists to stop.
    it('refuses gates when the driver has no gate stack at all', async () => {
        const board = stubBoard([gatedJob(1)]);
        let ran = 0;
        const runner = stubRunner(async () => {
            ran += 1;
            return ok();
        });

        await drive({ ...board, runner });

        expect(ran).toBe(0);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', exitCode: null });
    });

    /*
     * The declared services are what the gates test against — `.bellows.yaml` names `db` so that
     * `npm test` can reach it — so the fleet must outlive the run until the last gate has run.
     * Torn down inside run(), every service-backed gate failed on a name that no longer resolved.
     */
    it('keeps the services up through the declared gates and releases them after', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok());
        let gatesRunAtRelease: string[] | null = null;
        runner.releaseServices = async (released) => {
            gatesRunAtRelease = [...stack.stack.ran.names];
            runner.servicesReleased.push(released.id);
        };

        await drive({ ...board, runner, gates: stack.gates });

        expect(gatesRunAtRelease).toEqual(['test', 'lint']);
        expect(runner.servicesReleased).toEqual([gatedJob(1).id]);
    });

    it('releases the services on every way a run can end that does not retain its runner', async () => {
        const plain = stubRunner(async () => ok());
        await drive({ ...stubBoard([job(1)]), runner: plain });
        expect(plain.servicesReleased).toEqual([job(1).id]);

        const unstarted = stubRunner(async () => ok({ started: false }));
        await drive({ ...stubBoard([job(2)]), runner: unstarted });
        expect(unstarted.servicesReleased).toEqual([job(2).id]);

        const thrown = stubRunner(async () => {
            throw new Error('the daemon refused');
        });
        await drive({ ...stubBoard([job(3)]), runner: thrown });
        // A run that threw past its launch is left to the next claim to adopt, and its services with it.
        expect(thrown.servicesReleased).toEqual([]);
    });

    it('runs no gates for a never-started or a lost run', async () => {
        const unstartedBoard = stubBoard([gatedJob(2)]);
        const unstartedStack = stubGateStack();
        await drive({
            ...unstartedBoard,
            runner: stubRunner(async () => ok({ started: false })),
            gates: unstartedStack.gates,
        });
        expect(unstartedStack.stack.ran.names).toEqual([]);
        expect(unstartedBoard.board.completed).toEqual([]);

        const lostBoard = stubBoard([gatedJob(3)], { lease: 'lost' });
        const lostStack = stubGateStack();
        await drive({
            ...lostBoard,
            // Let the heartbeat land its verdict before the run ends, as the lost-lease test above
            // does — an instant run would finish before the first beat.
            runner: stubRunner(async () => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                return ok();
            }),
            gates: lostStack.gates,
        });
        expect(lostStack.stack.ran.names).toEqual([]);
    });

    // A refused start (a .bellows.yaml the parser rejects) is a final verdict with no agent
    // work behind it: gates over the untouched checkout would only bury the refusal under a
    // `vitest: not found` exit 127.
    it('runs no gates for a refused start, and reports the refusal alone', async () => {
        const board = stubBoard([gatedJob(4)]);
        const stack = stubGateStack();
        const refusal = '.bellows.yaml: unknown key "ports"';
        await drive({
            ...board,
            runner: stubRunner(async () => ok({ exitCode: null, output: refusal, refused: true })),
            gates: stack.gates,
        });
        expect(stack.stack.ran.names).toEqual([]);
        const complete = board.board.completed[0]!;
        expect(complete.status).toBe('failed');
        expect(complete.output).toBe(refusal);
    });

    // The minted session was reported before the runner spawned, but a refused start never ran
    // the agent, so no transcript exists under that id. Left on the row, a follow-up would inherit
    // it and `--resume` into "No conversation found".
    it('clears the session it minted when the start is refused', async () => {
        const board = stubBoard([gatedJob(4)]);
        let minted = '';
        await drive({
            ...board,
            runner: stubRunner(async (_job, session) => {
                minted = session!.id;
                return ok({ exitCode: null, output: '.bellows.yaml: unknown key "ports"', refused: true });
            }),
            gates: stubGateStack().gates,
        });
        expect(board.board.sessions).toEqual([
            { id: gatedJob(4).id, sessionId: minted },
            { id: gatedJob(4).id, sessionId: null },
        ]);
    });

    // A refused follow-up still owns its parent's conversation: the transcript exists, and the
    // next follow-up must be able to resume it.
    it('keeps a resumed session when the start is refused', async () => {
        const board = stubBoard([{ ...gatedJob(4), followUp: true, resumeSessionId: 'ses_parent' }]);
        await drive({
            ...board,
            runner: stubRunner(async () => ok({ exitCode: null, output: 'refused', refused: true })),
            gates: stubGateStack().gates,
        });
        expect(board.board.sessions).toEqual([]);
    });

    // An ordinary job must not pay for the feature: no container, no registration, no reports.
    it('never touches the gate stack for a job without gates', async () => {
        const board = stubBoard([job(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.acquired).toEqual([]);
        expect(stack.stack.registered).toBe(0);
        expect(stack.stack.released).toEqual([]);
        expect(board.board.gatesReported).toEqual([]);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });
});
