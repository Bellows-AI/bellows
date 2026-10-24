import { describe, expect, it, vitest } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import { ctlVolumeName } from '../../src/docker/docker-mailbox.js';
import { dockerArgs, opencodeSessionReadoutArgs } from '../../src/docker/docker.js';
import { TASK_MOUNT } from '../../src/task-volume.js';
import { claudeTurnsArgs, opencodeCacheProbeArgs } from '../../src/docker/docker-close-read.js';
import type { createDockerRunner } from '../../src/docker/docker-runner.js';
import {
    exporterCreateArgs,
    exporterName,
    gateCreateArgs,
    supervisorCreateArgs,
} from '../../src/docker/docker-group.js';
import { supervisorName } from '../../src/docker/docker-mailbox.js';
import { HELPER_TIMEOUT_MS, lookupHelper, type HelperPlan } from '../../src/helpers.js';
import { serviceRunArgs } from '../../src/services.js';
import type { RunnerFiles } from '../../src/docker/docker-runner-support.js';
import {
    createStepBroker,
    StepChannelClosed,
    stepLost,
    type StepSink,
    type SupervisorEndpoint,
} from '../../src/step-control.js';
import { REVIEW_REPLY_PROBE_ID } from '../../src/review/review-helpers.js';
import { receiptedAnswer, receiptOrder } from '../fixtures/helper-receipt-steps.js';
import { MAILBOXES, type StepRequest, type StepResult, type SupervisorReport } from '../../src/supervisor-contract.js';
import {
    BOARD,
    CONTROL_TOKEN,
    job,
    ok,
    FINALIZED,
    fakeSteps,
    syncSteps,
    emptyDaemon,
    SESSION,
    opencodeJob,
    START,
    entrypointAnswers,
    dockerRunner,
} from '../fixtures/docker-suite.js';

const RECLAIM_TOKEN = 'reclaim-control-token';

/** The endpoint a supervisor-only group is served on, recording the tokens it closed. */
function reclaimEndpoint() {
    const closed: string[] = [];
    const endpoint: SupervisorEndpoint = {
        open: async () => ({ url: 'http://driver:8130', token: RECLAIM_TOKEN }),
        close: (token) => {
            closed.push(token);
        },
    };
    return { endpoint, closed };
}

describe('the block-helper transport (issue #207)', () => {
    const NOOP_SCRIPT = lookupHelper('noop')!.scriptBody;
    const NOOP_VERDICT = JSON.stringify({ schema: 'helper-noop/v1', version: 1, ok: true, output: { echoed: true } });
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory', env: { GITHUB_TOKEN: 'claim-token' } };
    const plan = (over: Partial<HelperPlan> = {}): HelperPlan => ({
        helperId: 'noop',
        phase: 'pre',
        input: { a: 1 },
        githubWriting: false,
        ...over,
    });

    /** A runner whose supervisor answers each helper step with `answer`; the daemon's every argv is kept. */
    const helperRunner = (
        answer: (step: StepRequest) => StepResult | Promise<StepResult> = () => ok(NOOP_VERDICT),
        env: Record<string, string> = {}
    ) => {
        const docker: string[][] = [];
        const supervised = fakeSteps(answer);
        const exec = vitest.fn(async (args: string[]) => {
            docker.push(args);
            return { stdout: args[0] === 'wait' ? '0\n' : '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        return { docker, supervised, runner: dockerRunner(exec, { env, steps: supervised.sink }) };
    };

    // Issue #826: the same receipt bracket and the same loss rule as the kubernetes runner.
    it('brackets a receipted helper with its receipt in the task worktree, and throws a lost supervisor', async () => {
        // The receipt's MAC key: a driver without a board token keeps no receipt.
        const { supervised, runner } = helperRunner(receiptedAnswer, { JOB_BOARD_TOKEN: 'board-key' });
        await runner.runHelper(repoJob, plan({ helperId: REVIEW_REPLY_PROBE_ID, githubWriting: true }), {
            token: 'fresh-install-token',
            effectId: 'effect-1',
        });
        expect(receiptOrder(supervised.steps())).toEqual(['read', 'started', 'helper', 'done']);
        expect(supervised.steps()[0]!.env.LEDGER).toBe(`${TASK_MOUNT}/factory/.factory/helpers.json`);

        const lost = helperRunner(async () => {
            throw new StepChannelClosed('the helper');
        });
        await expect(lost.runner.runHelper(repoJob, plan())).rejects.toBeInstanceOf(StepChannelClosed);
    });

    it('fails an unknown helper id before any step is submitted', async () => {
        const { supervised, runner } = helperRunner();
        const result = await runner.runHelper(job, plan({ helperId: 'not-a-real-helper' }));
        expect(result).toEqual({
            ok: false,
            reason: 'unknown_helper',
            message: expect.stringContaining('not-a-real-helper'),
        });
        expect(supervised.steps()).toEqual([]);
    });

    // A group the daemon refuses is a failed helper in the daemon's own words, bounded — never a throw.
    it('fails a helper whose group the daemon refuses with the first 300 chars of its stderr', async () => {
        const stderr = `  Error response from daemon: ${'x'.repeat(400)}  \n`;
        const supervised = fakeSteps(() => ok(NOOP_VERDICT));
        const exec = (async (args: string[]) => {
            if (args[0] === 'create') throw Object.assign(new Error('Command failed: docker create'), { stderr });
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { steps: supervised.sink });

        const result = await runner.runHelper(repoJob, plan());

        expect(result).toEqual({ ok: false, reason: 'runner_error', message: stderr.trim().slice(0, 300) });
        expect(supervised.steps()).toEqual([]);
    });

    it('runs the noop helper end to end, as one supervised step with node and the script by content', async () => {
        const { docker, supervised, runner } = helperRunner();
        const result = await runner.runHelper(repoJob, plan());

        expect(result).toEqual({ ok: true, output: { echoed: true } });
        const [step] = supervised.ofKind('helper');
        // Submitted to the attempt's supervisor, under the token only it holds.
        expect(supervised.submitted.map((entry) => entry.token)).toEqual([CONTROL_TOKEN]);
        expect(step?.argv).toEqual(['node', '-e', NOOP_SCRIPT]);
        expect(step?.timeoutMs).toBe(HELPER_TIMEOUT_MS);
        // Each call is its own operation: a helper is never replayed from an earlier answer.
        expect(step?.id).toMatch(/^helper-[0-9a-f]{16}-/);
        // The task worktree, when the job names a repo — the same tree the agent run edits.
        expect(step?.cwd).toBe(`/task/factory`);
        // A read-only helper (githubWriting: false) gets its bounded input and nothing of the claim env.
        expect(step?.env).toEqual({ HELPER_INPUT: JSON.stringify({ a: 1 }) });
        // No container of its own: the daemon never saw the helper.
        expect(docker.some((a) => a[0] === 'run')).toBe(false);
    });

    it('maps a step the supervisor timed out to a named timeout failure', async () => {
        const { runner } = helperRunner(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
        const result = await runner.runHelper(job, plan());
        expect(result).toEqual({ ok: false, reason: 'timeout', message: expect.stringContaining('ms bound') });
    });

    it('hands the stand-down signal to the step, and a cancelled helper is no timeout (issue #488)', async () => {
        const controller = new AbortController();
        const seen: (AbortSignal | undefined)[] = [];
        const sink: StepSink = {
            submit: async (_token, _step, signal) => {
                seen.push(signal);
                controller.abort();
                throw new Error('step was cancelled');
            },
            awaitReport: () => Promise.resolve(FINALIZED),
            agentEnded: () => undefined,
            contacted: () => true,
            release: () => undefined,
            attach: () => undefined,
            cancel: () => undefined,
        };
        const runner = dockerRunner(emptyDaemon, { steps: sink });

        const result = await runner.runHelper(job, plan(), { signal: controller.signal });

        expect(seen).toEqual([controller.signal]);
        expect(result).toMatchObject({ ok: false, reason: 'runner_error' });
    });

    it('carries a fresh token in the step env, only for a github-writing helper', async () => {
        const { supervised, runner } = helperRunner();
        const result = await runner.runHelper(repoJob, plan({ githubWriting: true }), {
            token: 'fresh-install-token',
        });

        expect(result).toEqual({ ok: true, output: { echoed: true } });
        const [step] = supervised.ofKind('helper');
        // The minted token is the step's GitHub credential; a claim value under the name never is.
        expect(step?.env).toMatchObject({ GITHUB_TOKEN: 'fresh-install-token' });
        expect(JSON.stringify(step)).not.toContain('claim-token');
    });

    it('never puts the token in the daemon’s argv or the step’s — only in the step env', async () => {
        const { docker, supervised, runner } = helperRunner();
        await runner.runHelper(repoJob, plan({ githubWriting: true }), { token: 'super-secret-token' });
        expect(docker.flat().some((a) => a.includes('super-secret-token'))).toBe(false);
        const [step] = supervised.ofKind('helper');
        expect(step?.argv.some((a) => a.includes('super-secret-token'))).toBe(false);
        expect(step?.env.GITHUB_TOKEN).toBe('super-secret-token');
    });

    it('maps any other failure to runner_error, using the tool own output', async () => {
        const { runner } = helperRunner(() => ({
            exitCode: 1,
            stdout: '',
            stderr: 'permission denied while running the helper',
            timedOut: false,
        }));
        const result = await runner.runHelper(job, plan());
        expect(result).toEqual({
            ok: false,
            reason: 'runner_error',
            message: expect.stringContaining('permission denied'),
        });
    });

    it('runs a command-only job (no repo) at the member root, with no working directory', async () => {
        const { supervised, runner } = helperRunner();
        await runner.runHelper(job, plan());
        expect(supervised.ofKind('helper')[0]).not.toHaveProperty('cwd');
    });
});

/*
 * Issue #382, the docker half. Kubernetes is the primary executor, but a hardening that exists on
 * only one of them is a hardening an operator cannot reason about — and docker is the executor a
 * developer actually runs agent-written code under, on their own machine, against a daemon that
 * is root on it. Same two controls, spelled the way docker spells them:
 *
 *   --cap-drop ALL                      the kubernetes `capabilities.drop: [ALL]`
 *   --security-opt no-new-privileges    the kubernetes `allowPrivilegeEscalation: false`
 *
 * There is no seccomp twin to assert: the daemon applies its own default profile to every
 * container unless told otherwise, which is what `seccompProfile: RuntimeDefault` asks the kubelet
 * for. Adding a flag to restate it would be a flag that can only ever be wrong.
 *
 * Asserted as an ADJACENT ARGV PAIR, never as "contains the flag": `--cap-drop` separated from
 * `ALL` by an inserted argument is the exact bug a substring check reports as passing, and the
 * argv is built by concatenation in thirteen places.
 */
describe('every container the driver runs is hardened (#382)', () => {
    /** The flag and its value, as the pair docker reads them — index-adjacent or it is not set. */
    const hasPair = (argv: string[], flag: string, value: string): boolean =>
        argv.some((arg, i) => arg === flag && argv[i + 1] === value);

    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
    const config = () => loadDriverConfig({});
    const builders: [string, () => string[]][] = [
        ['the runner', () => dockerArgs(config(), job, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' })],
        ['the gate container', () => gateCreateArgs(config(), job, 'node:24')],
        ['the opencode session readout', () => opencodeSessionReadoutArgs(config(), opencodeJob, START)],
        ['the opencode cache probe', () => opencodeCacheProbeArgs(config(), opencodeJob)],
        ['the claude turns readout', () => claudeTurnsArgs(config(), job, SESSION, START)],
        [
            'the task supervisor',
            () => supervisorCreateArgs(config(), job, { exporting: true, agentless: false }, '/tmp/supervisor.env'),
        ],
        [
            'the task supervisor of an agentless group',
            () => supervisorCreateArgs(config(), repoJob, { exporting: false, agentless: true }, '/tmp/supervisor.env'),
        ],
        ['the claude transcript exporter', () => exporterCreateArgs(config(), job)],
        [
            'a declared service',
            () => serviceRunArgs(job, { name: 'cache', image: 'redis', environment: [] }, supervisorName(job), BOARD),
        ],
    ];

    it.each(builders)('drops every capability on %s', (_name, build) => {
        expect(hasPair(build(), '--cap-drop', 'ALL')).toBe(true);
    });

    // Issue #814: the runner starts as root to launch its tool broker, with exactly the two
    // capabilities a uid switch needs; factory-launch drops both before the CLI starts.
    it('starts the runner as root with SETUID and SETGID added, and nothing else', () => {
        const argv = builders[0]![1]();
        expect(hasPair(argv, '--user', '0:0')).toBe(true);
        expect(argv.flatMap((arg, i) => (arg === '--cap-add' ? [argv[i + 1]] : []))).toEqual(['SETUID', 'SETGID']);
    });

    it.each(builders.slice(1))('adds no capability to %s and never starts it as root', (_name, build) => {
        const argv = build();
        expect(argv).not.toContain('--cap-add');
        expect(hasPair(argv, '--user', '0:0')).toBe(false);
    });

    it.each(builders)('refuses privilege escalation on %s', (_name, build) => {
        expect(hasPair(build(), '--security-opt', 'no-new-privileges')).toBe(true);
    });

    /*
     * The paths that used to build a `docker run` argv INLINE — the publish
     * steps, the tree probe and the block helpers — now ask the task supervisor for a step instead
     * (#771). What they leave on the daemon is the group they ran in, so what is asserted is every
     * container THEY create (the supervisor of a group they open) and that none of them runs one
     * of its own: a new `docker run` site would land here unnoticed otherwise.
     *
     * Asserted through each path's own `execDocker` fake, so the argv checked is the argv the
     * daemon would have been handed.
     */
    const containersFrom = async (drive: (runner: ReturnType<typeof createDockerRunner>) => Promise<unknown>) => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            return { stdout: args[0] === 'wait' ? '0\n' : '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(
            exec,
            // A fake `files`: the group's control env file is a real file in os.tmpdir() under the
            // default, and an offline unit test has no business touching the filesystem.
            {
                files: { writeFile: async () => undefined, rm: async () => undefined } as unknown as RunnerFiles,
                endpoint: reclaimEndpoint().endpoint,
            }
        );
        await drive(runner).catch(() => undefined);
        return {
            created: calls.filter((a) => a[0] === 'create'),
            runs: calls.filter((a) => a[0] === 'run'),
        };
    };

    it.each([
        [
            'a block helper',
            (r: ReturnType<typeof createDockerRunner>) =>
                r.runHelper(job, { helperId: 'noop', phase: 'pre', input: { a: 1 }, githubWriting: false }),
        ],
        [
            'the publish path',
            (r: ReturnType<typeof createDockerRunner>) => r.publishGit({ ...job, repo: 'Bellows-AI/factory' }),
        ],
        [
            'the tree probe',
            (r: ReturnType<typeof createDockerRunner>) => r.probeTree({ ...job, repo: 'Bellows-AI/factory' }),
        ],
        [
            'the startup sync',
            (r: ReturnType<typeof createDockerRunner>) => r.syncCheckout({ ...job, repo: 'Bellows-AI/factory' }),
        ],
    ])('hardens every container %s creates or runs', async (_name, drive) => {
        const { created, runs } = await containersFrom(
            drive as (r: ReturnType<typeof createDockerRunner>) => Promise<unknown>
        );
        // The load-bearing guard: a path that created nothing would pass the loop below vacuously.
        expect(created.length).toBeGreaterThan(0);
        // A step runs in the supervisor, never in a container of its own.
        expect(runs).toHaveLength(0);
        for (const argv of [...created, ...runs]) {
            expect(hasPair(argv, '--cap-drop', 'ALL')).toBe(true);
            expect(hasPair(argv, '--security-opt', 'no-new-privileges')).toBe(true);
        }
    });

    // A service has no opt-out: a stock image that needs root at boot declares its own uid:gid,
    // and every capability stays dropped.
    it('runs a declared service as its declared uid:gid, still hardened', () => {
        const argv = serviceRunArgs(
            job,
            {
                name: 'db',
                image: 'postgres:17',
                environment: [],
                user: { uid: 999, gid: 999 },
            },
            supervisorName(job),
            BOARD
        );
        expect(hasPair(argv, '--user', '999:999')).toBe(true);
        expect(hasPair(argv, '--cap-drop', 'ALL')).toBe(true);
        expect(hasPair(argv, '--security-opt', 'no-new-privileges')).toBe(true);
        expect(argv.indexOf('--user')).toBeLessThan(argv.indexOf('postgres:17'));
    });

    it('passes no --user to a service that declared none', () => {
        expect(
            serviceRunArgs(job, { name: 'db', image: 'postgres:17', environment: [] }, supervisorName(job), BOARD)
        ).not.toContain('--user');
    });
});

/*
 * Issue #823: a group whose supervisor is gone — it exited without a report the driver took, or a
 * kill took the group away — leaves nothing to answer a step. Its channel is released, so the
 * probe and `finish` the loop still sends fail at once instead of waiting out each step's timeout
 * and the answer grace, three times over.
 */
describe('a group whose supervisor is gone releases its step channel', () => {
    const exited = (args: string[]) => {
        if (args[0] === 'inspect') return Promise.reject(new Error('Error: No such object'));
        return Promise.resolve({ stdout: args[0] === 'wait' ? '0\n' : '' });
    };
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };

    it('releases the channel when the run sees the supervisor exit with no report taken', async () => {
        const supervised = fakeSteps(() => ok(), new Promise<SupervisorReport>(() => undefined));
        await dockerRunner(exited, { steps: supervised.sink }).run(job, { id: SESSION, resume: false });
        expect(supervised.released).toEqual([CONTROL_TOKEN]);
    });

    it('keeps the channel of a supervisor that reported and serves on', async () => {
        const supervised = fakeSteps();
        await dockerRunner(exited, { steps: supervised.sink }).run(job, { id: SESSION, resume: false });
        expect(supervised.released).toEqual([]);
    });

    it('releases the channel when a stop finds the supervisor already exited', async () => {
        const supervised = fakeSteps();
        await dockerRunner(exited, { steps: supervised.sink }).stopAgent(job);
        expect(supervised.released).toEqual([CONTROL_TOKEN]);
    });

    it('fails a step in flight at once when a kill takes the group away', async () => {
        const broker = createStepBroker();
        broker.open(CONTROL_TOKEN);
        // The supervisor is stood in by this test's own pulls, repeated as a real one's are: a pull
        // before the group is made again is lost with the old slot, and the group's wait has to see one.
        const pull = async () => {
            for (;;) {
                const next = await broker.next(CONTROL_TOKEN, 20, new AbortController().signal);
                if (next) return next;
            }
        };
        const runner = dockerRunner(emptyDaemon, {
            steps: broker,
            sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
        });
        const probing = runner.probeTree(repoJob);
        expect(await pull()).toMatchObject({ kind: 'probe' });
        await runner.kill(repoJob);
        expect(await probing).toBeNull();
    });

    it('ends the first-contact wait at once when a kill lands while the group is being made', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let gated = false;
        const exec = async (args: string[]) => {
            // The first call that makes or starts the group is held; the kill lands behind it.
            if (!gated && (args[0] === 'create' || args[0] === 'run' || args[0] === 'start')) {
                gated = true;
                await gate;
            }
            return { stdout: '' };
        };
        let sleeps = 0;
        const runner = dockerRunner(exec as never, {
            steps: createStepBroker(),
            sleep: async () => {
                sleeps += 1;
            },
        });
        const probing = runner.probeTree(repoJob);
        while (!gated) await new Promise((resolve) => setTimeout(resolve, 1));
        await runner.kill(repoJob);
        const sleptBeforeRelease = sleeps;
        release();
        await expect(probing).rejects.toThrow(/killed while (setting up services|its task group came up)/);
        expect(sleeps - sleptBeforeRelease).toBeLessThanOrEqual(2);
    });

    it('creates no group for a lease its driver killed, for the sync or any later step', async () => {
        const calls: string[][] = [];
        const exec = async (args: string[]) => {
            calls.push(args);
            return { stdout: '' };
        };
        const runner = dockerRunner(exec as never, { steps: createStepBroker() });
        await runner.kill(repoJob);
        const killedAt = calls.length;
        await expect(runner.probeTree(repoJob)).rejects.toThrow(/killed while setting up services/);
        await expect(runner.syncCheckout(repoJob)).rejects.toThrow(/killed while setting up services/);
        expect(calls.slice(killedAt).filter((args) => ['create', 'run', 'start'].includes(args[0] ?? ''))).toEqual([]);
    });
});

/**
 * Issue #967: a gate in flight waits on the supervisor's answer, and the supervisor container is the
 * only thing that says it is gone once the agent has reported. It is watched for the group's whole
 * life; a confirmed end releases the steps, an unconfirmed read never does.
 */
describe('a step in flight when the supervisor container ends under a reporting group (#967)', () => {
    const WATCH_MS = 10;
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
    const GATE = { command: 'npm test', cwd: '/task/factory', env: {}, timeoutMs: 600_000 };
    const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const lostWithin = async (gating: Promise<unknown>, ms = 3_000): Promise<'lost' | 'hung' | 'other'> =>
        Promise.race([
            gating.then(
                () => 'other' as const,
                (e: unknown) => (stepLost(e) ? ('lost' as const) : ('other' as const))
            ),
            settle(ms).then(() => 'hung' as const),
        ]);
    const RUNNING = '{"Status":"running","Running":true}\n';

    /** A daemon answering `inspect` by container name: the supervisor's answer is scripted, anything else is absent. */
    function daemon(script: { supervisor: () => string | Error }) {
        const inspected: string[] = [];
        const exec = async (args: string[]) => {
            if (args[0] === 'inspect') {
                const name = args[args.length - 1] ?? '';
                if (name !== supervisorName(repoJob)) throw new Error('Error: No such object: ' + name);
                inspected.push(name);
                const answer = script.supervisor();
                if (answer instanceof Error) throw answer;
                return { stdout: answer };
            }
            return { stdout: args[0] === 'wait' ? '0\n' : '' };
        };
        return { exec: exec as unknown as (args: string[]) => Promise<{ stdout: string }>, inspected };
    }

    /** The supervisor holds every gate unanswered; the group is made on demand, or by a run that reported. */
    async function gateHeld(script: { supervisor: () => string | Error }, reported = true) {
        const broker = createStepBroker();
        broker.open(CONTROL_TOKEN);
        const released = vitest.spyOn(broker, 'release');
        let serving = true;
        let gated = false;
        const loop = (async () => {
            while (serving) {
                const step = await broker.next(CONTROL_TOKEN, 20, new AbortController().signal);
                if (!step || step === 'closed') continue;
                if (step.kind === 'gate') gated = true;
                else broker.settle(CONTROL_TOKEN, step.id, step.invocation, ok());
                // The agent is released by `go` and reports once it is gone.
                if (step.kind === 'go') broker.report(CONTROL_TOKEN, FINALIZED);
            }
        })();
        const d = daemon(script);
        const runner = dockerRunner(d.exec, {
            steps: broker,
            groupWatchMs: WATCH_MS,
            sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
        });
        if (reported) {
            await runner.run(repoJob, { id: SESSION, resume: false });
        }
        const gating = runner.runGate(repoJob, GATE);
        gating.catch(() => undefined);
        while (!gated) await settle(5);
        return {
            runner,
            gating,
            inspected: d.inspected,
            released,
            stop: async () => {
                await runner.kill(repoJob).catch(() => undefined);
                serving = false;
                await loop;
            },
        };
    }

    it.each([
        ['exits', () => '{"Status":"exited","ExitCode":137}\n'],
        ['is dead', () => '{"Status":"dead"}\n'],
    ])('fails a gate in flight at once when the supervisor container %s after the report', async (_n, ended) => {
        const script = { supervisor: (): string | Error => RUNNING };
        const held = await gateHeld(script);
        try {
            script.supervisor = ended;
            expect(await lostWithin(held.gating)).toBe('lost');
        } finally {
            await held.stop();
        }
    });

    it('fails a gate in flight at once when the supervisor container is removed', async () => {
        const script = { supervisor: (): string | Error => RUNNING };
        const held = await gateHeld(script);
        try {
            script.supervisor = () => new Error('Error: No such object: ' + supervisorName(repoJob));
            expect(await lostWithin(held.gating)).toBe('lost');
        } finally {
            await held.stop();
        }
    });

    it("fails a supervisor-only group's gate at once when its supervisor container exits", async () => {
        const script = { supervisor: (): string | Error => RUNNING };
        const held = await gateHeld(script, false);
        try {
            script.supervisor = () => '{"Status":"exited"}\n';
            expect(await lostWithin(held.gating)).toBe('lost');
        } finally {
            await held.stop();
        }
    });

    it.each([
        ['a daemon error', () => new Error('Cannot connect to the Docker daemon')],
        ['a timeout', () => Object.assign(new Error('timed out'), { killed: true })],
        ['garbage stdout', () => 'not json'],
        ['empty stdout', () => ''],
        ['null', () => 'null\n'],
        ['a paused container', () => '{"Status":"paused"}\n'],
        ['a restarting container', () => '{"Status":"restarting"}\n'],
    ])('never fails a waiting gate on an unconfirmed inspect: %s', async (_n, unread) => {
        const script = { supervisor: (): string | Error => RUNNING };
        const held = await gateHeld(script);
        try {
            const before = held.inspected.length;
            script.supervisor = unread;
            await settle(WATCH_MS * 20);
            expect(held.inspected.length).toBeGreaterThan(before + 3);
            expect(await lostWithin(held.gating, 50)).toBe('hung');
            script.supervisor = () => '{"Status":"exited"}\n';
            expect(await lostWithin(held.gating)).toBe('lost');
        } finally {
            await held.stop();
        }
    });

    /** Reads stop growing and a later confirmed end releases nothing: the group is no longer this watch's. */
    async function stopsWatching(
        held: Awaited<ReturnType<typeof gateHeld>>,
        script: { supervisor: () => string | Error }
    ) {
        await settle(WATCH_MS * 3);
        const after = held.inspected.length;
        const released = held.released.mock.calls.length;
        script.supervisor = () => new Error('Error: No such object: ' + supervisorName(repoJob));
        await settle(WATCH_MS * 20);
        expect(held.inspected.length).toBe(after);
        expect(held.released.mock.calls.length).toBe(released);
    }

    it('stops watching, and releases nothing, once the group is killed', async () => {
        const script = { supervisor: (): string | Error => RUNNING };
        const held = await gateHeld(script);
        try {
            await held.runner.kill(repoJob);
            await stopsWatching(held, script);
        } finally {
            await held.stop();
        }
    });

    it('stops watching, and releases nothing, once the group is finished', async () => {
        const script = { supervisor: (): string | Error => RUNNING };
        const held = await gateHeld(script);
        try {
            await held.runner.finish(repoJob);
            await stopsWatching(held, script);
        } finally {
            await held.stop();
        }
    });

    it('stops watching, and releases nothing, once the attempt is abandoned to the next holder', async () => {
        const script = { supervisor: (): string | Error => RUNNING };
        const held = await gateHeld(script);
        try {
            held.runner.abandon(repoJob);
            await stopsWatching(held, script);
            expect(await lostWithin(held.gating, 50)).toBe('hung');
        } finally {
            await held.stop();
        }
    });
});

/*
 * Issue #821 D16: a kill takes the group out of the runner's memory, and the `finish` that follows
 * must still remove what the kill only stopped — the supervisor, the exporter and the four
 * mailboxes — by this attempt's own names, without waiting on a supervisor the kill already ended.
 */
describe('a kill followed by finish removes the group (#821 D16)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };

    it('removes the supervisor, the exporter and every mailbox volume, by the killed attempt names', async () => {
        const { exec, calls } = entrypointAnswers('');
        const runner = dockerRunner(exec, { steps: syncSteps().sink });
        expect((await runner.syncCheckout(repoJob)).ok).toBe(true);
        await runner.kill(repoJob);
        const killedAt = calls.length;

        await runner.finish(repoJob);

        const after = calls.slice(killedAt);
        expect(after).toContainEqual(['rm', '-f', supervisorName(repoJob)]);
        expect(after).toContainEqual(['rm', '-f', exporterName(repoJob)]);
        for (const box of Object.values(MAILBOXES)) {
            expect(after).toContainEqual(['volume', 'rm', '-f', ctlVolumeName(repoJob, box)]);
        }
        // The kill already ended the group: nothing waits on its supervisor again.
        expect(after.filter((args) => args[0] === 'wait')).toEqual([]);
        // Attempt-scoped: every removal names this attempt, never a newer lease of the same job.
        const newer = '55555555-5555-4555-8555-555555555555';
        expect(after.flat().some((arg) => arg.includes(newer))).toBe(false);
        for (const args of after.filter((a) => a[0] === 'rm' || (a[0] === 'volume' && a[1] === 'rm'))) {
            expect(args[args.length - 1]).toContain(repoJob.leaseToken);
        }
    });
});

/*
 * Issue #805: a supervisor that already exited answers `docker wait` at once. Its exit is no sign
 * the agent ended — nobody is left to deliver the kill order — so the stop hard-kills the agent
 * still running, and only the agent: the supervisor's loss stays the close path's to record.
 */
describe('stopping an agent whose supervisor already exited (#805)', () => {
    const daemon = (supervisorExit: string, agentPs: string, refuses: (args: string[]) => boolean = () => false) => {
        const calls: string[][] = [];
        const exec = (args: string[]) => {
            calls.push(args);
            if (refuses(args)) return Promise.reject(new Error('the daemon answered 503'));
            if (args[0] === 'wait') return Promise.resolve({ stdout: `${supervisorExit}\n` });
            if (args[0] === 'ps' && args.includes('label=factory.role=agent'))
                return Promise.resolve({ stdout: agentPs });
            // The whole group's listing; the service teardown's own listing finds no services.
            if (args[0] === 'ps' && !args.includes('label=factory.service'))
                return Promise.resolve({ stdout: 'a1a1a1a1a1a1\na2a2a2a2a2a2\na3a3a3a3a3a3\n' });
            return Promise.resolve({ stdout: '' });
        };
        return { exec, calls };
    };
    const kills = (calls: string[][]) => calls.filter((args) => args[0] === 'kill');

    it('hard-kills the still-running agent, and only it, when the supervisor exited non-zero', async () => {
        const { exec, calls } = daemon('70', 'a1a1a1a1a1a1\n');

        await dockerRunner(exec).stopAgent(job);

        expect(kills(calls)).toEqual([['kill', 'a1a1a1a1a1a1']]);
        const listed = calls.find((args) => args[0] === 'ps' && args.includes('label=factory.role=agent'));
        expect(listed).toEqual(
            expect.arrayContaining([`label=factory.job=${job.id}`, `label=factory.lease=${job.leaseToken}`])
        );
    });

    it('kills nothing when the supervisor finalized and the agent is gone', async () => {
        const { exec, calls } = daemon('0', '');

        await dockerRunner(exec).stopAgent(job);

        expect(kills(calls)).toEqual([]);
    });

    // Never throws, like the kubernetes twin: a lookup the daemon refused falls back to the hard kill.
    it('falls back to the hard kill of the whole group when the agent lookup fails', async () => {
        const { exec, calls } = daemon('70', 'a1a1a1a1a1a1\n', (args) => args.includes('label=factory.role=agent'));

        await dockerRunner(exec).stopAgent(job);

        expect(kills(calls)).toEqual([
            ['kill', 'a1a1a1a1a1a1'],
            ['kill', 'a2a2a2a2a2a2'],
            ['kill', 'a3a3a3a3a3a3'],
        ]);
    });

    // #828: a kill that fails (the agent exited between the listing and the kill, or the daemon
    // refused once) is tried again, never answered with a removal: the exited container is the run
    // the next claim adopts, and only end() removes it.
    it('tries a failed kill again and never removes the agent', async () => {
        const { exec, calls } = daemon('70', 'a1a1a1a1a1a1\n', (args) => args[0] === 'kill');

        await dockerRunner(exec).stopAgent(job);

        expect(kills(calls)).toEqual([
            ['kill', 'a1a1a1a1a1a1'],
            ['kill', 'a1a1a1a1a1a1'],
        ]);
        expect(calls.filter((args) => args[0] === 'rm')).toEqual([]);
    });
});
