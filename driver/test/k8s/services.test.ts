import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { type DriverConfig, loadDriverConfig } from '../../src/config.js';
import {
    AGENT_CONTAINER,
    SERVICE_GENERATIONS,
    SERVICE_NOT_ACKED_EXIT,
    type StepRequest,
    type StepResult,
} from '../../src/supervisor-contract.js';
import { StepChannelClosed, type StepSink } from '../../src/step-control.js';
import { serviceProbeArgv, serviceRestartArgv } from '../../src/container-scripts.js';
import { Inconclusive, SERVICE_LOG_TAIL_LINES } from '../../src/runner.js';
import type { K8sRequest, K8sResponse } from '../../src/k8s/k8s-transport.js';
import { jobsPath, runnerJobName, runnerJobSpec } from '../../src/k8s/k8s-podspec.js';
import { podLogPath } from '../../src/k8s/k8s-auxspec.js';
import { KUBELET_RESTART_NOTE } from '../../src/k8s/k8s-services.js';
import { ServicesNotRunning } from '../../src/service-restart.js';
import type { ServiceSpec } from '../../src/services.js';
import {
    SUPERVISED,
    job,
    SESSION,
    gatedOf,
    namespace,
    podName,
    routed,
    stepOk,
    defaultStepAnswer,
    fakeSteps,
    runner,
    NEW_TOKEN,
} from '../fixtures/k8s-suite.js';

/** The suite's job with no services on the claim, for the block below that shadows `job`. */
const baseJob = job;

// ==============================================================================================
// Auxiliary services under kubernetes: a native sidecar of the task pod per declared service,
// reached on the pod's loopback by its declared name, alive for exactly the group.
// ==============================================================================================

describe('the service sidecars (issue #773)', () => {
    const servicesConfig = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '1' });
    const db: ServiceSpec = {
        name: 'db',
        image: 'postgres:17',
        environment: [{ key: 'POSTGRES_PASSWORD', value: 'local' }],
        user: { uid: 999, gid: 999 },
    };
    const cache: ServiceSpec = { name: 'cache', image: 'redis', environment: [] };
    const declared: BoardJob = { ...gatedOf(job), ...SUPERVISED, services: [db, cache] };
    const podOf = (of: BoardJob, config: DriverConfig = servicesConfig) =>
        runnerJobSpec(config, of, { id: SESSION, resume: false }).spec.template.spec;
    const sidecarOf = (name: string, of: BoardJob = declared) => {
        const sidecar = podOf(of).initContainers?.find((container) => container.name === `svc-${name}`);
        if (!sidecar) throw new Error(`no svc-${name} sidecar`);
        return sidecar;
    };

    // Every init container starts, in order, before the main containers: no order spares the
    // supervisor a sidecar that never starts, so the gate leads and the services follow as declared.
    it('runs each declared service as a native sidecar after the gate, before the main containers', () => {
        expect(podOf(declared).initContainers?.map((container) => container.name)).toEqual([
            'gate',
            'svc-db',
            'svc-cache',
        ]);
        expect(sidecarOf('db')).toMatchObject({
            image: 'postgres:17',
            imagePullPolicy: 'IfNotPresent',
            restartPolicy: 'Always',
            env: [{ name: 'POSTGRES_PASSWORD', value: 'local' }],
        });
        const { gates: _gates, ...ungated } = declared;
        expect(podOf(ungated).initContainers?.map((container) => container.name)).toEqual(['svc-db', 'svc-cache']);
    });

    it('runs a service as its declared uid:gid with every capability dropped, and one that declared none as its image does', () => {
        expect(sidecarOf('db').securityContext).toEqual({
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
            runAsNonRoot: true,
            runAsUser: 999,
            runAsGroup: 999,
        });
        expect(sidecarOf('cache').securityContext).toEqual({
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
        });
    });

    // R2-4: the sidecar reads the generations and speaks for itself alone; it mounts no worktree.
    it('mounts the generations read-only and its own acknowledgement volume, and nothing of the task', () => {
        expect(sidecarOf('db').volumeMounts).toEqual([
            { name: SERVICE_GENERATIONS.volume, mountPath: SERVICE_GENERATIONS.path, readOnly: true },
            { name: 'svc-ack-db', mountPath: SERVICE_GENERATIONS.ackPath },
        ]);
    });

    it('probes liveness with the generation probe every two seconds, failing at the first miss', () => {
        expect(sidecarOf('cache').livenessProbe).toEqual({
            exec: { command: serviceProbeArgv('cache') },
            periodSeconds: 2,
            failureThreshold: 1,
        });
    });

    it('gives the supervisor the generations and every acknowledgement, and no other container any of them', () => {
        const pod = podOf(declared);
        const supervisor = pod.containers.find((container) => container.name === 'supervisor')!;
        expect(supervisor.volumeMounts).toEqual(
            expect.arrayContaining([
                { name: SERVICE_GENERATIONS.volume, mountPath: SERVICE_GENERATIONS.path },
                { name: 'svc-ack-db', mountPath: `${SERVICE_GENERATIONS.ackRoot}/db` },
                { name: 'svc-ack-cache', mountPath: `${SERVICE_GENERATIONS.ackRoot}/cache` },
            ])
        );
        for (const container of [...pod.containers, ...(pod.initContainers ?? [])]) {
            if (container.name === 'supervisor' || container.name.startsWith('svc-')) continue;
            expect(JSON.stringify(container.volumeMounts), container.name).not.toMatch(/ctl-services|svc-ack-/);
        }
        for (const name of [SERVICE_GENERATIONS.volume, 'svc-ack-db', 'svc-ack-cache']) {
            expect(pod.volumes).toContainEqual({ name, emptyDir: {} });
        }
    });

    // The whole feature: `postgres://db:5432` from the agent and the gate reaches the sidecar on the
    // pod's own loopback. No DNS search domain, no headless Service, no subdomain.
    it('maps every declared name to 127.0.0.1 in the pod, with no search domain and no subdomain', () => {
        const pod = podOf(declared);
        expect(pod.hostAliases).toEqual([{ ip: '127.0.0.1', hostnames: ['db', 'cache'] }]);
        expect(pod).not.toHaveProperty('dnsConfig');
        expect(pod).not.toHaveProperty('subdomain');
        expect(pod).not.toHaveProperty('hostname');
    });

    it('specs no sidecar, alias or generation volume when services are off or none are declared', () => {
        const off = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
        const { services: _services, ...plain } = declared;
        for (const pod of [podOf(declared, off), podOf(plain)]) {
            expect(pod.initContainers?.map((container) => container.name)).toEqual(['gate']);
            expect(pod).not.toHaveProperty('hostAliases');
            expect(JSON.stringify(pod.volumes)).not.toMatch(/ctl-services|svc-ack-/);
        }
    });

    // D11: the adopted run's group (made on demand, no agent) still serves its services' gates.
    it('specs the agentless group of an adopted run with the services', () => {
        expect(sidecarOf('db', { ...declared, agent: false }).name).toBe('svc-db');
    });

    it('refuses a service env key that is not a name, before the spec exists', () => {
        const bad = { ...declared, services: [{ ...cache, environment: [{ key: 'not a key', value: 'x' }] }] };
        expect(() => podOf(bad)).toThrow(/not a valid environment variable name/);
    });
});

describe('the kubernetes services flow (issue #773)', () => {
    // Issue #769: the services ride on the claim — this block's `job` declares the one `cache` service.
    const CACHE: ServiceSpec = { name: 'cache', image: 'redis', environment: [] };
    const DB: ServiceSpec = { name: 'db', image: 'postgres:17', environment: [] };
    const job: BoardJob = { ...baseJob, repo: 'Bellows-AI/bellows', services: [CACHE] };
    const fleet: BoardJob = { ...job, services: [DB, CACHE] };
    /** A restart's stand-down signal that never fires. */
    const live = new AbortController().signal;

    type Sidecar = { state: Record<string, unknown>; restartCount: number; lastState?: Record<string, unknown> };
    const running = (restartCount = 0, lastState?: Record<string, unknown>): Sidecar => ({
        state: { running: { startedAt: '2026-10-19T00:00:00Z' } },
        restartCount,
        ...(lastState ? { lastState } : {}),
    });

    /**
     * The task pod as the kubelet reports it: `sidecars` is read on every listing (a test moves it
     * on), `list` overrides the answer outright. Every other route is fakeRequest's.
     */
    const podFake = (sidecars: Record<string, Sidecar>, list?: () => K8sResponse | undefined) =>
        routed((method, path) => {
            if (method !== 'GET' || !decodeURIComponent(path).includes('job-name=')) return;
            const scripted = list?.();
            if (scripted) return scripted;
            const initContainerStatuses = Object.entries(sidecars).map(([name, sidecar]) => ({
                name: `svc-${name}`,
                image: 'redis',
                ...sidecar,
            }));
            return {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName },
                            status: {
                                phase: 'Succeeded',
                                initContainerStatuses,
                                containerStatuses: [{ name: AGENT_CONTAINER, state: { terminated: { exitCode: 0 } } }],
                            },
                        },
                    ],
                }),
            };
        });

    /** The supervisor's answers to the `restart` steps: `acked` and `bump` scripted, every other step the default. */
    const restartSteps = (
        answer: { acked?: (names: string[]) => StepResult; bump?: (names: string[]) => StepResult } = {}
    ) =>
        fakeSteps((step) => {
            if (step.kind !== 'restart') return defaultStepAnswer(step);
            const [mode, , , ...names] = step.argv.slice(4);
            return (mode === 'bump' ? answer.bump : answer.acked)?.(names) ?? stepOk();
        });
    const modes = (steps: { submitted: StepRequest[] }) =>
        steps.submitted.filter((step) => step.kind === 'restart').map((step) => step.argv[4]);
    const notAcked = (...names: string[]): StepResult => ({
        exitCode: SERVICE_NOT_ACKED_EXIT,
        stdout: names.map((name) => `${name}\n`).join(''),
        stderr: '',
        timedOut: false,
    });
    const servicesOn = { RUNNER_SERVICES: '1' };
    const SESSION_RUN = { id: SESSION, resume: false };

    it('starts the services with the group the sync made, answering once every sidecar runs and acknowledged', async () => {
        const sidecars: Record<string, Sidecar> = {
            cache: { state: { waiting: { reason: 'PodInitializing' } }, restartCount: 0 },
        };
        const api = podFake(sidecars);
        let reads = 0;
        const steps = restartSteps({
            acked: (names) => {
                reads += 1;
                return reads === 1 ? notAcked(...names) : stepOk();
            },
        });
        const k8s = runner(api.request, servicesOn, undefined, steps.sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        const listed = api.calls.length;
        sidecars.cache = running();

        expect(await k8s.startServices(job)).toBeNull();

        expect(modes(steps)).toEqual(['acked', 'acked']);
        expect(steps.submitted.find((step) => step.kind === 'restart')?.argv).toEqual(
            serviceRestartArgv('acked', ['cache'])
        );
        // Nothing is created for them: no pod, no Service, no Job beside the group's own.
        expect(api.calls.slice(listed).filter((call) => call.method !== 'GET')).toEqual([]);
        const posted = api.calls.filter((call) => call.method === 'POST').map((call) => call.path);
        expect(posted.some((path) => path.endsWith('/pods') || path.endsWith('/services'))).toBe(false);
    });

    // An adopted run synced nothing: its group is made now, the sidecars in it, and no agent.
    it('makes the group of an attempt that synced none, with its sidecars in it', async () => {
        const api = podFake({ cache: running() });
        const steps = restartSteps();
        expect(await runner(api.request, servicesOn, undefined, steps.sink).startServices(job)).toBeNull();
        const jobs = api.calls.filter((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        expect(jobs).toHaveLength(1);
        const pod = (jobs[0]!.body as ReturnType<typeof runnerJobSpec>).spec.template.spec;
        expect(pod.initContainers?.map((container) => container.name)).toEqual(['svc-cache']);
        expect(pod.containers.map((container) => container.name)).not.toContain('agent');
    });

    it('rejects with ServicesNotRunning, in the kubelet’s words, when a sidecar crash-loops before it is ready', async () => {
        const api = podFake({
            cache: {
                state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 40s' } },
                restartCount: 3,
                lastState: { terminated: { exitCode: 1, reason: 'Error' } },
            },
        });
        const k8s = runner(api.request, servicesOn, undefined, restartSteps().sink);
        const thrown = await k8s.startServices(job).catch((e: unknown) => e);
        expect(thrown).toBeInstanceOf(ServicesNotRunning);
        expect((thrown as Error).message).toBe(
            `service "cache" exited after the start (Error; ${KUBELET_RESTART_NOTE})`
        );
    });

    // R2-1: a pod that never answered proves nothing about its services.
    it('throws Inconclusive when the task pod cannot be read to the end of the budget', async () => {
        const api = podFake({ cache: running() });
        const steps = restartSteps();
        const k8s = runner(api.request, servicesOn, undefined, steps.sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        const broken = podFake({}, () => ({ status: 503, body: 'overloaded' }));
        const thrown = await runner(broken.request, servicesOn, undefined, steps.sink)
            .startServices({ ...job, leaseToken: NEW_TOKEN })
            .catch((e: unknown) => e);
        expect(thrown).toBeInstanceOf(Inconclusive);
        expect(thrown).not.toBeInstanceOf(ServicesNotRunning);
    });

    it('finds none dead while every sidecar runs at the count it was ready at', async () => {
        const api = podFake({ cache: running(2) });
        const k8s = runner(api.request, servicesOn, undefined, restartSteps().sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        await k8s.startServices(job);
        expect(await k8s.deadServices(job)).toEqual([]);
    });

    // D8: a liveness failure or a crash restarts a sidecar in place — running again, its restart count
    // past the baseline is the only trace, and its previous container's log the only evidence.
    it('reports a sidecar the kubelet restarted since it was ready, with its previous log and why', async () => {
        const sidecars: Record<string, Sidecar> = { cache: running() };
        const api = routed((method, path) => {
            if (method === 'GET' && path.includes(`/pods/${podName}/log?`)) {
                return { status: 200, body: `previous=${path.includes('previous=true')} ${path}` };
            }
        });
        const pods = podFake(sidecars);
        const request: K8sRequest = (method, path, body) =>
            path.includes(`/pods/${podName}/log?`) ? api.request(method, path, body) : pods.request(method, path, body);
        const k8s = runner(request, servicesOn, undefined, restartSteps().sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        await k8s.startServices(job);
        sidecars.cache = running(1, { terminated: { exitCode: 137, reason: 'OOMKilled' } });

        const [dead, ...rest] = await k8s.deadServices(job);
        expect(rest).toEqual([]);
        expect(dead).toEqual({
            name: 'cache',
            image: 'redis',
            state: 'restarted',
            exitCode: 137,
            reason: `OOMKilled; ${KUBELET_RESTART_NOTE}`,
            logTail: `previous=true ${podLogPath(namespace, podName, SERVICE_LOG_TAIL_LINES, 'svc-cache')}&previous=true`,
        });
    });

    it('reports a terminated sidecar dead, and infers no death from a pod it cannot read', async () => {
        const sidecars: Record<string, Sidecar> = { cache: running() };
        let broken = false;
        const api = podFake(sidecars, () => (broken ? { status: 500, body: '' } : undefined));
        const k8s = runner(api.request, servicesOn, undefined, restartSteps().sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        await k8s.startServices(job);
        sidecars.cache = { state: { terminated: { exitCode: 2, reason: 'Error' } }, restartCount: 0 };
        expect(await k8s.deadServices(job)).toMatchObject([{ name: 'cache', state: 'exited', exitCode: 2 }]);
        broken = true;
        await expect(k8s.deadServices(job)).rejects.toBeInstanceOf(Inconclusive);
    });

    // R1-4: a restart is the fleet's — the healthy sibling is bumped, restarted and reset too.
    it('restarts every declared service, a healthy sibling too, and resets the baseline for all', async () => {
        const sidecars: Record<string, Sidecar> = { db: running(), cache: running() };
        const api = podFake(sidecars);
        const bumped: string[][] = [];
        const steps = restartSteps({
            bump: (names) => {
                bumped.push(names);
                // The probes fail on the new generation: the kubelet restarts each sidecar once.
                sidecars.db = running(2);
                sidecars.cache = running(1);
                return stepOk();
            },
        });
        const k8s = runner(api.request, servicesOn, undefined, steps.sink);
        await k8s.syncCheckout(fleet, undefined, SESSION_RUN);
        await k8s.startServices(fleet);
        sidecars.db = running(1, { terminated: { exitCode: 1, reason: 'Error' } });
        expect((await k8s.deadServices(fleet)).map(({ name }) => name)).toEqual(['db']);

        await k8s.restartServices(fleet, live);

        expect(bumped).toEqual([['db', 'cache']]);
        expect(steps.submitted.find((step) => step.argv[4] === 'bump')?.argv).toEqual(
            serviceRestartArgv('bump', ['db', 'cache'])
        );
        expect(await k8s.deadServices(fleet)).toEqual([]);
    });

    // R2-4: a restart asked before a probe ever acknowledged waits for it, and only then bumps.
    it('waits for every service to acknowledge its generation before it bumps', async () => {
        const sidecars: Record<string, Sidecar> = { cache: running() };
        const api = podFake(sidecars);
        let bumps = 0;
        const steps = restartSteps({
            bump: () => {
                bumps += 1;
                if (bumps < 3) return notAcked('cache');
                sidecars.cache = running(1);
                return stepOk();
            },
        });
        const k8s = runner(api.request, servicesOn, undefined, steps.sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);

        await k8s.restartServices(job, live);

        expect(modes(steps).slice(0, 3)).toEqual(['bump', 'bump', 'bump']);
        expect(bumps).toBe(3);
    });

    it('fails naming a service that never acknowledges its generation, bumping nothing', async () => {
        const api = podFake({ cache: running() });
        const steps = restartSteps({ bump: () => notAcked('cache') });
        const k8s = runner(api.request, servicesOn, undefined, steps.sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        const thrown = await k8s.restartServices(job, live).catch((e: unknown) => e);
        expect(thrown).toBeInstanceOf(ServicesNotRunning);
        expect((thrown as Error).message).toBe('service "cache" never acknowledged its generation 300s on');
    });

    // #869: a bump nobody answered by the restart deadline proves nothing about the services.
    it('is inconclusive, not a services failure, when the bump goes unanswered until the restart deadline', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const api = podFake({ cache: running() });
            const steps = restartSteps();
            const sink: StepSink = {
                ...steps.sink,
                submit: async (token, step, signal) => {
                    if (step.kind === 'restart' && step.argv[4] === 'bump') {
                        vi.setSystemTime(Date.now() + 301_000);
                        throw new Error('the step was cancelled');
                    }
                    return steps.sink.submit(token, step, signal);
                },
            };
            const k8s = runner(api.request, servicesOn, undefined, sink);
            await k8s.syncCheckout(job, undefined, SESSION_RUN);
            await expect(k8s.restartServices(job, live)).rejects.toBeInstanceOf(Inconclusive);
        } finally {
            vi.useRealTimers();
        }
    });

    it('gives the pod read of a bump the time its budget has left, however slow the steps before it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const api = podFake({ cache: running() });
            const timeouts: (number | undefined)[] = [];
            const request: K8sRequest = (method, path, body, options) => {
                if (method === 'GET' && decodeURIComponent(path).includes('job-name='))
                    timeouts.push(options?.timeoutMs);
                return api.request(method, path, body, options);
            };
            let bumps = 0;
            const steps = restartSteps({
                bump: () => {
                    bumps += 1;
                    vi.setSystemTime(Date.now() + (bumps === 1 ? 299_000 : 2_000));
                    return notAcked('cache');
                },
            });
            const k8s = runner(request, servicesOn, undefined, steps.sink);
            await k8s.syncCheckout(job, undefined, SESSION_RUN);
            timeouts.length = 0;
            await expect(k8s.restartServices(job, live)).rejects.toBeInstanceOf(ServicesNotRunning);
            expect(timeouts[0]).toBeGreaterThan(0);
            expect(timeouts[1]).toBeLessThanOrEqual(1_000);
        } finally {
            vi.useRealTimers();
        }
    });

    it('fails naming a service that never restarts within the budget', async () => {
        const api = podFake({ cache: running() });
        const k8s = runner(api.request, servicesOn, undefined, restartSteps().sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        await expect(k8s.restartServices(job, live)).rejects.toThrow(
            'service "cache" not running 300s after the restart'
        );
    });

    it('fails naming one that restarts again on its way back up: it crashed', async () => {
        const sidecars: Record<string, Sidecar> = { cache: running() };
        const api = podFake(sidecars);
        const steps = restartSteps({
            bump: () => {
                sidecars.cache = {
                    state: { waiting: { reason: 'CrashLoopBackOff' } },
                    restartCount: 2,
                    lastState: { terminated: { exitCode: 1, reason: 'Error' } },
                };
                return stepOk();
            },
        });
        const k8s = runner(api.request, servicesOn, undefined, steps.sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        await expect(k8s.restartServices(job, live)).rejects.toBeInstanceOf(ServicesNotRunning);
    });

    // R2-1: a lost supervisor is the attempt's loss, thrown as it is for the loop to interrupt.
    it('throws a supervisor lost mid-restart as it is', async () => {
        const api = podFake({ cache: running() });
        const steps = fakeSteps((step) => {
            if (step.kind === 'restart') throw new StepChannelClosed('the service restart');
            return defaultStepAnswer(step);
        });
        const k8s = runner(api.request, servicesOn, undefined, steps.sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        await expect(k8s.restartServices(job, live)).rejects.toBeInstanceOf(StepChannelClosed);
    });

    it('bumps nothing once the attempt stood down', async () => {
        const api = podFake({ cache: running() });
        const steps = restartSteps();
        const k8s = runner(api.request, servicesOn, undefined, steps.sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        const stand = new AbortController();
        stand.abort();
        await expect(k8s.restartServices(job, stand.signal)).rejects.toThrow('the attempt stood down');
        expect(modes(steps)).toEqual([]);
    });

    it('samples the services off the task pod’s sidecars', async () => {
        const api = podFake({ cache: running() }, undefined);
        const k8s = runner(api.request, servicesOn, undefined, restartSteps().sink);
        const sample = await k8s.sampleRuntime(job);
        expect(sample?.services).toEqual([{ name: 'cache', image: 'redis', state: 'running' }]);
    });

    // The whole flow creates the one runner Job: the services are its pod's own sidecars.
    it('creates nothing but the runner Job and its Secret through a whole run with services', async () => {
        const api = podFake({ cache: running() });
        const k8s = runner(api.request, servicesOn, undefined, restartSteps().sink);
        await k8s.syncCheckout(job, undefined, { id: SESSION, resume: false });
        await k8s.startServices(job);
        expect((await k8s.run(job, { id: SESSION, resume: false })).exitCode).toBe(0);
        await k8s.releaseServices(job);
        const posts = api.calls.filter((call) => call.method === 'POST').map((call) => call.path);
        expect(posts.filter((path) => path.endsWith('/pods') || path.endsWith('/services'))).toEqual([]);
        const runnerJobs = api.calls.filter(
            (call) =>
                call.method === 'POST' &&
                call.path === jobsPath(namespace) &&
                (call.body as { metadata: { name: string } }).metadata.name === runnerJobName(job)
        );
        expect(runnerJobs).toHaveLength(1);
        expect(api.calls.some((call) => call.method === 'DELETE' && call.path.includes('/services'))).toBe(false);
    });

    it("reports a runner pod deleted mid-run as an infrastructure loss, not the agent's verdict (issue #560)", async () => {
        const api = podFake({ cache: running() });
        let vanished = false;
        const lost = routed((method, path) => {
            if (!vanished) return;
            if (method === 'GET' && path === `${jobsPath(namespace)}/${runnerJobName(job)}`) {
                return {
                    status: 200,
                    body: JSON.stringify({
                        status: {
                            failed: 1,
                            conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }],
                        },
                    }),
                };
            }
            if (method === 'GET' && decodeURIComponent(path).includes(`job-name=${runnerJobName(job)}`)) {
                return { status: 200, body: '{"items":[]}' };
            }
        });
        const request: K8sRequest = (method, path, body) =>
            vanished ? lost.request(method, path, body) : api.request(method, path, body);
        const k8s = runner(request, servicesOn, undefined, restartSteps().sink);
        await k8s.syncCheckout(job, undefined, { id: SESSION, resume: false });
        await k8s.startServices(job);
        vanished = true;

        expect(await k8s.run(job, { id: SESSION, resume: false })).toMatchObject({
            exitCode: null,
            started: true,
            infraLoss: 'the runner pod was deleted before it exited (evicted, drained or its node removed)',
        });
    });

    it('starts nothing and asks the supervisor nothing when the claim carries no services, or services are off', async () => {
        for (const [of, env] of [
            [{ ...job, services: [] }, servicesOn],
            [job, { RUNNER_SERVICES: '0' }],
        ] as const) {
            const api = podFake({});
            const steps = restartSteps();
            const k8s = runner(api.request, env, undefined, steps.sink);
            expect(await k8s.startServices(of)).toBeNull();
            expect(await k8s.deadServices(of)).toEqual([]);
            await k8s.restartServices(of, live);
            expect(steps.submitted).toEqual([]);
            expect(api.calls).toEqual([]);
        }
    });
});
