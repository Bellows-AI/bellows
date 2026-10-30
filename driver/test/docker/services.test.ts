import { afterEach, describe, expect, it, vitest } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { BoardJob } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import { containerName, dockerArgs, envFilePath } from '../../src/docker/docker.js';
import { withTaskVolume } from '../fixtures/task-volume-daemon.js';
import { SERVICE_RESTART_TIMEOUT_MS } from '../../src/runner.js';
import { createDockerRunner } from '../../src/docker/docker-runner.js';
import { ATTEMPT_COMMAND_TIMEOUT_MS } from '../../src/docker/docker-runner-support.js';
import { exporterName } from '../../src/docker/docker-group.js';
import { supervisorName } from '../../src/docker/docker-mailbox.js';
import { forgetDeclaredServices, type ServiceSpec, serviceContainerName, serviceRunArgs } from '../../src/services.js';
import { startJobServices } from '../../src/docker/docker-runner-support.js';
import { ServicesNotRunning } from '../../src/service-restart.js';
import {
    BOARD,
    job,
    hangsUntilAborted,
    hangsUntilTimeout,
    endsSoon,
    memoryFiles,
    fakeSteps,
    SESSION,
    isServiceRun,
    labelDaemon,
    dockerRunner,
} from '../fixtures/docker-suite.js';

/**
 * A stateful daemon: containers live in a map keyed by id/name with their labels, `ps` honors
 * `--filter label=` pairs, and `rm -f` removes exactly what it is told. Service containers and
 * every `docker create` register
 * through the exec seam, so cross-attempt "B is untouched" assertions are state, not argv. The
 * throwaway `run … --entrypoint` container answers `readout` (default: the sync's success
 * verdict). `fail`, when given, turns the matching call into an execFile-shaped rejection —
 * stderr on the error, the way the promisified execFile carries a daemon refusal.
 */
/**
 * The readiness wait's `docker ps --format '{{json .}}'` answer: every service container the
 * daemon was asked to run (`--network-alias`, labelled `factory.service`), running.
 */
function runningServicesPs(calls: readonly string[][]): { stdout: string } {
    const names = calls
        .filter((a) => isServiceRun(a))
        .flatMap((a) => a.filter((arg) => arg.startsWith('factory.service=')));
    return {
        stdout: names.map((label) => JSON.stringify({ Labels: label, Image: 'svc:1', State: 'running' })).join('\n'),
    };
}

/**
 * A `ps` answer naming one container: the fence's `--format` listing renders each id beside its
 * lease label — an older attempt's, as every container of a job carries one — a bare `-q`/`-aq`
 * listing the id alone.
 */
const psListing = (args: string[], id: string): string =>
    args.includes('--format') ? `${id}\taaaaaaaa-1111-4111-8111-aaaaaaaaaaaa\n` : `${id}\n`;

/** The suite's job with no services on the claim, for the block below that shadows `job`. */
const baseJob = job;

/*
 * Auxiliary services (issue #6, resolved at claim time by issue #769). The switch is on in this
 * whole block, and the daemon is scripted on argv shape: the service runs (they carry
 * --network-alias) answer created, the label `ps` answers one container id, and everything else
 * succeeds empty. The spawn stands in for the runner container itself and records the argv it was
 * given. The services ride on the claim: this block's `job` declares the one `stub` service.
 */
describe('auxiliary services (RUNNER_SERVICES)', () => {
    const STUB: ServiceSpec = { name: 'stub', image: 'stub-svc:1', environment: [] };
    // A repo, as every claim that carries services has: the loop's sync creates the group first.
    const job: BoardJob = { ...baseJob, repo: 'Bellows-AI/bellows', services: [STUB] };
    // The declared fleet is process-wide and the suite runs isolate: false — a failed test must not leak it.
    afterEach(() => forgetDeclaredServices(job));
    /** A restart's stand-down signal that never fires. */
    const live = new AbortController().signal;

    const daemon = (opts: { serviceFails?: boolean } = {}) =>
        vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) {
                if (opts.serviceFails) throw new Error('daemon refused the service');
                return { stdout: '' };
            }
            // The readiness wait's listing: the declared stub, running.
            if (args[0] === 'ps' && args.includes('{{json .}}')) {
                return {
                    stdout: JSON.stringify({ Labels: 'factory.service=stub', Image: 'stub-svc:1', State: 'running' }),
                };
            }
            // The attempt's own service: what the fence's lease-labelled listing shows for it.
            if (args[0] === 'ps')
                return { stdout: args.includes('--format') ? `c0ffee000001\t${job.leaseToken}\n` : 'c0ffee000001\n' };
            // The task supervisor finalized: the group's `wait` answers its exit status.
            if (args[0] === 'wait') return { stdout: '0\n' };
            return { stdout: '' };
        });

    const spawnRecording = (stdout: string, code: number | null) => {
        const seen: string[][] = [];
        const fn = ((_command: string, argv: string[]) => {
            seen.push(argv);
            const c = new EventEmitter() as ChildProcess;
            const stream = (text: string) => {
                const s = new EventEmitter() as Readable;
                if (text) process.nextTick(() => s.emit('data', Buffer.from(text)));
                return s;
            };
            c.stdout = stream(stdout);
            c.stderr = stream('');
            process.nextTick(() => c.emit('close', code));
            return c;
        }) as unknown as typeof spawn;
        return { fn, seen };
    };

    /**
     * The loop's order (PR 737): its setup phase starts the services — before the gate
     * environment's setup — and run() spawns the runner. A refused start ends there.
     */
    let startingServices = 0;
    const asLoop = (runner: ReturnType<typeof createDockerRunner>): ReturnType<typeof createDockerRunner> => ({
        ...runner,
        run: async (j, session, onOutput) => {
            await runner.syncCheckout(j, undefined, session);
            startingServices += 1;
            let refused: Awaited<ReturnType<typeof runner.startServices>>;
            try {
                refused = await runner.startServices(j);
            } finally {
                startingServices -= 1;
            }
            return refused ?? runner.run(j, session, onOutput);
        },
    });
    /**
     * The fakes below script `docker ps` for the fence, teardown and probes; while a start waits for
     * its fleet, the readiness listing answers every service the daemon was asked to run, running —
     * what docker would say once they are up. Outside a start the fake's own answer stands.
     */
    const readyWhileStarting = (exec: unknown): Parameters<typeof createDockerRunner>[2] => {
        const seen: string[][] = [];
        const inner = exec as (args: string[], options?: object) => Promise<{ stdout: string }>;
        return (async (args: string[], options?: object) => {
            seen.push(args);
            if (startingServices > 0 && args[0] === 'ps' && args.includes('{{json .}}')) return runningServicesPs(seen);
            return inner(args, options);
        }) as Parameters<typeof createDockerRunner>[2];
    };
    const bareServicesRunner = (exec: ReturnType<typeof daemon>, fn: typeof spawn) =>
        dockerRunner(readyWhileStarting(exec), {
            env: { RUNNER_SERVICES: '1' },
            spawn: fn,
            files: memoryFiles(),
        });
    const servicesRunner = (exec: ReturnType<typeof daemon>, fn: typeof spawn) => asLoop(bareServicesRunner(exec, fn));

    // A spawn stub whose children never emit on their own: each spawn hands the test a fire
    // function, so the interleaving — one attempt's error or close landing after another
    // attempt's fleet is already up — is the test's to pace. `track`, when given, sees every
    // spawned argv: it is how the cross-instance tests register the runner container on the
    // scripted daemon, whose `docker run` goes through spawnFn and never through the exec seam.
    const gatedSpawns = (track?: (argv: string[]) => void) => {
        const fires: ((what: 'error' | 'close', payload?: unknown) => void)[] = [];
        const fn = ((_command: string, argv: string[]) => {
            track?.(argv);
            const c = new EventEmitter() as ChildProcess;
            const stream = () => {
                const s = new EventEmitter() as Readable;
                return s;
            };
            c.stdout = stream();
            c.stderr = stream();
            fires.push((what, payload) => process.nextTick(() => c.emit(what, payload)));
            return c;
        }) as unknown as typeof spawn;
        const childAt = async (index: number): Promise<(what: 'error' | 'close', payload?: unknown) => void> => {
            // A macrotask per turn, never a bare microtask wait: the runner now always writes its
            // env file (real fs) between setup and spawn, and a wait that never leaves the
            // microtask queue would starve the event loop — the I/O completion the next spawn
            // waits behind could never run.
            while (fires.length <= index) await new Promise((r) => setImmediate(r));
            return fires[index]!;
        };
        return { fn, fires, childAt };
    };

    /*
     * The attempt-scoping helpers. Two attempts of one job — the stale-race cast, used by every
     * test below that replays an interleaving between an attempt A and its replacement B. The
     * lease-aware ps answer is what makes "A's removals never carry B's id" assertable: a `ps`
     * whose filters carry a lease label answers with that attempt's own id only (idFor mints it
     * from the token's first letter), while a job-scoped `ps` — the fence's — answers with both
     * attempts'. touchesB is the blanket assertion: no argv element of a stale attempt may
     * contain any of B's identifiers.
     */
    const ATTEMPT_A = 'aaaaaaa2-2222-4222-8222-222222222222';
    const ATTEMPT_B = 'bbbbbbb3-3333-4333-8333-333333333333';
    const attemptA: BoardJob = { ...job, leaseToken: ATTEMPT_A };
    const attemptB: BoardJob = { ...job, leaseToken: ATTEMPT_B };
    const idFor = (token: string): string => token.slice(0, 1).repeat(12);
    const touchesB = (args: string[]): boolean => args.some((arg) => arg.includes(ATTEMPT_B) || arg === 'bbbbbbbbbbbb');
    const psAnswer = (args: string[]): string => {
        const lease = args.find((arg) => arg.startsWith('label=factory.lease='))?.split('=')[2];
        // A lease-scoped ps answers with that attempt's own id; a job-scoped one — the fence's —
        // answers with a neutral leftover, because the fence legitimately removes EVERYTHING the
        // job label covers: that is its role, and it runs before anything is created.
        return lease ? `${idFor(lease)}\n` : psListing(args, 'a6a6a6a6a6a6');
    };

    // Issue #773: the service joins its group supervisor's network namespace, so the group — its
    // supervisor started, its hosts file naming the service on loopback — comes first.
    it('starts the claim’s service in its started group’s namespace, and the runner joins it too', async () => {
        const exec = daemon();
        const { fn, seen } = spawnRecording('ran\n', 0);
        const outcome = await servicesRunner(exec, fn).run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const calls = exec.mock.calls.map((call) => call[0]);
        const supervisorAt = calls.findIndex((a) => a.join(' ') === `start ${supervisorName(job)}`);
        const serviceAt = calls.findIndex((a) => isServiceRun(a));
        expect(supervisorAt).toBeGreaterThanOrEqual(0);
        expect(serviceAt).toBeGreaterThan(supervisorAt);
        expect(calls.some((a) => a[0] === 'network')).toBe(false);
        expect(calls[serviceAt]).toEqual(serviceRunArgs(job, STUB, supervisorName(job), BOARD));
        // The runner shares the namespace — that is the whole feature: inside the job, `stub`
        // resolves to the service on loopback.
        expect(seen[0]).toEqual(['start', '-a', containerName(job)]);
        expect(calls.find((a) => a[0] === 'create' && a.includes(containerName(job)))).toEqual(
            dockerArgs(
                loadDriverConfig({ RUNNER_SERVICES: '1' }),
                job,
                { id: SESSION, resume: false },
                { envFile: envFilePath(job) }
            )
        );
    });

    it('starts every service the claim carries, a declared port changing no argv', async () => {
        const planned: BoardJob = {
            ...job,
            services: [
                { name: 'postgres', image: 'postgres:1', environment: [], ports: [5432] },
                { name: 'redis', image: 'redis:1', environment: [], user: { uid: 999, gid: 999 } },
            ],
        };
        const exec = daemon();
        const outcome = await servicesRunner(exec, spawnRecording('ran\n', 0).fn).run(planned, {
            id: SESSION,
            resume: false,
        });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const started = exec.mock.calls.map((call) => call[0]).filter((a) => isServiceRun(a));
        expect(started).toEqual([
            serviceRunArgs(
                planned,
                { name: 'postgres', image: 'postgres:1', environment: [] },
                supervisorName(planned),
                BOARD
            ),
            serviceRunArgs(
                planned,
                { name: 'redis', image: 'redis:1', environment: [], user: { uid: 999, gid: 999 } },
                supervisorName(planned),
                BOARD
            ),
        ]);
        expect(started.every((a) => !a.includes('5432'))).toBe(true);
    });

    // An attempt that synced none (an adopted run) gets its group made first: a supervisor to join.
    it('runs nothing but the services, and creates no network: no readout container is ever run', async () => {
        const exec = daemon();
        const runner = bareServicesRunner(exec, spawnRecording('', 0).fn);
        await expect(runner.startServices(job)).resolves.toBeNull();

        const calls = exec.mock.calls.map((call) => call[0]);
        const runs = calls.filter((a) => a[0] === 'run');
        expect(runs).toEqual([serviceRunArgs(job, STUB, supervisorName(job), BOARD)]);
        expect(runs.some((a) => a.includes('--entrypoint') || a.includes('sh'))).toBe(false);
        expect(calls.some((a) => a[0] === 'network')).toBe(false);
        expect(calls.findIndex((a) => a.join(' ') === `start ${supervisorName(job)}`)).toBeLessThan(
            calls.findIndex((a) => isServiceRun(a))
        );
    });

    it('starts nothing and changes no argv when the claim carries no services', async () => {
        // The path every existing repo takes: no services on the claim, no network, byte-identical
        // runner argv, exercised end to end rather than only at the dockerArgs parameter.
        const exec = daemon();
        const { fn, seen } = spawnRecording('ran\n', 0);
        const outcome = await servicesRunner(exec, fn).run(baseJob, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(seen[0]).toEqual(['start', '-a', containerName(baseJob)]);
        expect(calls.find((a) => a[0] === 'create' && a.includes(containerName(baseJob)))).toEqual(
            dockerArgs(
                loadDriverConfig({ RUNNER_SERVICES: '1' }),
                baseJob,
                { id: SESSION, resume: false },
                { envFile: envFilePath(baseJob) }
            )
        );
        expect(calls.some((a) => a[0] === 'network')).toBe(false);
        expect(calls.every((a) => !isServiceRun(a))).toBe(true);
    });

    /*
     * The fleet outlives run(): the loop runs the declared gates after it, and those are what
     * test against the services. The close tears down only the runner container; the loop's
     * releaseServices takes the fleet down once the gates are done.
     */
    it('keeps the services up past the run, and tears them down on release', async () => {
        const exec = daemon();
        const runner = servicesRunner(exec, spawnRecording('', 1).fn);
        await runner.run(job, { id: SESSION, resume: false });

        const serviceAt = exec.mock.calls.findIndex((call) => isServiceRun(call[0]));
        const afterSetup = exec.mock.calls.slice(serviceAt).map((call) => call[0]);
        expect(afterSetup).not.toContainEqual(['rm', '-f', 'c0ffee000001']);

        const releasedAt = exec.mock.calls.length;
        await runner.releaseServices(job);
        const released = exec.mock.calls.slice(releasedAt).map((call) => call[0]);
        expect(released).toContainEqual(['rm', '-f', 'c0ffee000001']);
        expect(released.some((a) => a[0] === 'network')).toBe(false);
    });

    // Review: setup must not race a fleet still starting — the start answers only once every
    // service runs, and one that never does is a ServicesNotRunning, as in the restart.
    const readinessDaemon = (states: string[]) => {
        const base = daemon();
        let polls = 0;
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'ps' && args.includes('{{json .}}')) {
                const State = states[Math.min(polls++, states.length - 1)];
                return { stdout: JSON.stringify({ Labels: 'factory.service=stub', Image: 'stub-svc:1', State }) };
            }
            return base(args);
        });
        return { exec, polls: () => polls };
    };
    const startWith = (
        exec: ReturnType<typeof readinessDaemon>['exec'],
        signal?: AbortSignal,
        kill: AbortSignal = new AbortController().signal
    ) =>
        startJobServices(
            job,
            loadDriverConfig({ RUNNER_SERVICES: '1' }),
            {
                execDocker: exec as unknown as (args: string[]) => Promise<{ stdout: string; stderr: string }>,
                ledger: { was: () => ({ stopped: false, hard: false }), signal: () => kill },
                serviceTeardown: async () => {},
                sleep: async () => {},
            },
            signal
        );

    it('startServices answers only once every service runs', async () => {
        const d = readinessDaemon(['created', 'running']);
        await expect(startWith(d.exec)).resolves.toBeNull();
        expect(d.polls()).toBe(2);
    });

    it('startServices rejects with ServicesNotRunning when a service exits', async () => {
        const d = readinessDaemon(['exited']);
        await expect(startWith(d.exec)).rejects.toBeInstanceOf(ServicesNotRunning);
    });

    // #869: the listing the readiness wait reads ends on the supplied stand-down and on the attempt's kill.
    it.each(['the supplied stand-down', 'the attempt’s kill'])(
        'startServices ends a pending listing on %s',
        async (who) => {
            const stand = new AbortController();
            const kill = new AbortController();
            const hang = vitest.fn((args: string[], options?: { signal?: AbortSignal }) =>
                args[0] === 'ps' && args.includes('{{json .}}') ? hangsUntilAborted(options) : daemon()(args)
            );
            const pending = startWith(hang as never, stand.signal, kill.signal);
            await vitest.waitFor(() => expect(hang.mock.calls.some((call) => call[0]![0] === 'ps')).toBe(true));
            (who === 'the supplied stand-down' ? stand : kill).abort();
            expect(await endsSoon(pending)).toBe(true);
        }
    );

    // Review (PR 737): the loop starts the services before the gate environment's setup, so run()
    // must neither start them again nor fence them away; the runner joins their namespace.
    it('run() starts no services after the loop started them, and the runner joins their namespace', async () => {
        const exec = daemon();
        const runner = bareServicesRunner(exec, spawnRecording('', 0).fn);
        await runner.syncCheckout(job, undefined, { id: SESSION, resume: false });
        await expect(runner.startServices(job)).resolves.toBeNull();
        const startedAt = exec.mock.calls.length;
        await runner.run(job, { id: SESSION, resume: false });

        const during = exec.mock.calls.slice(startedAt).map((call) => call[0]);
        expect(during.some((a) => a[0] === 'network')).toBe(false);
        const readsBellows = (a: string[]) => a.some((arg) => arg.startsWith('BELLOWS_ROOT='));
        expect(during.some((a) => a[0] === 'run' && (isServiceRun(a) || readsBellows(a)))).toBe(false);
        const created = during.find((a) => a[0] === 'create' && a.includes(containerName(job)));
        expect(created?.[created.indexOf('--network') + 1]).toBe(`container:${supervisorName(job)}`);
    });

    // Issue #773: no network is an attempt's, so the fence lists none.
    it("run()'s fence spares this attempt's own containers, and lists no network", async () => {
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'ps' && args.includes('--format')) {
                return {
                    stdout: `b0b0b0b0b001\t${job.leaseToken}\nb0b0b0b0b002\taaaaaaaa-1111-4111-8111-aaaaaaaaaaaa\n`,
                };
            }
            return { stdout: '' };
        });
        await bareServicesRunner(exec, spawnRecording('', 0).fn).run(job, { id: SESSION, resume: false });

        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls).toContainEqual(['rm', '-f', 'b0b0b0b0b002']);
        expect(calls).not.toContainEqual(['rm', '-f', 'b0b0b0b0b001']);
        expect(calls.some((a) => a[0] === 'network')).toBe(false);
    });

    // The fence takes other attempts' leftovers before the group exists; this lease's own are
    // the service start's to clear, before the first service runs.
    it('clears leftover services before the first service starts', async () => {
        const exec = daemon();
        await servicesRunner(exec, spawnRecording('', 0).fn).run(job, { id: SESSION, resume: false });

        const calls = exec.mock.calls.map((call) => call[0]);
        const firstPsAt = calls.findIndex((a) => a[0] === 'ps');
        const serviceAt = calls.findIndex((a) => isServiceRun(a));
        expect(firstPsAt).toBeGreaterThanOrEqual(0);
        expect(firstPsAt).toBeLessThan(calls.findIndex((a) => a[0] === 'create'));
        expect(calls.slice(0, serviceAt).some((a) => a[0] === 'rm' && a[1] === '-f' && a[2] === 'c0ffee000001')).toBe(
            true
        );
    });

    it('sends a refused service to the lease, after tearing down what did start', async () => {
        const exec = daemon({ serviceFails: true });
        const { fn, seen } = spawnRecording('', 0);
        await expect(servicesRunner(exec, fn).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /could not start service "stub"/
        );
        expect(seen).toHaveLength(0);
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls).toContainEqual(['rm', '-f', 'c0ffee000001']);
        expect(calls.some((a) => a[0] === 'network')).toBe(false);
    });

    it('kill() stops the runner at once and leaves the services to end(): releaseServices reclaims them', async () => {
        const exec = daemon();
        await servicesRunner(exec, spawnRecording('', 0).fn).kill(job);
        const calls = exec.mock.calls.map((call) => call[0]);
        // The runner is resolved through this attempt's own labels and killed by ID — never by
        // name, which a stale attempt's kill could otherwise compute against a replacement's
        // container. The hard kill takes the whole group: the supervisor and the exporter too.
        expect(calls).toContainEqual([
            'ps',
            '-aq',
            '--filter',
            `label=factory.job=${job.id}`,
            '--filter',
            `label=factory.lease=${job.leaseToken}`,
        ]);
        expect(calls).toContainEqual(['kill', 'c0ffee000001']);
        // The recovery evidence outlives the safety kill: the services go with end()'s retention-gated release.
        expect(calls).not.toContainEqual(['rm', '-f', 'c0ffee000001']);
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        await runner.releaseServices(job);
        expect(exec.mock.calls.map((call) => call[0])).toContainEqual(['rm', '-f', 'c0ffee000001']);
        expect(exec.mock.calls.map((call) => call[0]).some((a) => a[0] === 'network')).toBe(false);
    });

    // A lost lease fires kill() while the setup may still be awaiting the daemon. Throwing is the
    // loop's contract for it — the outcome of a lost lease is discarded, and the next attempt's
    // fence removes whatever was already created — so the abort's only job is to stop THIS
    // attempt from creating more resources and from spawning the runner over a lease that is gone.
    it('aborts the setup, creating nothing more and spawning nothing, when the job is killed mid-setup', async () => {
        const handle: { kill: ((j: BoardJob) => Promise<void>) | null } = { kill: null };
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) {
                // The lease is lost while the service start is in flight; kill() is what the loop
                // calls, and it must be recorded before the start resolves.
                await handle.kill!(job);
                return { stdout: '' };
            }
            if (args[0] === 'ps') return { stdout: psListing(args, 'c0ffee000001') };
            return { stdout: '' };
        });
        const { fn, seen } = spawnRecording('ran\n', 0);
        const runner = servicesRunner(exec, fn);
        handle.kill = runner.kill;

        await expect(runner.run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /killed while setting up services/
        );
        // The start in flight when the kill landed is the last thing the attempt created.
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls.filter((a) => isServiceRun(a))).toHaveLength(1);
        expect(seen).toHaveLength(0);
    });

    it('removes nothing when the job is killed while the fence is still listing the leftovers', async () => {
        const handle: { kill: ((j: BoardJob) => Promise<void>) | null } = { kill: null };
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'ps' && args.includes('-a')) {
                await handle.kill!(job);
                return { stdout: psListing(args, 'c0ffee000001') };
            }
            return { stdout: '' };
        });
        const { fn } = spawnRecording('ran\n', 0);
        const runner = servicesRunner(exec, fn);
        handle.kill = runner.kill;

        await expect(runner.run(job, { id: SESSION, resume: false })).rejects.toThrow();

        expect(exec.mock.calls.map((call) => call[0]).filter((a) => a.includes('c0ffee000001'))).toEqual([]);
    });

    // The two-attempt race: A loses its lease mid-setup and B claims the same job id before A
    // aborts — the loop dedups by nothing. A kill names ATTEMPT A; B carries a fresh lease
    // token that was never killed, so B must proceed, and A must stay aborted. Keyed by job
    // id, one marker serves both attempts: B's claim would either be aborted by a kill meant
    // for A, or wipe the marker and revive A to compete for the same containers.
    it('aborts only the killed attempt when a sibling attempt of the same id claims the job', async () => {
        const handle: { kill: ((j: BoardJob) => Promise<void>) | null } = { kill: null };
        let killedA = false;
        let releaseA: (() => void) | null = null;
        const killRecorded = new Promise<void>((resolve) => {
            releaseA = resolve;
        });
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) {
                if (!killedA) {
                    // A's lease is lost while its service start is in flight; the loop's kill()
                    // must be on record before the start resolves.
                    killedA = true;
                    await handle.kill!(attemptA);
                    releaseA!();
                }
                return { stdout: '' };
            }
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const { fn, seen } = spawnRecording('ran\n', 0);
        const runner = servicesRunner(exec, fn);
        handle.kill = runner.kill;

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        // runA rejects as soon as its kill lands — before the test observes it — so mark it
        // handled now; an interim unhandled-rejection state here derails the test worker.
        runA.catch(() => undefined);
        await killRecorded;
        // Everything issued so far is A's: the kill window closes here, before B starts.
        const aEnd = exec.mock.calls.length;
        // B's claim lands while A is still between awaited steps — nothing stops it.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });

        // A was the attempt the loop killed: it aborts.
        await expect(runA).rejects.toThrow(/killed while setting up services/);
        // And nothing A issued on its way out — kill and teardown included — named anything of
        // B's: the ps filters carry A's lease, and B's token appears in no argv.
        const aCalls = exec.mock.calls.slice(0, aEnd).map((call) => call[0]);
        expect(aCalls.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(aCalls.every((a) => !touchesB(a))).toBe(true);

        // B was never killed, whatever happened to A: group, service, spawn all happen —
        // under B's OWN names, since every name carries B's token.
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
        // A's start was in flight when its kill landed; it went no further. B started its own
        // service, in its own supervisor's namespace — labeled like everything the attempt stands up.
        const services = exec.mock.calls.map((call) => call[0]).filter((a) => isServiceRun(a));
        expect(services).toEqual([
            serviceRunArgs(attemptA, STUB, supervisorName(attemptA), BOARD),
            serviceRunArgs(attemptB, STUB, supervisorName(attemptB), BOARD),
        ]);
        expect(seen).toHaveLength(1);
    });

    // The abort must not disturb a sibling attempt's fleet. In the gated world that needed a
    // teardown-FREE abort; in the scoped world the kill's teardown ISSUES its daemon calls and
    // is safe because of what it names: every ps carries A's lease, every removal carries A's
    // id. B claims with a fresh token and stands its fleet up afterwards,
    // untouched — nothing A issued could resolve to it.
    it("scopes a killed attempt's teardown to its own lease, leaving a sibling attempt's fleet alone", async () => {
        const handle: { kill: ((j: BoardJob) => Promise<void>) | null } = { kill: null };
        let killedA = false;
        let releaseKill: (() => void) | null = null;
        const killSettled = new Promise<void>((resolve) => {
            releaseKill = resolve;
        });
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) {
                if (!killedA) {
                    // A's lease is lost while its service start is in flight; kill() — its own
                    // teardown included — must be fully settled before the start resolves.
                    killedA = true;
                    await handle.kill!(attemptA);
                    releaseKill!();
                }
                return { stdout: '' };
            }
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const { fn, seen } = spawnRecording('ran\n', 0);
        const runner = servicesRunner(exec, fn);
        handle.kill = runner.kill;

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        // runA rejects as soon as its kill lands — before the test observes it — so mark it
        // handled now; an interim unhandled-rejection state here derails the test worker.
        runA.catch(() => undefined);
        await killSettled;
        await expect(runA).rejects.toThrow(/killed while setting up services/);

        // Everything so far is A's: the kill and its teardown ran — and every call of them is
        // scoped to A. The ps filters carry A's lease, the removals carry A's id, and no argv
        // element names anything of B's.
        const aCalls = exec.mock.calls.map((call) => call[0]);
        expect(aCalls.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(aCalls).toContainEqual(['kill', idFor(ATTEMPT_A)]);
        expect(aCalls).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(aCalls.some((a) => a[0] === 'network')).toBe(false);
        expect(aCalls.every((a) => !touchesB(a))).toBe(true);

        // B, the newer attempt for the same job id: fence, group, service start and runner
        // spawn all happen after A's abort — and nothing A did on the way out disturbed
        // them.
        const outcome = await runner.run(attemptB, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls).toContainEqual(serviceRunArgs(attemptB, STUB, supervisorName(attemptB), BOARD));
        expect(seen).toHaveLength(1);
    });

    // A's close that lands LATE, over B's live fleet, two ways:
    // - killed: A was killed — kill() tore A's own fleet down while it was still legitimately A's
    //   own — and the loop re-claimed the job as B before A's CLI client finally exited (137).
    // - natural close: NO kill anywhere — the lease expires server-side and the board re-claims
    //   the job as B before any heartbeat delivers 'lost', so A's `killed` marker is never
    //   recorded. B's fence removes A's leftovers, which closes A's CLI client (0). Not-killed is
    //   not a free pass to skip the release — it runs unconditionally.
    // Either way the loop's release after A's verdict still runs its teardown, gate-free: the
    // teardown is scoped to A's lease, so whatever it names is A's own, and B's live fleet is
    // structurally unaddressable no matter how late the close lands.
    it.each([
        ["a killed attempt's", true, 137],
        ["a natural close's", false, 0],
    ])(
        'scopes %s late verdict teardown to its own lease when the replacement has stood its fleet up',
        async (_label, killA, closeCode) => {
            // Both children hold their close until released, so the interleaving — A still alive
            // while B stands its fleet up, then A's close landing over it — is the test's to pace.
            const closers: (() => void)[] = [];
            const gatedSpawn = ((_command: string, _argv: string[]) => {
                const c = new EventEmitter() as ChildProcess;
                const stream = () => {
                    const s = new EventEmitter() as Readable;
                    return s;
                };
                c.stdout = stream();
                c.stderr = stream();
                closers.push(() => process.nextTick(() => c.emit('close', closeCode)));
                return c;
            }) as unknown as typeof spawn;
            const closeOf = async (index: number): Promise<() => void> => {
                // Same macrotask yield as childAt above: the runner's env-file write is real fs on the
                // way to each spawn, and a microtask-only wait would starve it.
                while (closers.length <= index) await new Promise((r) => setImmediate(r));
                return closers[index]!;
            };

            const exec = vitest.fn(async (args: string[]) => {
                if (isServiceRun(args)) return { stdout: '' };
                if (args[0] === 'ps') return { stdout: psAnswer(args) };
                return { stdout: '' };
            });
            const runner = servicesRunner(exec, gatedSpawn);

            const runA = runner.run(attemptA, { id: SESSION, resume: false });
            const closeA = await closeOf(0); // A spawned; its CLI client is alive
            // Killed: the loop loses A's lease and kills the attempt — A's own fleet torn down while
            // it is still legitimately A's. Natural close: no kill in between; the heartbeat has not
            // yet told the loop A's lease is gone, and B's fence removes A's leftovers by label.
            if (killA) await runner.kill(attemptA);
            // B re-claims the same job id and stands a fresh fleet up.
            const runB = runner.run(attemptB, { id: SESSION, resume: false });
            await closeOf(1); // B spawned; its group and service are live
            const afterBCreation = exec.mock.calls.length;

            // A's CLI client only now exits — daemon slowness, or B's fence, makes the close
            // arbitrarily late — and its verdict lands over B's live fleet; the loop releases A's
            // services after it.
            closeA();
            await runA;
            await runner.releaseServices(attemptA);

            const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
            // The teardown ran — and every call of it is A's: the ps filters carry A's lease, the
            // removals carry A's id, and nothing names B.
            expect(late.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
            expect(late).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
            expect(late.some((a) => a[0] === 'network')).toBe(false);
            expect(late.every((a) => !touchesB(a))).toBe(true);

            // B is untouched and still finishes under its own verdict.
            closers[1]!();
            await expect(runB).resolves.toMatchObject({ exitCode: closeCode, started: true });
        }
    );

    // The late-kill twin of the two close tests above: the kill itself arrives AFTER the
    // replacement claimed the job and stood its fleet up — the heartbeat can be arbitrarily
    // slow to deliver the lease loss, and the claim loop has no per-job dedupe. There is no
    // gate to stop the kill, and none is needed: the kill resolves its target through A's own
    // lease label and kills by id, so the only container it can name is A's, and its teardown
    // is scoped the same way.
    it("scopes a kill that lands after the replacement stood its fleet up to the killed attempt's own lease", async () => {
        const { fn, fires, childAt } = gatedSpawns();
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const runner = servicesRunner(exec, fn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await childAt(0); // A spawned; its CLI client is alive
        // B re-claims the same job id and stands a fresh fleet up BEFORE the loop learns of
        // A's lost lease.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await childAt(1); // B spawned; its group and service are live
        const afterBCreation = exec.mock.calls.length;

        // Only now does the loop's kill for A fire — over a daemon where B's fleet is live.
        await runner.kill(attemptA);

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        // The kill resolved its runner through A's lease label and killed by id — never by
        // name — and the teardown behind it is A-scoped too. Nothing names B.
        expect(late.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(late).toContainEqual(['kill', idFor(ATTEMPT_A)]);
        // The safety kill leaves the services to end(); its release is scoped to A's lease the same way.
        expect(late).not.toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        await runner.releaseServices(attemptA);
        const released = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(released).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(released.every((a) => !touchesB(a))).toBe(true);
        expect(late.some((a) => a[0] === 'network')).toBe(false);
        expect(late.every((a) => !touchesB(a))).toBe(true);

        // A still winds down by its own killed marker, and B is untouched, finishing under
        // its own verdict.
        fires[0]!('close', 137);
        await runA;
        fires[1]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    // A spawn failure is a fact the run throws, at once: it tears nothing down (#828) — the services
    // it started are the loop's `releaseServices` to take down, which still finds and removes them.
    it('rejects a spawn error at once, leaving the services for the loop to release', async () => {
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'ps') return { stdout: psListing(args, 'c0ffee000001') };
            return { stdout: '' };
        });
        // A child that never closes: the CLI could not even be spawned, which is the 'error'
        // event and nothing else.
        const erroring = (() => {
            const c = new EventEmitter() as ChildProcess;
            process.nextTick(() => c.emit('error', new Error('spawn docker ENOENT')));
            return c;
        }) as unknown as typeof spawn;
        const runner = servicesRunner(exec, erroring);
        await expect(runner.run(job, { id: SESSION, resume: false })).rejects.toThrow(/ENOENT/);
        const removals = () => exec.mock.calls.filter((c) => c[0].join(' ') === 'rm -f c0ffee000001').length;
        const beforeRelease = removals();
        await runner.releaseServices(job);
        expect(removals()).toBeGreaterThan(beforeRelease);
    });

    // A spawn failure makes Node deliver 'error' and then 'close' with a null code. The close
    // must not settle the promise once the error has been seen: verdict(null) would read as a
    // started run with no exit code — a terminal failed job — when the truth is infrastructure
    // the loop should leave to its lease.
    it('rejects with the spawn error even when close follows it', async () => {
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: psListing(args, 'c0ffee000001') };
            return { stdout: '' };
        });
        // Node's failed-spawn order: 'error' first, then 'close' with code null.
        const errorThenClose = (() => {
            const c = new EventEmitter() as ChildProcess;
            process.nextTick(() => {
                c.emit('error', new Error('spawn docker ENOENT'));
                c.emit('close', null);
            });
            return c;
        }) as unknown as typeof spawn;
        const pending = servicesRunner(exec, errorThenClose).run(job, { id: SESSION, resume: false });
        // Handled from the start: the run rejects on the error itself, before the close's turn.
        const rejected = expect(pending).rejects.toThrow(/ENOENT/);
        // A macrotask, so the close and the close handler's verdict get their turn too.
        await new Promise((resolve) => setTimeout(resolve, 20));
        await rejected;
    });

    /** The group-removal calls the daemon saw from the spawn on: the supervisor's and the exporter's. */
    const groupRemovals = (exec: ReturnType<typeof daemon>, from: number) =>
        exec.mock.calls
            .slice(from)
            .map((call) => call[0])
            .filter((args) => args[0] === 'rm' && [supervisorName(job), exporterName(job)].includes(args[2] ?? ''));

    // The run is no teardown owner beside the loop's `end()` (#828): a spawn that errored rejects
    // with the group untouched, and the loop's `finish` or its retention decides.
    it('removes nothing of the group when a spawn errors before rejecting', async () => {
        const exec = daemon();
        let spawnedAt = -1;
        const errored = (() => {
            spawnedAt = exec.mock.calls.length;
            const c = new EventEmitter() as ChildProcess;
            process.nextTick(() => c.emit('error', new Error('spawn docker ENOENT')));
            return c;
        }) as unknown as typeof spawn;
        await expect(servicesRunner(exec, errored).run(job, { id: SESSION, resume: false })).rejects.toThrow(/ENOENT/);
        expect(spawnedAt).toBeGreaterThan(0);
        expect(groupRemovals(exec, spawnedAt)).toEqual([]);
    });

    // A refused create is a returned fact too: no group removal from run(), the loop's `end()` finishes.
    it('removes nothing of the group when the runner container is refused', async () => {
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'create' && args.includes(containerName(job))) {
                throw Object.assign(new Error('Command failed'), { stderr: 'Error response from daemon: Conflict\n' });
            }
            return { stdout: '' };
        });
        const never = (() => {
            throw new Error('the refused create must not reach the spawn');
        }) as unknown as typeof spawn;
        const asDaemon = exec as unknown as ReturnType<typeof daemon>;
        const outcome = await servicesRunner(asDaemon, never).run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: false });
        const calls = exec.mock.calls.map((call) => call[0]);
        const refusedAt = calls.findIndex((args) => args[0] === 'create' && args.includes(containerName(job)));
        expect(refusedAt).toBeGreaterThan(0);
        expect(groupRemovals(asDaemon, refusedAt)).toEqual([]);
    });

    // A run whose outcome rejects once its group exists leaves that group alone: the loop leaves such a
    // run to its lease so the next claim can adopt it (`thrownRunDecision`, `loop-fence.ts`).
    it('a run that rejects leaves its group for the loop to decide', async () => {
        const exec = daemon();
        let spawnedAt = -1;
        const throwing = (() => {
            spawnedAt = exec.mock.calls.length;
            throw new Error('the attach could not be spawned');
        }) as unknown as typeof spawn;
        await expect(servicesRunner(exec, throwing).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /could not be spawned/
        );
        expect(spawnedAt).toBeGreaterThan(0);
        expect(groupRemovals(exec, spawnedAt)).toEqual([]);
    });

    // The spawn-error twin: A's runner spawn fails, but the failure is delivered only after B
    // claimed the same job id and stood its fleet up. The loop's release of the attempt's
    // services is unconditional, and safe so: the teardown's filters carry A's lease, so the
    // only fleet it can find and remove is A's own.
    it("scopes a superseded spawn error's teardown to the failing attempt's own lease", async () => {
        const { fn, fires, childAt } = gatedSpawns();
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const runner = servicesRunner(exec, fn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await childAt(0); // A is as far as its spawn, whose failure stays undelivered for now
        // B re-claims the same job id and stands a fresh fleet up while A's spawn failure is
        // still in flight.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await childAt(1); // B spawned; its group and service are live
        const afterBCreation = exec.mock.calls.length;

        fires[0]!('error', new Error('spawn docker ENOENT'));
        runA.catch(() => undefined);
        await expect(runA).rejects.toThrow(/ENOENT/);
        // The loop's release for A addresses only A's own resources.
        await runner.releaseServices(attemptA);

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(late.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(late).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(late.some((a) => a[0] === 'network')).toBe(false);
        expect(late.every((a) => !touchesB(a))).toBe(true);

        // B is untouched and still finishes under its own verdict.
        fires[1]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    // The mid-flight twin: A's release starts after its spawn error, and B claims the job id only while that teardown sits mid-flight, between its ps and its
    // removals. In the gated world this interleaving needed a live ownership predicate
    // re-armed at every step; in the scoped world it needs nothing: the removals were chosen by
    // a ps that filtered on A's lease, and releasing them late removes exactly what that ps
    // found — A's own resources — whatever B stood up in between.
    it('keeps a teardown scoped to its own lease even when the replacement stands its fleet up while it is mid-flight', async () => {
        const { fn, fires, childAt } = gatedSpawns();
        let releaseTeardownPs: (() => void) | null = null;
        const teardownPsGate = new Promise<void>((resolve) => {
            releaseTeardownPs = resolve;
        });
        let markTeardownPs: (() => void) | null = null;
        const teardownPsParked = new Promise<void>((resolve) => {
            markTeardownPs = resolve;
        });
        let psCount = 0;
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) return { stdout: '' };
            if (args[0] === 'ps') {
                psCount++;
                // ps #1 is A's entry fence; ps #2 is A's fence-half teardown; ps #3 is A's
                // error-path teardown, parked so B can stand its fleet up while it sits
                // between its ps and its removals; ps #4 and #5 are B's fence and fence-half.
                if (psCount === 3) {
                    markTeardownPs!();
                    await teardownPsGate;
                }
                return { stdout: psAnswer(args) };
            }
            return { stdout: '' };
        });
        const runner = servicesRunner(exec, fn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await childAt(0); // A spawned; its CLI client is alive
        fires[0]!('error', new Error('spawn docker ENOENT')); // A is still current
        runA.catch(() => undefined);
        await expect(runA).rejects.toThrow(/ENOENT/); // the run only throws; it tears nothing down
        const releaseA = runner.releaseServices(attemptA); // the loop's release for A starts
        await teardownPsParked; // the teardown is parked between its ps and its removals

        // B re-claims the same job id and stands a fresh fleet up while A's teardown is in flight.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await childAt(1); // B spawned; its group and service are live
        const afterBCreation = exec.mock.calls.length;

        releaseTeardownPs!(); // the teardown resumes — and names only what its own ps found
        await releaseA;

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(late).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(late.some((a) => a[0] === 'network')).toBe(false);
        expect(late.every((a) => !touchesB(a))).toBe(true);

        // B is untouched and still finishes under its own verdict.
        fires[1]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    // The kill() twin: kill()'s `docker kill` daemon call is arbitrarily slow, and a
    // replacement claim lands inside that window and stands its fleet up — under its own
    // names. When the kill resumes, its teardown addresses only what A's lease filters resolve
    // to; B's fleet was never nameable by any of it, so there is nothing to re-check.
    it('keeps a kill scoped to its own lease even when the replacement stands its fleet up while the docker kill is mid-flight', async () => {
        const { fn, fires, childAt } = gatedSpawns();
        let releaseKill: (() => void) | null = null;
        const killGate = new Promise<void>((resolve) => {
            releaseKill = resolve;
        });
        let markKillParked: (() => void) | null = null;
        const killParked = new Promise<void>((resolve) => {
            markKillParked = resolve;
        });
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'kill') {
                // kill()'s `docker kill` is held mid-flight — the arbitrarily slow daemon
                // call inside which B claims.
                markKillParked!();
                await killGate;
                return { stdout: '' };
            }
            if (isServiceRun(args)) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const runner = servicesRunner(exec, fn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await childAt(0); // A spawned; its runner and fleet stand
        const pending = runner.kill(attemptA); // resolves its target, then parks in `docker kill`
        await killParked;

        // The kill by id was issued before B existed, and it was A's id — resolved through
        // A's lease label — not a name.
        const killCall = exec.mock.calls.map((call) => call[0]).find((a) => a[0] === 'kill');
        expect(killCall).toEqual(['kill', idFor(ATTEMPT_A)]);

        // B re-claims the same job id with a fresh token and stands a fresh fleet up while
        // A's kill is still awaiting the daemon.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await childAt(1); // B spawned; its group and service are live
        const afterBCreation = exec.mock.calls.length;

        releaseKill!(); // the kill resumes into its teardown
        await pending;

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(late.some((a) => a[0] === 'ps')).toBe(false); // the kill's own lookup came before B stood up
        // The safety kill leaves the services to end(); its release is scoped to A's lease the same way.
        expect(late).not.toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        await runner.releaseServices(attemptA);
        const released = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(released).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(released.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(released.every((a) => !touchesB(a))).toBe(true);
        expect(late.some((a) => a[0] === 'network')).toBe(false);
        expect(late.every((a) => !touchesB(a))).toBe(true);

        // A still winds down by its own killed marker, and B is untouched, finishing under
        // its own verdict.
        fires[0]!('close', 137);
        await runA;
        fires[1]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    /*
     * The three pins of the attempt-scoping redesign itself. The race tests above replay
     * interleavings; these three state the structural invariant they all follow from: names
     * are attempt-scoped and never repeat, the fence is the only job-scoped sweep, and a stale
     * attempt's every daemon call resolves to its own lease or nothing.
     */

    // The flagship: two RUNNER INSTANCES share one daemon, the way two driver processes hold
    // two attempts of the same job with no in-process state between them. B's fence is
    // job-scoped and removes A's live fleet — that is its role, and it runs before B creates
    // anything; A's runner dying to it is the accepted re-claim semantics. The pin is the LATE
    // kill: fired from A's own runner after B stands its fleet up, every call it issues
    // carries A's lease, B's names appear in no argv, and B finishes its run untouched.
    it("keeps a replacement attempt unaddressable to a stale attempt's late kill across two runner instances", async () => {
        const d = labelDaemon({});
        const spawnA = gatedSpawns();
        const spawnB = gatedSpawns();
        const runner1 = asLoop(
            dockerRunner(readyWhileStarting(d.exec), {
                env: { RUNNER_SERVICES: '1' },
                spawn: spawnA.fn,
            })
        );
        const runner2 = asLoop(
            dockerRunner(readyWhileStarting(d.exec), {
                env: { RUNNER_SERVICES: '1' },
                spawn: spawnB.fn,
            })
        );

        const runA = runner1.run(attemptA, { id: SESSION, resume: false });
        await spawnA.childAt(0); // A's fleet and runner stand on the daemon
        expect(d.containers.has(containerName(attemptA))).toBe(true);
        expect(d.containers.has(serviceContainerName(attemptA, 'stub'))).toBe(true);

        // B claims the same job id with a different token. Its fence is job-scoped and removes
        // A's live fleet before creating anything of its own.
        const runB = runner2.run(attemptB, { id: SESSION, resume: false });
        // Indexes are per instance: B is spawnB's FIRST spawn, not the second of a shared one.
        await spawnB.childAt(0);
        expect(d.containers.has(containerName(attemptA))).toBe(false);
        expect(d.containers.has(serviceContainerName(attemptA, 'stub'))).toBe(false);
        expect(d.containers.has(containerName(attemptB))).toBe(true);
        expect(d.containers.has(serviceContainerName(attemptB, 'stub'))).toBe(true);
        const afterBCreation = d.calls.length;

        // A's late kill fires from its own runner, over a daemon where B's fleet is live.
        await runner1.kill(attemptA);

        const late = d.calls.slice(afterBCreation);
        // Every call kill() issues is scoped to A: the ps filters carry A's lease, and nothing
        // in any argv names B — not B's token, names, or ids.
        expect(late.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(late.every((a) => !touchesB(a))).toBe(true);
        // B's fleet survives on the daemon: its containers all still there.
        expect(d.containers.has(containerName(attemptB))).toBe(true);
        expect(d.containers.has(serviceContainerName(attemptB, 'stub'))).toBe(true);

        // B finishes its run under its own verdict — and A's runner child winds down too:
        // its run never settles otherwise, and the job-timeout timer armed at its spawn would
        // hold the worker's event loop open for the full timeout.
        spawnB.fires[0]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
        spawnA.fires[0]!('close', 137);
        await expect(runA).resolves.toMatchObject({ exitCode: 137, started: true });
    });

    // Same job id, different attempts: every name either attempt computes carries its own
    // token, so no name conflicts and no attempt can compute another's names. The fence is
    // what removes a previous attempt's leftovers when it runs — here seeded as A's leftover
    // runner and service container, still existing when B starts.
    it("computes disjoint names per attempt for the same job id, and fences the previous attempt's leftovers by label", async () => {
        // The pure argv half: the names differ for the same job id.
        expect(containerName(attemptB)).not.toBe(containerName(attemptA));
        expect(serviceContainerName(attemptB, 'stub')).not.toBe(serviceContainerName(attemptA, 'stub'));

        // A's leftovers still exist on the daemon when B's run starts.
        const d = labelDaemon({});
        d.containers.set(containerName(attemptA), { 'factory.job': job.id, 'factory.lease': ATTEMPT_A });
        d.containers.set(serviceContainerName(attemptA, 'stub'), {
            'factory.job': job.id,
            'factory.lease': ATTEMPT_A,
            'factory.service': 'stub',
        });

        const { fn, seen } = spawnRecording('ran\n', 0);
        const runner = asLoop(
            dockerRunner(readyWhileStarting(d.exec), {
                env: { RUNNER_SERVICES: '1' },
                spawn: fn,
            })
        );
        await runner.run(attemptB, { id: SESSION, resume: false });

        // The fence removed both of A's leftovers by label.
        expect(d.containers.has(containerName(attemptA))).toBe(false);
        expect(d.containers.has(serviceContainerName(attemptA, 'stub'))).toBe(false);
        // And B's own create and start are B-scoped: no name A could have been holding.
        const created = d.calls.find((a) => a[0] === 'create' && a.includes(containerName(attemptB)))!;
        expect(created[created.indexOf('--name') + 1]).toBe(containerName(attemptB));
        // The supervisor beside it carries B's names too.
        expect(d.calls.some((a) => a[0] === 'create' && a.includes(supervisorName(attemptB)))).toBe(true);
        expect(seen[0]).toEqual(['start', '-a', containerName(attemptB)]);
    });

    // The fence is the only job-scoped sweep, and this is its full inventory: every labeled
    // container of the job regardless of which attempt made it. Anything not this job's is left alone.
    it('fences every leftover container of the job by label, and nothing else', async () => {
        const oldA = { ...job, leaseToken: 'aaaaaaaa-1111-4111-8111-111111111111' };
        const oldB = { ...job, leaseToken: 'bbbbbbbb-2222-4222-8222-222222222222' };
        const d = labelDaemon({});
        d.containers.set(containerName(oldA), { 'factory.job': job.id, 'factory.lease': oldA.leaseToken });
        d.containers.set(serviceContainerName(oldB, 'stub'), {
            'factory.job': job.id,
            'factory.lease': oldB.leaseToken,
            'factory.service': 'stub',
        });
        d.containers.set('someone-elses-runner', { 'factory.job': '99999999-9999-4999-8999-999999999999' });

        // The loop started B's services first; run()'s fence then sweeps, and the runner's create is
        // the first call after it, so snapshotting there is snapshotting the fence's outcome.
        let afterFence: { containers: string[] } | null = null;
        const exec = async (args: string[]) => {
            if (!afterFence && args[0] === 'create' && args.includes(containerName(attemptB))) {
                afterFence = { containers: [...d.containers.keys()] };
            }
            return d.exec(args);
        };
        const { fn } = spawnRecording('ran\n', 0);
        const runner = asLoop(
            dockerRunner(readyWhileStarting(exec as unknown as (args: string[]) => Promise<{ stdout: string }>), {
                env: { RUNNER_SERVICES: '1' },
                spawn: fn,
            })
        );
        await runner.run(attemptB, { id: SESSION, resume: false });

        // Both leftovers are gone; the other job's container is not this fence's business, and
        // this attempt's own group and fleet — started before run() — are spared.
        expect(afterFence!.containers.sort()).toEqual(
            [serviceContainerName(attemptB, 'stub'), supervisorName(attemptB), 'someone-elses-runner'].sort()
        );
    });

    it('leaves the daemon alone when the switch is off', async () => {
        // RUNNER_SERVICES=0 explicitly: the default is on (services.test.ts pins that), and this
        // test is about the opt-out posture.
        const cfg = loadDriverConfig({ RUNNER_SERVICES: '0' });
        const exec = daemon();
        const { fn, seen } = spawnRecording('ran\n', 0);
        const outcome = await createDockerRunner(
            cfg,
            fn,
            withTaskVolume(exec as unknown as (args: string[]) => Promise<{ stdout: string }>),
            { steps: fakeSteps().sink }
        ).run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const calls = exec.mock.calls.map((call) => call[0]);
        // The fence is the runner's, not the services feature's, so its label and network
        // sweeps still run — but nothing services-specific happens: no readout, no network
        // create, no service containers, byte-identical runner argv. The one `--entrypoint`
        // run allowed is the close-time claude-code turn read, which is the runner's own.
        expect(calls.every((a) => !(a[0] === 'network' && a[1] === 'create'))).toBe(true);
        expect(calls.every((a) => !isServiceRun(a))).toBe(true);
        expect(
            calls.every(
                (a) =>
                    !(a[0] === 'run' && a.includes('--entrypoint')) ||
                    a.some((x) => typeof x === 'string' && x.startsWith('CLAUDE_TRANSCRIPT_DIR='))
            )
        ).toBe(true);
        expect(seen[0]).toEqual(['start', '-a', containerName(job)]);
        expect(calls.find((a) => a[0] === 'create' && a.includes(containerName(job)))).toEqual(
            dockerArgs(cfg, job, { id: SESSION, resume: false }, { envFile: envFilePath(job) })
        );
    });

    it('reports a declared service that vanished from docker ps as dead (issue #471)', async () => {
        const base = daemon();
        let removedByHand = false;
        const exec = vitest.fn(async (args: string[]) =>
            removedByHand && args[0] === 'ps' ? { stdout: '' } : base(args)
        ) as unknown as ReturnType<typeof daemon>;
        const { fn } = spawnRecording('', 0);
        const runner = servicesRunner(exec, fn);
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        removedByHand = true; // `docker rm -f` of the stub service, between the run and the gates
        const dead = await runner.deadServices(job);
        expect(dead).toMatchObject([
            { name: 'stub', state: 'missing', exitCode: null, reason: 'container removed', logTail: '' },
        ]);

        // The attempt's teardown ends the declaration: nothing is expected of a released fleet.
        await runner.releaseServices(job);
        expect(await runner.deadServices(job)).toEqual([]);
    });

    const runningStub = JSON.stringify({ Labels: 'factory.service=stub', Image: 'stub-svc:1', State: 'running' });

    // Issues #560, #773 (R1-4): the restart is the fleet's — the healthy sibling re-runs too — into
    // the same namespace, whose hosts file still names every service on loopback.
    it('restartServices re-runs every service, a healthy sibling too, in the group’s namespace', async () => {
        const DB: ServiceSpec = { name: 'db', image: 'postgres:17', environment: [] };
        const fleet: BoardJob = { ...job, services: [STUB, DB] };
        const base = daemon();
        let removedByHand = false;
        const both = [
            runningStub,
            JSON.stringify({ Labels: 'factory.service=db', Image: 'postgres:17', State: 'running' }),
        ].join('\n');
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) removedByHand = false;
            if (args[0] === 'ps' && args.includes('{{json .}}')) return { stdout: removedByHand ? '' : both };
            return base(args);
        }) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        await runner.run(fleet, { id: SESSION, resume: false });
        removedByHand = true;
        const before = exec.mock.calls.length;

        await runner.restartServices(fleet, live);

        const calls = exec.mock.calls.slice(before).map((call) => call[0]);
        expect(calls.slice(0, 4)).toEqual([
            ['rm', '-f', serviceContainerName(fleet, 'stub')],
            serviceRunArgs(fleet, STUB, supervisorName(fleet), BOARD),
            ['rm', '-f', serviceContainerName(fleet, 'db')],
            serviceRunArgs(fleet, DB, supervisorName(fleet), BOARD),
        ]);
        expect(calls.some((a) => a[0] === 'network')).toBe(false);
        expect(await runner.deadServices(fleet)).toEqual([]);

        await runner.releaseServices(fleet);
        forgetDeclaredServices(fleet);
    });

    it('restartServices stops on a stand-down and removes the service it started again (issue #560)', async () => {
        const base = daemon();
        const stand = new AbortController();
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args) && stand.signal.aborted === false) {
                // The Stop lands while the replacement is being started.
                const answer = await base(args);
                stand.abort();
                return answer;
            }
            if (args[0] === 'ps' && args.includes('{{json .}}')) return { stdout: '' };
            return base(args);
        }) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        await runner.run(job, { id: SESSION, resume: false });
        const before = exec.mock.calls.length;

        await expect(runner.restartServices(job, stand.signal)).rejects.toThrow(
            'the restart was abandoned: the attempt stood down'
        );
        const calls = exec.mock.calls.slice(before).map((call) => call[0]);
        expect(calls.at(-1)).toEqual(['rm', '-f', serviceContainerName(job, 'stub')]);
        expect(calls.some((a) => a[0] === 'ps')).toBe(false);
    });

    it('restartServices ends a pending readiness listing on the stand-down (#869)', async () => {
        const base = daemon();
        const exec = vitest.fn(async (args: string[], options?: { signal?: AbortSignal }) =>
            args[0] === 'ps' && args.includes('{{json .}}') ? hangsUntilAborted(options) : base(args)
        ) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        await runner.run(job, { id: SESSION, resume: false });
        const stand = new AbortController();
        const before = exec.mock.calls.length;

        const pending = runner.restartServices(job, stand.signal);
        await vitest.waitFor(() =>
            expect(exec.mock.calls.slice(before).some((call) => call[0]![0] === 'ps')).toBe(true)
        );
        stand.abort();
        expect(await endsSoon(pending)).toBe(true);
        await runner.releaseServices(job);
    });

    it.each(['rm', 'run'])('restartServices ends a stalled %s by the restart’s deadline (#869)', async (stalled) => {
        const base = daemon();
        let stall = false;
        const exec = vitest.fn(async (args: string[], options?: { timeout?: number }) =>
            stall && args[0] === stalled && (stalled === 'rm' || isServiceRun(args))
                ? hangsUntilTimeout(options)
                : base(args)
        ) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        await runner.run(job, { id: SESSION, resume: false });
        stall = true;
        vitest.useFakeTimers();
        try {
            let ended = false;
            const restarting = runner.restartServices(job, new AbortController().signal);
            restarting.then(
                () => (ended = true),
                () => (ended = true)
            );

            await vitest.advanceTimersByTimeAsync(SERVICE_RESTART_TIMEOUT_MS + 1_000);

            expect(ended).toBe(true);
        } finally {
            vitest.useRealTimers();
        }
        stall = false;
        await runner.releaseServices(job);
    });

    // #869: the first call of each kind an attempt makes stalls; none holds the attempt past its command deadline.
    it.each([
        ['the re-claim fence listing', (args: string[]) => args[0] === 'ps' && args.includes('--format')],
        ['the group create', (args: string[]) => args[0] === 'create'],
        ['the group start', (args: string[]) => args[0] === 'start'],
        ['the service creation', (args: string[]) => isServiceRun(args)],
    ])('ends a stalled %s by the attempt’s command deadline (#869)', async (_name, hang) => {
        const base = daemon();
        let stalled = false;
        const exec = vitest.fn(async (args: string[], options?: { timeout?: number }) => {
            if (!stalled && hang(args)) {
                stalled = true;
                return hangsUntilTimeout(options);
            }
            return base(args);
        }) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        vitest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        try {
            let ended = false;
            const running = runner.run(job, { id: SESSION, resume: false });
            running.then(
                () => (ended = true),
                () => (ended = true)
            );
            // No call on this path touches the disk (memoryFiles): the run reaches the stalled one in microtasks.
            await vitest.advanceTimersByTimeAsync(0);
            expect(stalled).toBe(true);

            await vitest.advanceTimersByTimeAsync(ATTEMPT_COMMAND_TIMEOUT_MS + 1_000);

            expect(ended).toBe(true);
        } finally {
            vitest.useRealTimers();
        }
    });

    it('ends a stalled vitals sample by the attempt’s command deadline (#869)', async () => {
        const exec = vitest.fn((_args: string[], options?: { timeout?: number }) =>
            hangsUntilTimeout(options)
        ) as unknown as ReturnType<typeof daemon>;
        vitest.useFakeTimers();
        try {
            let ended = false;
            const sampling = servicesRunner(exec, spawnRecording('', 0).fn).sampleRuntime(job);
            sampling.then(
                () => (ended = true),
                () => (ended = true)
            );

            // The stats read, then the fleet read: each ends by its own deadline.
            await vitest.advanceTimersByTimeAsync(2 * ATTEMPT_COMMAND_TIMEOUT_MS + 1_000);

            expect(ended).toBe(true);
        } finally {
            vitest.useRealTimers();
        }
    });

    it('ends a stalled group create when the attempt is killed (#869)', async () => {
        const base = daemon();
        let stalled = false;
        const exec = vitest.fn(async (args: string[], options?: { signal?: AbortSignal }) => {
            if (!stalled && args[0] === 'create') {
                stalled = true;
                return hangsUntilAborted(options);
            }
            return base(args);
        }) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);

        const running = runner.run(job, { id: SESSION, resume: false });
        await vitest.waitFor(() => expect(stalled).toBe(true));
        await runner.kill(job);

        expect(await endsSoon(running)).toBe(true);
    });

    it('restartServices throws when the daemon refuses the service again (issue #560)', async () => {
        const base = daemon();
        let refuse = false;
        const exec = vitest.fn(async (args: string[]) => {
            if (refuse && isServiceRun(args)) throw new Error('no such network');
            return base(args);
        }) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        await runner.run(job, { id: SESSION, resume: false });
        refuse = true;

        await expect(runner.restartServices(job, live)).rejects.toThrow(
            'could not start service "stub": no such network'
        );

        await runner.releaseServices(job);
    });
});
