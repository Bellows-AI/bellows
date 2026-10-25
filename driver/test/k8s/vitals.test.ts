import { describe, expect, it } from 'vitest';
import { AGENT_CONTAINER } from '../../src/supervisor-contract.js';
import type { BoardJob } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import { Inconclusive } from '../../src/runner.js';
import type { K8sDeps, K8sRequest, K8sResponse } from '../../src/k8s/k8s-transport.js';
import { parsePodMetrics } from '../../src/k8s/k8s-transport.js';
import { readImagePullStatus } from '../../src/k8s/k8s-poll.js';
import { jobsPath, runnerJobName, runnerJobSpec } from '../../src/k8s/k8s-podspec.js';
import { jobPath } from '../../src/k8s/k8s-auxspec.js';
import { readSidecars, sidecarStatuses } from '../../src/k8s/k8s-services.js';
import type { Call } from '../fixtures/k8s-apiserver.js';
import {
    SUPERVISED,
    job,
    SESSION,
    gatedOf,
    namespace,
    podName,
    fakeRequest,
    routed,
    runner,
} from '../fixtures/k8s-suite.js';

/*
 * The runner vitals under kubernetes: the metrics API is the docker stats twin, read from the
 * runner's own pod — and null, never an error, whenever there is nothing to read (no pod yet,
 * no metrics-server in the cluster, a body that is not metrics).
 */
describe('the agent container start proof (issue #845)', () => {
    const base = fakeRequest();
    /** A runner whose pod listing answers `statuses`: the only thing the proof may read. */
    const withStatuses = (containerStatuses: unknown[]) =>
        runner((method, path, body) =>
            method === 'GET' && /\/pods\?/.test(path)
                ? Promise.resolve({
                      status: 200,
                      body: JSON.stringify({
                          items: [{ metadata: { name: podName }, status: { phase: 'Running', containerStatuses } }],
                      }),
                  })
                : base.request(method, path, body)
        );
    const sidecarsUp = { name: 'svc-db', state: { running: { startedAt: '2026-10-25T07:00:00Z' } } };

    it('is no proof while the agent waits on its image, however healthy the sidecars are', async () => {
        const waiting = { name: AGENT_CONTAINER, state: { waiting: { reason: 'ImagePullBackOff' } } };
        expect(await withStatuses([sidecarsUp, waiting]).agentStarted(job)).toBe(false);
    });

    it('is proof once the agent container runs, or ended having started', async () => {
        const running = { name: AGENT_CONTAINER, state: { running: { startedAt: '2026-10-25T07:00:00Z' } } };
        const ended = {
            name: AGENT_CONTAINER,
            state: { terminated: { exitCode: 0, startedAt: '2026-10-25T07:00:00Z' } },
        };
        const neverStarted = { name: AGENT_CONTAINER, state: { terminated: { exitCode: 128, reason: 'StartError' } } };
        expect(await withStatuses([sidecarsUp, running]).agentStarted(job)).toBe(true);
        expect(await withStatuses([ended]).agentStarted(job)).toBe(true);
        expect(await withStatuses([neverStarted]).agentStarted(job)).toBe(false);
    });

    it('answers false, never an error, when the pod cannot be read', async () => {
        const broken = runner(() => Promise.reject(new Error('apiserver down')));
        expect(await broken.agentStarted(job)).toBe(false);
    });
});

describe('the runner vitals', () => {
    it('parses the PodMetrics object the metrics API answers', () => {
        expect(parsePodMetrics(JSON.stringify({ containers: [{ usage: { cpu: '250m', memory: '150Mi' } }] }))).toEqual({
            cpuPercent: 25,
            memUsedMb: 150,
            memPercent: null,
        });
        // Nanocores and plain bytes — the other spellings metrics-server emits.
        expect(
            parsePodMetrics(JSON.stringify({ containers: [{ usage: { cpu: '1250000n', memory: '5368709120' } }] }))
        ).toEqual({ cpuPercent: 0.125, memUsedMb: 5120, memPercent: null });
        // Whole cores and binary memory sizes.
        expect(parsePodMetrics(JSON.stringify({ containers: [{ usage: { cpu: '1.5', memory: '2Gi' } }] }))).toEqual({
            cpuPercent: 150,
            memUsedMb: 2048,
            memPercent: null,
        });
        expect(parsePodMetrics('')).toBeNull();
        expect(parsePodMetrics('null')).toBeNull();
        expect(parsePodMetrics('{"containers":[]}')).toBeNull();
        expect(
            parsePodMetrics(JSON.stringify({ containers: [{ usage: { cpu: 'busy', memory: '150Mi' } }] }))
        ).toBeNull();
    });

    it('samples through the metrics API, and answers null when the cluster runs no metrics-server', async () => {
        const base = fakeRequest();
        const withMetrics: K8sRequest = (method, path, body) => {
            if (path === `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods/${podName}`) {
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({ containers: [{ usage: { cpu: '310m', memory: '96Mi' } }] }),
                });
            }
            return base.request(method, path, body);
        };
        expect(await runner(withMetrics).sampleRuntime(job)).toEqual({
            cpuPercent: 31,
            memUsedMb: 96,
            memPercent: null,
        });

        const noMetricsServer: K8sRequest = (method, path, body) => {
            if (path.startsWith('/apis/metrics.k8s.io/'))
                return Promise.resolve({ status: 404, body: 'no metrics-server' });
            return base.request(method, path, body);
        };
        expect(await runner(noMetricsServer).sampleRuntime(job)).toBeNull();
    });

    /**
     * The attempt's services ride the same sample (issue #60), read off the task pod's own sidecar
     * statuses (issue #773). THE kubernetes regression this exists for: a cluster with no
     * metrics-server (kind, for one) must not silence them — the sample carries null vitals beside
     * real service states rather than skipping the flush. A job that declared nothing reports
     * exactly what it reported before.
     */
    it('reports the service sidecars beside the vitals, with or without them', async () => {
        const declared: BoardJob = { ...job, services: [{ name: 'db', image: 'postgres:16', environment: [] }] };
        const pods = routed((method, path) =>
            method === 'GET' && decodeURIComponent(path).includes('job-name=')
                ? {
                      status: 200,
                      body: JSON.stringify({
                          items: [
                              {
                                  metadata: { name: podName },
                                  status: { initContainerStatuses: [{ name: 'svc-db', state: { running: {} } }] },
                              },
                          ],
                      }),
                  }
                : undefined
        );
        const withMetrics =
            (metrics: K8sResponse): K8sRequest =>
            (method, path, body) =>
                path.startsWith('/apis/metrics.k8s.io/') ? Promise.resolve(metrics) : pods.request(method, path, body);
        const metricsBody = {
            status: 200,
            body: JSON.stringify({ containers: [{ usage: { cpu: '310m', memory: '96Mi' } }] }),
        };
        const services = [{ name: 'db', image: 'postgres:16', state: 'running' }];

        expect(await runner(withMetrics(metricsBody), { RUNNER_SERVICES: '1' }).sampleRuntime(declared)).toEqual({
            cpuPercent: 31,
            memUsedMb: 96,
            memPercent: null,
            services,
        });
        // No metrics-server: the services still report, the numbers go honestly null.
        const noServer = withMetrics({ status: 404, body: 'no metrics-server' });
        expect(await runner(noServer, { RUNNER_SERVICES: '1' }).sampleRuntime(declared)).toEqual({
            cpuPercent: null,
            memUsedMb: null,
            memPercent: null,
            services,
        });
        // Nothing declared, or services off: no key, and without metrics nothing to report at all.
        expect(await runner(noServer, { RUNNER_SERVICES: '1' }).sampleRuntime(job)).toBeNull();
        expect(await runner(withMetrics(metricsBody)).sampleRuntime(declared)).toEqual({
            cpuPercent: 31,
            memUsedMb: 96,
            memPercent: null,
        });
    });

    describe('a pod list read as a typed answer (#869)', () => {
        const declared: BoardJob = { ...job, services: [{ name: 'db', image: 'postgres:16', environment: [] }] };
        const depsFor = (body: string): K8sDeps => ({
            request: async () => ({ status: 200, body }),
            sleep: async () => {},
            config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '1' }),
        });
        const listing = (init: unknown[], containers: unknown[] = []): string =>
            JSON.stringify({
                items: [
                    {
                        metadata: { name: podName },
                        status: { initContainerStatuses: init, containerStatuses: containers },
                    },
                ],
            });

        it('reads a 200 null pod list as unread, never as no pod', async () => {
            expect((await readImagePullStatus(depsFor('null'), 'factory-runner-x')).podState).toBe('unread');
        });

        it('reads a pod whose sidecar names an image that is not a string as unread, with no refusal', async () => {
            const held = {
                name: 'svc-db',
                image: 42,
                state: { waiting: { reason: 'ImagePullBackOff', message: 'no' } },
            };
            const read = await readImagePullStatus(depsFor(listing([held])), 'factory-runner-x');
            expect(read).toMatchObject({ podState: 'unread', blocked: null, held: null });
            held.image = 'postgres:16' as unknown as number;
            expect(await readImagePullStatus(depsFor(listing([held])), 'factory-runner-x')).toMatchObject({
                podState: 'starting',
                held: { image: 'postgres:16' },
            });
        });

        it.each([
            ['a terminated state without an exit code', { name: 'svc-db', state: { terminated: {} } }],
            ['a restart count below zero', { name: 'svc-db', state: { running: {} }, restartCount: -1 }],
            ['a restart count that is a fraction', { name: 'svc-db', state: { running: {} }, restartCount: 1.5 }],
            [
                'a previous ending without an exit code',
                { name: 'svc-db', state: { running: {} }, lastState: { terminated: {} } },
            ],
        ])('reads a sidecar with %s as Inconclusive, never as a service failure', async (_name, sidecar) => {
            await expect(readSidecars(depsFor(listing([sidecar])), declared)).rejects.toBeInstanceOf(Inconclusive);
            const ended = { name: 'svc-db', state: { terminated: { exitCode: 3 } } };
            expect((await readSidecars(depsFor(listing([ended])), declared))[0]?.state).toBe('exited');
        });

        it('reads a null task pod list as Inconclusive', async () => {
            await expect(readSidecars(depsFor('null'), declared)).rejects.toBeInstanceOf(Inconclusive);
        });

        it('samples no runtime and resizes nothing over a pod list that is null', async () => {
            const nulled = routed((method, path) =>
                method === 'GET' && decodeURIComponent(path).includes('job-name=')
                    ? { status: 200, body: 'null' }
                    : undefined
            );
            expect(await runner(nulled.request).sampleRuntime(job)).toBeNull();
            const gated: BoardJob = { ...gatedOf(job), ...SUPERVISED };
            expect(await runner(nulled.request).resizeGate(gated, 'verify')).toBe(false);
            expect(nulled.calls.some((call) => call.method === 'PATCH')).toBe(false);
        });
    });

    describe('sidecarStatuses (issue #773 D8)', () => {
        const specs = ['up', 'ended', 'looping', 'unpullable', 'creating', 'unlisted'].map((name) => ({
            name,
            image: `${name}:1`,
            environment: [],
        }));
        const pod = {
            status: {
                initContainerStatuses: [
                    { name: 'gate', state: { running: {} } },
                    { name: 'svc-up', state: { running: {} }, restartCount: 2 },
                    { name: 'svc-ended', state: { terminated: { exitCode: 3, reason: 'Error', message: 'boom' } } },
                    {
                        name: 'svc-looping',
                        state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off' } },
                        restartCount: 4,
                        lastState: { terminated: { exitCode: 1, reason: 'Error' } },
                    },
                    {
                        name: 'svc-unpullable',
                        state: { waiting: { reason: 'ImagePullBackOff', message: 'no manifest' } },
                    },
                    { name: 'svc-creating', state: { waiting: { reason: 'ContainerCreating' } } },
                ],
            },
        };

        it('reads each declared service off its sidecar: running, exited for a reason waiting cannot cure, else pending', () => {
            expect(sidecarStatuses(pod, specs)).toEqual([
                { name: 'up', image: 'up:1', state: 'running', restartCount: 2, exitCode: null, ending: null },
                {
                    name: 'ended',
                    image: 'ended:1',
                    state: 'exited',
                    restartCount: 0,
                    exitCode: 3,
                    ending: 'Error: boom',
                },
                { name: 'looping', image: 'looping:1', state: 'exited', restartCount: 4, exitCode: 1, ending: 'Error' },
                {
                    name: 'unpullable',
                    image: 'unpullable:1',
                    state: 'exited',
                    restartCount: 0,
                    exitCode: null,
                    ending: 'ImagePullBackOff: no manifest',
                },
                {
                    name: 'creating',
                    image: 'creating:1',
                    state: 'pending',
                    restartCount: 0,
                    exitCode: null,
                    ending: null,
                },
                {
                    name: 'unlisted',
                    image: 'unlisted:1',
                    state: 'pending',
                    restartCount: 0,
                    exitCode: null,
                    ending: null,
                },
            ]);
        });
    });
});

describe('the kubernetes runner and the task supervisor', () => {
    const exporting: BoardJob = {
        ...job,
        ...SUPERVISED,
    };
    const containersOf = (body: unknown): string[] =>
        (body as ReturnType<typeof runnerJobSpec>).spec.template.spec.containers.map((c) => c.name);
    const jobBodies = (calls: Call[]) =>
        calls.filter((call) => call.method === 'POST' && call.path === jobsPath(namespace)).map((c) => c.body);

    it('runs the supervisor, the agent and the exporter as one pod — no exporter Job beside it', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).run(exporting, { id: SESSION, resume: false });
        const names = jobBodies(calls).map((body) => (body as { metadata: { name: string } }).metadata.name);
        expect(names[0]).toBe(runnerJobName(exporting));
        expect(names.some((name) => name.startsWith('factory-cexport-'))).toBe(false);
        expect(containersOf(jobBodies(calls)[0]).sort()).toEqual(['agent', 'exporter', 'supervisor']);
        // Nothing deletes the pod while the supervisor drains: the pod ends once it has finalized.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(runnerJobName(exporting)))).toBe(
            false
        );
    });

    // A run submits its steps over the control channel, so no run goes without one; the spec is
    // still pinned for a claim that carries none: the supervisor stays, the exporter is dropped.
    it('keeps the supervisor, and drops only the exporter, for a claim with no control endpoint', () => {
        const { supervisorEnv: _none, ...unsupervised } = job;
        const spec = runnerJobSpec(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
            unsupervised,
            { id: SESSION, resume: false }
        );
        expect(containersOf(spec).sort()).toEqual(['agent', 'supervisor']);
    });

    it('keeps the supervisor’s control pair in the attempt Secret and out of the agent’s env', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).run(exporting, { id: SESSION, resume: false });
        const secret = calls.find((call) => call.method === 'POST' && call.path.endsWith('/secrets'))!;
        const data = JSON.stringify(secret.body);
        expect(data).toContain('tok-supervisor');
        const pod = jobBodies(calls)[0] as ReturnType<typeof runnerJobSpec>;
        const agent = pod.spec.template.spec.containers.find((c) => c.name === 'agent')!;
        expect(JSON.stringify(agent)).not.toMatch(/SUPERVISOR_CONTROL/);
        expect(JSON.stringify(agent.volumeMounts)).not.toMatch(/ctl-supervisor|ctl-export/);
    });

    it('kill deletes the whole pod: the agent, the supervisor and the exporter go together', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).kill(exporting);
        const deleted = calls.filter((call) => call.method === 'DELETE').map((call) => call.path ?? '');
        expect(deleted.some((path) => path.includes(runnerJobName(exporting)))).toBe(true);
    });

    // The loop raised the kill order; the supervisor ends the agent, drains the exporter and
    // finalizes, so the pod ends by itself — a stop that waits is not a delete.
    it('stopAgent waits for the supervisor to finalize and deletes nothing once the pod is done', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).stopAgent(exporting);
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(runnerJobName(exporting)))).toBe(
            false
        );
    });

    it('stopAgent falls back to deleting the pod when the supervisor never finishes', async () => {
        const { request, calls } = fakeRequest({
            job: { status: 200, body: JSON.stringify({ status: { active: 1 } }) },
        });
        await runner(request).stopAgent(exporting);
        expect(calls).toContainEqual(
            expect.objectContaining({
                method: 'DELETE',
                path: expect.stringContaining(jobPath(namespace, runnerJobName(exporting))),
            })
        );
    });

    it('a refused Job fails the run as infrastructure, with no second Job left over', async () => {
        const { request, calls } = fakeRequest({
            create: { status: 403, body: 'forbidden' },
        });
        await expect(runner(request).run(exporting, { id: SESSION, resume: false })).rejects.toThrow();
        expect(jobBodies(calls)).toHaveLength(1);
    });
});
