import { describe, expect, it, vitest } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import type { spawn } from 'node:child_process';
import { loadDriverConfig } from '../../src/config.js';
import { containerName, parseDockerServicePs, parseDockerStats } from '../../src/docker/docker.js';
import { withTaskVolume } from '../fixtures/task-volume-daemon.js';
import { StartupRefused } from '../../src/startup-cause.js';
import { currentActivity, stripAnsi } from '../../src/runner.js';
import { ARTIFACT_LIMIT, Inconclusive, SERVICE_LOG_TAIL_LINES } from '../../src/runner.js';
import { createDockerRunner } from '../../src/docker/docker-runner.js';
import { supervisorName } from '../../src/docker/docker-mailbox.js';
import type { RunnerFiles } from '../../src/docker/docker-runner-support.js';
import { telemetryConfig, telemetryConfigTar } from '../../src/telemetry-config.js';
import {
    job,
    fakeSteps,
    SESSION,
    opencodeJob,
    fakeChild,
    chunkedChild,
    CUT_SHORT,
    splitEuro,
    SPLIT_EURO_CASES,
    expectWholeEuro,
    spawnChild,
    dockerRunner,
} from '../fixtures/docker-suite.js';

/** One `docker ps --format '{{json .}}'` line for a service container, the fields the parse reads. */
const psLine = (service: { name: string; image: string; state: string }): string =>
    `${JSON.stringify({
        Command: '"sleep"',
        CreatedAt: '2026-09-14T10:00:00.000Z',
        ID: `id-${service.name}`,
        Image: service.image,
        Labels: `factory.job=${job.id},factory.lease=${job.leaseToken},factory.service=${service.name}`,
        Names: `factory-job-${job.id}-${job.leaseToken}-svc-${service.name}`,
        State: service.state,
        Status: `${service.state} (a minute ago)`,
    })}\n`;

describe('the docker runner', () => {
    // The daemon is stood in by `execDocker`, so the suite never shells out: the fence and the
    // cleanup `rm` answer empty, and the `inspect` that classifies a 125 close is scripted per
    // test. The fake child carries whatever the run itself printed.
    const noContainer = (args: string[]) => {
        if (args[0] === 'inspect') throw new Error('Error: No such object');
        // The task supervisor finalized: the group's `wait` answers its exit status.
        return Promise.resolve({ stdout: args[0] === 'wait' ? '0\n' : '' });
    };

    it('reads a daemon refusal as a container that never started', async () => {
        // The run printed the daemon's error — and so would a command that echoed it. The
        // classifier does not read this stream at all: the daemon says no container exists.
        const runner = dockerRunner(noContainer, {
            spawn: spawnChild(
                '',
                'docker: Error response from daemon: Conflict. The container name is already in use\n',
                125
            ),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: false });
    });

    it('starts no runner on a task volume the reaper deleted since the group was made: a transient refusal, no empty volume (issue #775)', async () => {
        let inspects = 0;
        const calls: string[][] = [];
        const exec = (args: string[]) => {
            calls.push(args);
            // The ensure and the group's guard find the volume; the runner's guard finds it gone.
            if (args[0] === 'volume' && args[1] === 'inspect' && args[2] === '--format' && ++inspects > 2) {
                throw Object.assign(new Error('inspect failed'), { stderr: 'Error: No such volume: x' });
            }
            return withTaskVolume(noContainer)(args);
        };
        const spawnFn = vitest.fn(() => fakeChild('', '', 0));
        const runner = createDockerRunner(
            loadDriverConfig({ RUNNER_SERVICES: '0' }),
            spawnFn as unknown as typeof spawn,
            exec,
            {
                steps: fakeSteps().sink,
                sleep: async () => {},
            }
        );
        const refused = await runner.run(job, { id: SESSION, resume: false }).catch((e: unknown) => e);

        expect(refused).toBeInstanceOf(StartupRefused);
        expect((refused as StartupRefused).startupCause).toBe('transient');
        expect(calls.some((args) => args[0] === 'create' && args.includes(containerName(job)))).toBe(false);
        expect(spawnFn).not.toHaveBeenCalled();
    });

    // Issue #452: the runner is created, handed its managed settings as a root-owned 0444
    // archive, and only then started attached. Nothing inside the container — which runs as the
    // agent's uid — ever writes the file.
    it('creates a claude-code runner, copies its rendered managed settings in, then starts it attached', async () => {
        const calls: { args: string[]; input?: Buffer }[] = [];
        const exec = (args: string[], options?: { input?: Buffer }) => {
            calls.push({ args, ...(options?.input ? { input: options.input } : {}) });
            return noContainer(args);
        };
        const spawnFn = vitest.fn(() => fakeChild('', '', 0));
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0', RUNNER_OTEL_ENDPOINT: 'http://otel.example:4318' },
            spawn: spawnFn as unknown as typeof spawn,
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const verbs = calls.map((call) => call.args[0]);
        // The supervisor's group is created first; the agent's own create is the one that names it.
        const create = calls.find((call) => call.args[0] === 'create' && call.args.includes(containerName(job)));
        expect(create).toBeDefined();
        expect(calls.findIndex((call) => call.args.includes(supervisorName(job)))).toBeLessThan(calls.indexOf(create!));
        const cp = calls.find((call) => call.args[0] === 'cp');
        expect(cp?.args).toEqual(['cp', '-', `${containerName(job)}:/etc`]);
        expect(cp?.input?.equals(telemetryConfigTar(telemetryConfig('claude-code', 'http://otel.example:4318')))).toBe(
            true
        );
        expect(verbs.indexOf('create')).toBeLessThan(verbs.indexOf('cp'));
        expect(spawnFn.mock.calls).toEqual([['docker', ['start', '-a', containerName(job)], expect.anything()]]);
    });

    it('copies the rendered otel.json into an opencode runner, where its plugin is pointed', async () => {
        const calls: { args: string[]; input?: Buffer }[] = [];
        const exec = (args: string[], options?: { input?: Buffer }) => {
            calls.push({ args, ...(options?.input ? { input: options.input } : {}) });
            return noContainer(args);
        };
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0', RUNNER_OTEL_ENDPOINT: 'http://otel.example:4318' },
        });
        await runner.run(opencodeJob, null);
        const cp = calls.find((call) => call.args[0] === 'cp');
        expect(cp?.args).toEqual(['cp', '-', `${containerName(opencodeJob)}:/etc`]);
        expect(cp?.input?.equals(telemetryConfigTar(telemetryConfig('opencode', 'http://otel.example:4318')))).toBe(
            true
        );
    });

    // The exited runner container is the evidence a replacement claim adopts a finished run from
    // (`exitedRunners`): the close reads its verdict and leaves it; only the attempt's end removes it.
    it('leaves the exited runner container for the attempt end, not the verdict read (#828)', async () => {
        const calls: string[][] = [];
        const exec = (args: string[]) => {
            calls.push(args);
            return noContainer(args);
        };
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild('done\n', '', 0) });

        expect(await runner.run(job, { id: SESSION, resume: false })).toMatchObject({ exitCode: 0, started: true });
        expect(calls).not.toContainEqual(['rm', '-f', containerName(job)]);

        await runner.finish(job);
        expect(calls).toContainEqual(['rm', '-f', containerName(job)]);
    });

    // The daemon refusing the create (a name conflict, a missing image) or the copy is what a
    // refused `docker run` was: a container that never started, nothing spawned, the leftover
    // removed, and the daemon's own words in the output.
    it.each(['create', 'cp'])('reads a refused %s as a container that never started', async (verb) => {
        const calls: string[][] = [];
        const exec = (args: string[]) => {
            calls.push(args);
            if (args[0] === verb && (verb !== 'create' || args.includes(containerName(job)))) {
                return Promise.reject(
                    Object.assign(new Error('Command failed'), { stderr: 'Error response from daemon: Conflict\n' })
                );
            }
            return noContainer(args);
        };
        const spawnFn = vitest.fn(() => fakeChild('', '', 0));
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnFn as unknown as typeof spawn });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: false });
        expect(outcome.output).toContain('Error response from daemon: Conflict');
        expect(spawnFn).not.toHaveBeenCalled();
        expect(calls).toContainEqual(['rm', '-f', containerName(job)]);
    });

    // `docker start -a` exits 1 — not run's 125 — when the runtime cannot start the process
    // (a bad mount, a missing binary). The daemon still holds the container as `created`: never
    // started, so the attempt is left to its lease rather than reported as a failed run.
    it('reads a start the runtime refused as a container that never started', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.resolve({ stdout: '{"Status":"created","ExitCode":0}\n' })
                : Promise.resolve({ stdout: '' });
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', 'Error response from daemon: failed to create task for container\n', 1),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 1, started: false });
        // The runtime's words prove no cause: the never-started recovery stands (#824 D11).
        expect(outcome).not.toHaveProperty('startupCause');
    });

    // Issue #824 D11: a container the daemon confirms never started carries the cause its refusal
    // proves, for the loop's one startup decision — on a refused create and a refused attached start
    // alike. A container that ran is a verdict whatever it printed.
    it('stamps the cause a refused agent create proves', async () => {
        const exec = (args: string[]) =>
            args[0] === 'create' && args.includes(containerName(job))
                ? Promise.reject(
                      Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), {
                          stderr: 'Error response from daemon: manifest for claude-executor:latest not found: manifest unknown\n',
                      })
                  )
                : noContainer(args);
        const outcome = await dockerRunner(exec, { env: { RUNNER_SERVICES: '0' } }).run(job, {
            id: SESSION,
            resume: false,
        });
        expect(outcome).toMatchObject({ exitCode: 125, started: false, startupCause: 'image' });
    });

    it('stamps the cause a refused attached start proves', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.resolve({ stdout: '{"Status":"created","ExitCode":0}\n' })
                : Promise.resolve({ stdout: '' });
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild(
                '',
                'Error response from daemon: Get "https://registry/v2/": net/http: TLS handshake timeout\n',
                1
            ),
        });
        expect(await runner.run(job, { id: SESSION, resume: false })).toMatchObject({
            started: false,
            startupCause: 'transient',
        });
    });

    // An inspect that could not answer proves no container never ran: what printed may be the agent's
    // own words, so the never-started recovery stands unclassified (Codex r1, class B).
    it('stamps no cause when the daemon could not say the container never ran', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.reject(
                      Object.assign(new Error('Command failed: docker inspect'), {
                          stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
                      })
                  )
                : Promise.resolve({ stdout: args[0] === 'wait' ? '0\n' : '' });
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', 'Error response from daemon: manifest unknown\n', 125),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: false });
        expect(outcome).not.toHaveProperty('startupCause');
    });

    // A start the daemon refused, proven, ran no agent: no report can come, so the refusal is decided
    // before the supervisor's wind-down and no supervisor loss rides on it (Codex r1, class C).
    it('decides a proven start refusal before the supervisor wait, with no loss beside it', async () => {
        const calls: string[][] = [];
        const exec = (args: string[]) => {
            calls.push(args);
            if (args[0] === 'inspect') return Promise.resolve({ stdout: '{"Status":"created","ExitCode":0}\n' });
            // A supervisor that ended without finalizing, had it been waited for.
            return Promise.resolve({ stdout: args[0] === 'wait' ? '70\n' : '' });
        };
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', 'Error response from daemon: invalid mount config for type "bind"\n', 1),
            steps: fakeSteps(undefined, new Promise<never>(() => undefined)).sink,
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ started: false, startupCause: 'config' });
        expect(outcome).not.toHaveProperty('infraLoss');
        expect(calls.some((args) => args[0] === 'wait')).toBe(false);
    });

    // A status alone is no proof a container never ran: one that started and is now `dead` closes
    // 125 too, and what it printed is the agent's own (Codex r2, class B).
    it('reads a container with a start time as one that ran, whatever its status', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.resolve({ stdout: '{"Status":"dead","StartedAt":"2026-10-01T00:00:00Z","ExitCode":125}\n' })
                : Promise.resolve({ stdout: args[0] === 'wait' ? '0\n' : '' });
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', 'unauthorized: authentication required\n', 125),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: true });
        expect(outcome).not.toHaveProperty('startupCause');
    });

    // The refusal proven before the wait is the verdict's: the daemon is not asked again, so a later
    // inspect that cannot answer never turns the refused start into a run that failed (Codex r2, class C).
    it('keeps the proven refusal for the verdict, asking the daemon once', async () => {
        let inspects = 0;
        const exec = (args: string[]) => {
            if (args[0] !== 'inspect') return Promise.resolve({ stdout: '' });
            inspects += 1;
            return inspects === 1
                ? Promise.resolve({ stdout: '{"Status":"created","StartedAt":"0001-01-01T00:00:00Z"}\n' })
                : Promise.reject(new Error('daemon unreachable'));
        };
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', 'Error response from daemon: invalid mount config for type "bind"\n', 1),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 1, started: false, startupCause: 'config' });
        expect(inspects).toBe(1);
    });

    it('stamps no cause on a run that started, whatever it printed', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.resolve({ stdout: '{"Status":"exited","ExitCode":1}\n' })
                : Promise.resolve({ stdout: '' });
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', 'Error response from daemon: manifest unknown\n', 1),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 1, started: true });
        expect(outcome).not.toHaveProperty('startupCause');
    });

    it('still reads a run that exited non-zero as a verdict', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.resolve({ stdout: '{"Status":"exited","ExitCode":1}\n' })
                : Promise.resolve({ stdout: '' });
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild('', 'boom\n', 1) });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 1, started: true });
    });

    // A runner container removed under the run (issue #560) — `docker rm -f` by hand, a host
    // cleanup — exits the attached start 137, but the agent never ended it: the driver's own kill
    // only kills, so a container the daemon no longer knows is an infrastructure loss.
    it('reads a runner container removed mid-run as an infrastructure loss', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.reject(
                      Object.assign(new Error('Command failed'), {
                          stderr: `Error: No such object: ${containerName(job)}\n`,
                      })
                  )
                : Promise.resolve({ stdout: '' });
        // The supervisor never finalized: a finalizing report would leave nothing for the removal to explain.
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', '', 137),
            steps: fakeSteps(undefined, new Promise<never>(() => undefined)).sink,
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({
            exitCode: 137,
            started: true,
            infraLoss: 'the runner container was removed before it exited (exit 137)',
        });
    });

    // An agent that died before it wrote agent.exit (#920) leaves its supervisor waiting out the start or heartbeat
    // window: the supervisor cannot see the container, so the driver names it once the daemon confirms it over.
    describe.each([
        ['exited', '{"Status":"exited","Running":false,"StartedAt":"2026-01-01T00:00:00Z","ExitCode":1}', true],
        ['dead', '{"Status":"dead","Running":false,"StartedAt":"2026-01-01T00:00:00Z","ExitCode":1}', true],
        ['still running', '{"Status":"running","Running":true,"StartedAt":"2026-01-01T00:00:00Z"}', false],
        ['unparsable', 'not json', false],
    ])('a runner container the daemon reports %s', (_state, inspected, told) => {
        it(`${told ? 'tells' : 'never tells'} the supervisor the agent ended`, async () => {
            const exec = (args: string[]) =>
                args[0] === 'inspect' && args.at(-1) === containerName(job)
                    ? Promise.resolve({ stdout: inspected })
                    : Promise.resolve({ stdout: '' });
            const steps = fakeSteps(undefined, new Promise<never>(() => undefined));
            const ended: string[] = [];
            steps.sink.agentEnded = (token) => void ended.push(token);
            const runner = dockerRunner(exec, {
                env: { RUNNER_SERVICES: '0' },
                spawn: spawnChild('', '', 1),
                steps: steps.sink,
            });
            await runner.run(job, { id: SESSION, resume: false });
            expect(ended).toEqual(told ? ['supervisor-control-token'] : []);
        });
    });

    it('tells the supervisor at once about an attached start that exited 0, without asking the daemon', async () => {
        const inspects: string[][] = [];
        const exec = (args: string[]) => {
            if (args[0] === 'inspect') inspects.push(args);
            return Promise.resolve({ stdout: '' });
        };
        const steps = fakeSteps(undefined, new Promise<never>(() => undefined));
        const ended: string[] = [];
        steps.sink.agentEnded = (token) => void ended.push(token);
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, steps: steps.sink });
        await runner.run(job, { id: SESSION, resume: false });
        expect(ended).toEqual(['supervisor-control-token']);
        expect(inspects.filter((args) => args.at(-1) === containerName(job))).toEqual([]);
    });

    it('never tells the supervisor the agent ended when the daemon cannot answer', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect' ? Promise.reject(new Error('daemon timed out')) : Promise.resolve({ stdout: '' });
        const steps = fakeSteps(undefined, new Promise<never>(() => undefined));
        const ended: string[] = [];
        steps.sink.agentEnded = (token) => void ended.push(token);
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', '', 1),
            steps: steps.sink,
        });
        await runner.run(job, { id: SESSION, resume: false });
        expect(ended).toEqual([]);
    });

    // A run the platform took away has no container left to read: no throwaway `docker run` runs.
    it.each([
        ['claude-code with a session', job],
        ['opencode', opencodeJob],
    ])('issues no close-time read for a %s run the platform took away', async (_name, lostJob) => {
        const runs: string[][] = [];
        const exec = (args: string[]) => {
            if (args[0] === 'run') runs.push(args);
            return args[0] === 'inspect'
                ? Promise.reject(
                      Object.assign(new Error('Command failed'), {
                          stderr: `Error: No such object: ${containerName(lostJob)}\n`,
                      })
                  )
                : Promise.resolve({ stdout: '' });
        };
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', '', 137),
            steps: fakeSteps(undefined, new Promise<never>(() => undefined)).sink,
        });
        const outcome = await runner.run(lostJob, lostJob === job ? { id: SESSION, resume: false } : null);
        expect(outcome.infraLoss).toBeDefined();
        expect(runs).toEqual([]);
    });

    it('reads an inspect that fails for any other reason as no loss', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.reject(new Error('daemon unreachable'))
                : Promise.resolve({ stdout: args[0] === 'wait' ? '0\n' : '' });
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild('', '', 1) });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 1, started: true });
        expect(outcome).not.toHaveProperty('infraLoss');
    });

    // The full-log accumulator (issue #325): everything the stream printed, tail-kept at the
    // artifact cap — the artifact the loop uploads at close, of which the verdict's rolling tail
    // is only the end. The refused-start path carries neither.
    it('carries the full log on the outcome, capped tail-true, beside the unchanged report tail', async () => {
        // Past the artifact cap (512 KiB), so the accumulator really has to cut.
        const fullOutput = `${'head\n'.repeat(20)}${'body line\n'.repeat(60_000)}`;
        const runner = dockerRunner(noContainer, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild(fullOutput, '', 0),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        // The full log is the whole stream tail-kept at the cap: its last line survives, its
        // head was cut, and the flag says so.
        expect(outcome.logTruncated).toBe(true);
        expect(outcome.fullLog?.endsWith('body line\n')).toBe(true);
        expect(Buffer.byteLength(outcome.fullLog ?? '')).toBeLessThanOrEqual(ARTIFACT_LIMIT);
        // The rolling tail is unchanged: still the report's 16 KiB window.
        expect(outcome.output.length).toBeLessThanOrEqual(16 * 1024);
        expect(outcome.output.endsWith('body line\n')).toBe(true);
    });

    it('keeps the full log byte-true under the cap when the run never exceeded it', async () => {
        const fullOutput = 'short run\n';
        const runner = dockerRunner(noContainer, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild(fullOutput, '', 0),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome.fullLog).toBe('short run\n');
        expect(outcome.logTruncated).toBe(false);
    });

    it('calls a log of exactly ARTIFACT_LIMIT bytes complete, and one byte more truncated (#825)', async () => {
        for (const [size, truncated] of [
            [ARTIFACT_LIMIT, false],
            [ARTIFACT_LIMIT + 1, true],
        ] as const) {
            const runner = dockerRunner(noContainer, {
                env: { RUNNER_SERVICES: '0' },
                spawn: spawnChild('x'.repeat(size), '', 0),
            });
            const outcome = await runner.run(job, { id: SESSION, resume: false });
            expect(outcome.logTruncated).toBe(truncated);
            expect(Buffer.byteLength(outcome.fullLog ?? '')).toBe(ARTIFACT_LIMIT);
        }
    });

    it('keeps the bytes of a stream that ended inside a character, never drops them (#825)', async () => {
        const runner = dockerRunner(noContainer, {
            env: { RUNNER_SERVICES: '0' },
            spawn: (() => chunkedChild(CUT_SHORT)) as unknown as typeof spawn,
        });

        const outcome = await runner.run(job, { id: SESSION, resume: false });

        expect(outcome.fullLog).toBe('ok\uFFFD');
        expect(outcome.logTruncated).toBe(false);
    });

    it('decodes a multibyte character split across two stream chunks once, whole — below and above the cap (#825)', async () => {
        for (const [body, truncated] of SPLIT_EURO_CASES) {
            const runner = dockerRunner(noContainer, {
                env: { RUNNER_SERVICES: '0' },
                spawn: (() => chunkedChild(splitEuro(body))) as unknown as typeof spawn,
            });

            expectWholeEuro(await runner.run(job, { id: SESSION, resume: false }), truncated);
        }
    });

    // The security constraint the issue states (docs/security.md): forwarded env secrets must
    // not leak into the stored artifacts. The full log is the child's own stream and NOTHING
    // else — pinned by strict equality, so any driver-side injection on the artifact path (the
    // env file's values included) would break it.
    it('makes the full log exactly the stream — no claim env value can enter the artifact', async () => {
        const stdout = 'plain run output\nwith a second line\n';
        const runner = dockerRunner(noContainer, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild(stdout, '', 0) });
        const outcome = await runner.run(
            { ...job, env: { SENTINEL_SECRET: 'shh-do-not-store' } },
            { id: SESSION, resume: false }
        );
        expect(outcome.fullLog).toBe(stdout);
        expect(outcome.fullLog).not.toContain('shh-do-not-store');
    });

    it('reads a container that ran and exited 125 as a verdict, not an infrastructure refusal', async () => {
        // The exact case a stderr signature gets wrong: the command prints `docker: ` itself —
        // an agent reproducing an error, say — and exits 125. The daemon saw the container run
        // and exit, so `started` is true and the code is reported as the command's verdict.
        const inspect = vitest.fn((args: string[]) =>
            args[0] === 'inspect'
                ? Promise.resolve({ stdout: '{"Status":"exited","ExitCode":125}\n' })
                : Promise.resolve({ stdout: '' })
        );
        const runner = dockerRunner(inspect as unknown as (args: string[]) => Promise<{ stdout: string }>, {
            spawn: spawnChild('work done\n', 'reproduced: docker: Error response from daemon: Conflict\n', 125),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: true });
        expect(inspect).toHaveBeenCalled();
    });

    it('never asks the daemon about a run whose exit code is unambiguous', async () => {
        const inspect = vitest.fn((_args: string[]) => Promise.resolve({ stdout: '' }));
        const runner = dockerRunner(inspect as unknown as (args: string[]) => Promise<{ stdout: string }>, {
            spawn: spawnChild('done\n', '', 0),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        // The fence and the cleanup `rm` go through the same seam; only the inspect is the
        // classifier, and an unambiguous exit code must not pay for one.
        expect(inspect.mock.calls.filter((call) => call[0][0] === 'inspect')).toHaveLength(0);
    });

    it('spawns docker with the claim env in a file, and its own environment untouched', async () => {
        // The values reach the container through the --env-file, so the docker CLI's own
        // environment stays the operator's — a member-configured PATH or DOCKER_* can never steer
        // the CLI this driver executes.
        const spawnFn = vitest.fn((_cmd: string, _argv: string[], _options?: object) => fakeChild('', '', 0));
        let create: string[] = [];
        const exec = (args: string[]) => {
            if (args[0] === 'create' && args.includes(containerName(job))) create = args;
            return noContainer(args);
        };
        const runner = dockerRunner(exec, { spawn: spawnFn as unknown as typeof spawn });
        const outcome = await runner.run({ ...job, env: { MY_TOKEN: 'board-secret' } }, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0 });
        const [cmd, argv, options] = spawnFn.mock.calls[0]!;
        expect(cmd).toBe('docker');
        const fileArg = create[create.indexOf('--env-file') + 1];
        expect(create).toContain('--env-file');
        expect(fileArg).toBeTruthy();
        // The file existed and carried the value while the CLI ran; it is gone once the run is.
        expect(existsSync(fileArg!)).toBe(false);
        // The CLI's environment is inherited, never merged with claim values.
        expect(options && 'env' in options).toBe(false);
        expect([...create, ...(argv as string[])].some((arg) => arg.includes('board-secret'))).toBe(false);
    });

    /**
     * The live-output hook: every chunk that arrives is handed to the caller as the newest tail —
     * the same string a complete report would carry, growing. One call per chunk; throttling is
     * the loop's business.
     */
    it('hands every chunk it reads to the output stream', async () => {
        const tails: string[] = [];
        const runner = dockerRunner(noContainer, { spawn: spawnChild('step one\n', 'warn\n', 0) });

        const outcome = await runner.run(job, { id: SESSION, resume: false }, (tail) => tails.push(tail));

        expect(outcome.exitCode).toBe(0);
        expect(tails).toEqual(['step one\n', 'step one\nwarn\n']);
    });

    /**
     * The vitals sample goes through the same daemon seam as everything else, named by this
     * attempt's lease token — a sample can only ever resolve its own attempt's runner. A daemon
     * that refuses (the container exited between the ask and the read) is null, never a throw:
     * a missed sample costs freshness, not the run.
     */
    it('samples the runner container vitals through the daemon seam', async () => {
        const exec = vitest.fn((args: string[]) => {
            if (args[0] === 'stats') {
                expect(args.slice(1, 4)).toEqual(['--no-stream', '--format', '{{json .}}']);
                expect(args[4]).toBe(containerName(job));
                return Promise.resolve({
                    stdout: '{"CPUPerc":"93.00%","MemPerc":"7.02%","MemUsage":"544MiB / 7.754GiB","Name":"x"}\n',
                });
            }
            // The fleet read answers nothing here: the pin is the vitals shape alone.
            expect(args[0]).toBe('ps');
            return Promise.resolve({ stdout: '' });
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild('done\n', '', 0) });

        await expect(runner.sampleRuntime(job)).resolves.toEqual({
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7.02,
        });
    });

    /**
     * The attempt's service fleet rides the same sample (issue #60): the dashboard can answer
     * "did db come up" while the run is going. The read is scoped by the job AND lease label —
     * the attempt-scoping every other per-attempt call leans on — and requires the
     * `factory.service` key, so the runner and gate containers never answer it. `-a` so exited
     * containers report: "did it come up and die" is exactly the honest answer wanted here.
     */
    it('samples the service fleet beside the vitals', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn((args: string[]) => {
            calls.push(args);
            if (args[0] === 'stats') {
                return Promise.resolve({
                    stdout: '{"CPUPerc":"93.00%","MemPerc":"7.02%","MemUsage":"544MiB / 7.754GiB","Name":"x"}\n',
                });
            }
            expect(args[0]).toBe('ps');
            return Promise.resolve({
                stdout:
                    psLine({ name: 'db', image: 'postgres:16', state: 'running' }) +
                    psLine({ name: 'cache', image: 'redis:7', state: 'exited' }),
            });
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild('done\n', '', 0) });

        await expect(runner.sampleRuntime(job)).resolves.toEqual({
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7.02,
            services: [
                { name: 'cache', image: 'redis:7', state: 'exited' },
                { name: 'db', image: 'postgres:16', state: 'running' },
            ],
        });
        const ps = calls.find((args) => args[0] === 'ps')!;
        expect(ps).toContain('-a');
        expect(ps).toContain(`label=factory.job=${job.id}`);
        expect(ps).toContain(`label=factory.lease=${job.leaseToken}`);
        expect(ps).toContain('label=factory.service');
    });

    /**
     * Each half of the sample stands on its own: a fleet read that fails costs the fleet, not the
     * vitals — and never the sample; unreadable vitals must not silence the fleet (null numbers,
     * real states); and only when both reads fail is the sample null.
     */
    const STATS = '{"CPUPerc":"93.00%","MemUsage":"544MiB / 7.754GiB","MemPerc":"7.02%"}';
    const refused = new Error('daemon refused');
    it.each<[string, string | Error, string | Error, unknown]>([
        [
            'keeps the vitals when the service read fails',
            STATS,
            refused,
            { cpuPercent: 93, memUsedMb: 544, memPercent: 7.02 },
        ],
        [
            'reports the service fleet even when the vitals read fails',
            refused,
            psLine({ name: 'db', image: 'postgres:16', state: 'running' }),
            {
                cpuPercent: null,
                memUsedMb: null,
                memPercent: null,
                services: [{ name: 'db', image: 'postgres:16', state: 'running' }],
            },
        ],
        ['answers null when the vitals sample cannot be taken', refused, refused, null],
    ])('%s', async (_label, stats, ps, expected) => {
        const answer = (value: string | Error) =>
            value instanceof Error ? Promise.reject(value) : Promise.resolve({ stdout: value });
        const exec = vitest.fn((args: string[]) => answer(args[0] === 'stats' ? stats : ps)) as unknown as (
            args: string[]
        ) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild('done\n', '', 0) });

        await expect(runner.sampleRuntime(job)).resolves.toEqual(expected);
    });

    /** Services off: the sample is exactly what it was before services were sampled. */
    it('does not ask the daemon about services when they are off', async () => {
        const commands: string[] = [];
        const exec = vitest.fn((args: string[]) => {
            commands.push(args[0]!);
            return Promise.resolve({ stdout: '{"CPUPerc":"93.00%","MemUsage":"544MiB / 7.754GiB","MemPerc":"7.02%"}' });
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild('done\n', '', 0) });

        await expect(runner.sampleRuntime(job)).resolves.toEqual({
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7.02,
        });
        expect(commands).toEqual(['stats']);
    });

    /**
     * The dead half of the fleet (issue #423): an exited or dead service, with the daemon's exit
     * code and reason and the container's last log lines — stdout and stderr both, because an
     * entrypoint's `chown` refusal lands on stderr. Read over the sample's own label scoping; a
     * running service is never inspected.
     */
    it('reads each dead service with its exit, reason and log tail', async () => {
        const calls: string[][] = [];
        const mongo = `factory-job-${job.id}-${job.leaseToken}-svc-mongo`;
        const exec = vitest.fn((args: string[]) => {
            calls.push(args);
            if (args[0] === 'ps') {
                return Promise.resolve({
                    stdout:
                        psLine({ name: 'mongo', image: 'mongo:8', state: 'exited' }) +
                        psLine({ name: 'cache', image: 'redis:7', state: 'dead' }) +
                        psLine({ name: 'db', image: 'postgres:16', state: 'running' }),
                });
            }
            if (args[0] === 'inspect') {
                return Promise.resolve({
                    stdout:
                        args.at(-1) === mongo
                            ? '{"ExitCode":1,"OOMKilled":false,"Error":""}\n'
                            : '{"ExitCode":137,"OOMKilled":true,"Error":""}\n',
                });
            }
            expect(args.slice(0, 3)).toEqual(['logs', '--tail', String(SERVICE_LOG_TAIL_LINES)]);
            return Promise.resolve(
                args.at(-1) === mongo
                    ? { stdout: 'starting\n', stderr: 'chown: Operation not permitted\n' }
                    : { stdout: '' }
            );
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild('done\n', '', 0) });

        await expect(runner.deadServices(job)).resolves.toEqual([
            { name: 'cache', image: 'redis:7', state: 'dead', exitCode: 137, reason: 'OOMKilled', logTail: '' },
            {
                name: 'mongo',
                image: 'mongo:8',
                state: 'exited',
                exitCode: 1,
                reason: null,
                logTail: 'starting\nchown: Operation not permitted\n',
            },
        ]);
        const ps = calls.find((args) => args[0] === 'ps')!;
        expect(ps).toContain('-a');
        expect(ps).toContain(`label=factory.job=${job.id}`);
        expect(ps).toContain(`label=factory.lease=${job.leaseToken}`);
        expect(ps).toContain('label=factory.service');
        expect(calls.some((args) => args.at(-1)?.endsWith('-svc-db'))).toBe(false);
    });

    it('keeps a dead service whose inspect fails, and throws on an unreadable fleet', async () => {
        const fleet = vitest.fn((args: string[]) =>
            args[0] === 'ps'
                ? Promise.resolve({ stdout: psLine({ name: 'mongo', image: 'mongo:8', state: 'exited' }) })
                : Promise.reject(new Error('No such container'))
        ) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        await expect(dockerRunner(fleet, { spawn: spawnChild('done\n', '', 0) }).deadServices(job)).resolves.toEqual([
            { name: 'mongo', image: 'mongo:8', state: 'exited', exitCode: null, reason: null, logTail: '' },
        ]);

        const refused = vitest.fn(() => Promise.reject(new Error('daemon refused'))) as unknown as (
            args: string[]
        ) => Promise<{ stdout: string }>;
        await expect(dockerRunner(refused, { spawn: spawnChild('done\n', '', 0) }).deadServices(job)).rejects.toThrow(
            'daemon refused'
        );
    });

    it('rejects Inconclusive when the fleet listing has a malformed row', async () => {
        const garbage = vitest.fn(() => Promise.resolve({ stdout: '<html>\n' })) as unknown as (
            args: string[]
        ) => Promise<{ stdout: string }>;
        await expect(
            dockerRunner(garbage, { spawn: spawnChild('done\n', '', 0) }).deadServices(job)
        ).rejects.toBeInstanceOf(Inconclusive);
    });

    it('answers no dead services without asking the daemon when services are off', async () => {
        const exec = vitest.fn(() => Promise.resolve({ stdout: '' }));
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild('done\n', '', 0) });

        await expect(runner.deadServices(job)).resolves.toEqual([]);
        expect(exec).not.toHaveBeenCalled();
    });

    describe('parseDockerStats', () => {
        // The stats fields are display strings; the parse is worth its own pin.
        it('reads the JSON line the daemon prints', () => {
            expect(parseDockerStats('{"CPUPerc":"93.00%","MemUsage":"544MiB / 7.754GiB","MemPerc":"7.02%"}')).toEqual({
                cpuPercent: 93,
                memUsedMb: 544,
                memPercent: 7.02,
            });
        });

        it('converts every memory unit to MiB, binary and decimal spellings alike', () => {
            expect(parseDockerStats('{"CPUPerc":"0.00%","MemUsage":"1.5GiB / 8GiB"}')).toMatchObject({
                memUsedMb: 1536,
            });
            expect(parseDockerStats('{"CPUPerc":"0.00%","MemUsage":"512KiB / 8GiB"}')).toMatchObject({
                memUsedMb: 0.5,
            });
            expect(parseDockerStats('{"CPUPerc":"0.00%","MemUsage":"2000kB / 8GiB"}')).toMatchObject({
                memUsedMb: 2,
            });
        });

        it('takes null for a percentage the daemon did not report, and null for garbage', () => {
            expect(parseDockerStats('{"CPUPerc":"93.00%","MemUsage":"544MiB / 7.754GiB"}')).toMatchObject({
                memPercent: null,
            });
            expect(parseDockerStats('')).toBeNull();
            expect(parseDockerStats('not json')).toBeNull();
            expect(parseDockerStats('{"MemUsage":"544MiB / 7.754GiB"}')).toBeNull();
            expect(parseDockerStats('{"CPUPerc":"93.00%","MemUsage":"? / 8GiB"}')).toBeNull();
        });

        it('takes null for a null last line, and for valid JSON followed by a non-JSON last line', () => {
            expect(parseDockerStats('null')).toBeNull();
            expect(parseDockerStats('{"CPUPerc":"93.00%","MemUsage":"544MiB / 7.754GiB"}\nnoise')).toBeNull();
        });
    });

    describe('parseDockerServicePs', () => {
        it('reads name, image and state off one ps line', () => {
            expect(parseDockerServicePs(psLine({ name: 'db', image: 'postgres:16', state: 'running' }))).toEqual([
                { name: 'db', image: 'postgres:16', state: 'running' },
            ]);
        });

        it('reads every line, sorted by name', () => {
            const out = parseDockerServicePs(
                `${psLine({ name: 'db', image: 'postgres:16', state: 'running' })}${psLine({ name: 'cache', image: 'redis:7', state: 'exited' })}`
            );
            expect(out).toEqual([
                { name: 'cache', image: 'redis:7', state: 'exited' },
                { name: 'db', image: 'postgres:16', state: 'running' },
            ]);
        });

        it('answers null when any row lacks the service label, an image or a state, or is not a record', () => {
            const good = psLine({ name: 'db', image: 'postgres:16', state: 'running' });
            const unlabeled = good.replace(/factory\.service=db,?/, '');
            expect(parseDockerServicePs(unlabeled)).toBeNull();
            expect(parseDockerServicePs(`${good}<html>\n`)).toBeNull();
            expect(parseDockerServicePs(`${good}not json\n`)).toBeNull();
            expect(parseDockerServicePs(`${good}[]\n`)).toBeNull();
            expect(parseDockerServicePs(`${good}${psLine({ name: 'ok', image: '', state: 'running' })}`)).toBeNull();
            expect(parseDockerServicePs(`${good}${psLine({ name: 'ok2', image: 'redis:7', state: '' })}`)).toBeNull();
        });

        it('answers empty for empty output', () => {
            expect(parseDockerServicePs('')).toEqual([]);
            expect(parseDockerServicePs('\n\n')).toEqual([]);
        });
    });

    describe('currentActivity', () => {
        // The activity line is the stream's last non-empty line with its escapes stripped — the
        // tool call most of the time. A heuristic on purpose: the stream is the CLI's to format.
        it('strips ANSI escapes and takes the last non-empty line', () => {
            expect(currentActivity('$ npm test\n\x1b[32m→ Read src/x.ts\x1b[0m\n')).toBe('→ Read src/x.ts');
            expect(currentActivity('one\n\n  \ntwo')).toBe('two');
        });

        it('caps the line and takes null for a tail that says nothing', () => {
            expect(currentActivity('x'.repeat(500))!.length).toBe(200);
            expect(currentActivity(null)).toBeNull();
            expect(currentActivity('\n\n')).toBeNull();
            expect(stripAnsi('\x1b]0;title\x07after')).toBe('after');
        });
    });

    // A gated job whose claim resolves to no variables still needs the minted gate credentials:
    // keyed on the claim alone, the file would not exist and the runner could never call a gate.
    it('writes the gate credentials into the env file of a job whose claim env is empty', async () => {
        let fileBody: string | null = null;
        let create: string[] = [];
        const exec = (args: string[]) => {
            // Read at create time, through the argv: what the CLI could see is what counts.
            if (args[0] === 'create' && args.includes(containerName(job))) {
                create = args;
                fileBody = readFileSync(args[args.indexOf('--env-file') + 1]!, 'utf8');
            }
            return noContainer(args);
        };
        const runner = dockerRunner(exec);

        const outcome = await runner.run(
            { ...job, gateEnv: { BELLOWS_GATE_URL: 'http://host.docker.internal:9099', BELLOWS_GATE_TOKEN: 'tok' } },
            { id: SESSION, resume: false }
        );

        expect(outcome).toMatchObject({ exitCode: 0 });
        expect(create).toContain('--env-file');
        expect(fileBody).toBe(
            'BELLOWS_GATE_URL=http://host.docker.internal:9099\nBELLOWS_GATE_TOKEN=tok\n' +
                `RUNNER_JOB_ID=${job.id}\nRUNNER_LEASE_TOKEN=${job.leaseToken}\n`
        );
    });

    // The lease lost DURING the env-file write: the kill-check just above the write has already
    // passed, and the write's await breaks the synchronous gap the setup promises. Without one
    // more check, the runner spawns over a dead lease — its job-derived container name colliding
    // with the replacement's. On that abort the just-written file must go too: the cleanup around
    // the outcome only covers a settled run, and this throw precedes it.
    //
    // The env-file write is INJECTED here (the constructor's `files` seam) rather than observed
    // through a node:fs/promises mock: under isolate:false that mock only binds when docker.js
    // first executes in a worker, and a copy cached by scripts.test.ts's import once bypassed
    // this park entirely — the run completed, and the test waited on a write that never came.
    it('spawns nothing when the lease is lost during the env-file write, and leaves no file behind', async () => {
        let releaseWrite: (() => void) | null = null;
        const writeReleased = new Promise<void>((resolve) => {
            releaseWrite = resolve;
        });
        let markWrite: (() => void) | null = null;
        const writeUnderway = new Promise<void>((resolve) => {
            markWrite = resolve;
        });
        let writtenTo: string | null = null;
        const files: RunnerFiles = {
            writeFile: async (path, data, options) => {
                writtenTo = String(path);
                markWrite!();
                await writeReleased;
                return writeFile(path, data, options);
            },
            rm,
        };

        const spawnSpy = vitest.fn(() => fakeChild('', '', 0));
        const runner = dockerRunner(noContainer, { spawn: spawnSpy as unknown as typeof spawn, files: files });

        const pending = runner.run({ ...job, env: { MY_TOKEN: 'board-secret' } }, { id: SESSION, resume: false });
        await writeUnderway; // the run is parked inside the env-file write

        await runner.kill(job); // the lease dies while the write is pending
        releaseWrite!(); // the write lands; the run now learns its lease is gone

        await expect(pending).rejects.toThrow(/killed while (setting up services|its task group came up)/);
        expect(spawnSpy).not.toHaveBeenCalled();
        // No leak: the file the write just created is removed on the abort path.
        expect(writtenTo).toBeTruthy();
        expect(existsSync(writtenTo!)).toBe(false);
    });

    // Issue #452 split the launch into create → cp → start, and the create and the copy are
    // awaits too: a lease lost behind them must not reach the start. The created container is
    // this attempt's own leftover, removed by name, and the env file goes with it.
    it('starts nothing when the lease is lost during the create, and leaves no container or file behind', async () => {
        const calls: string[][] = [];
        let envFile: string | null = null;
        let runner: ReturnType<typeof createDockerRunner> | null = null;
        const exec = async (args: string[]) => {
            calls.push(args);
            if (args[0] === 'create' && args.includes(containerName(job))) {
                envFile = args[args.indexOf('--env-file') + 1]!;
                await runner!.kill(job); // the lease dies while the create is pending
            }
            return noContainer(args);
        };
        const spawnSpy = vitest.fn(() => fakeChild('', '', 0));
        runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnSpy as unknown as typeof spawn });

        await expect(runner.run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /killed while setting up services/
        );
        expect(spawnSpy).not.toHaveBeenCalled();
        expect(calls).toContainEqual(['rm', '-f', containerName(job)]);
        expect(envFile).toBeTruthy();
        expect(existsSync(envFile!)).toBe(false);
    });
});
