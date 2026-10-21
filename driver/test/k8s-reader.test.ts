/**
 * A finished group has no supervisor left to answer a step, so an adoption's close-time readouts run
 * as a one-shot reader Job over the task volume (#775). The Job is the readout's only holder of the
 * volume: the group's pod is terminal, which a ReadWriteOncePod claim does not count.
 */
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { readViaReaderJob } from '../src/k8s-reader.js';
import { jobsPath, runnerName } from '../src/k8s-podspec.js';
import { jobPodsPath } from '../src/k8s-auxspec.js';
import type { K8sDeps, K8sMethod, K8sResponse } from '../src/k8s-transport.js';
import { taskVolumeName } from '../src/task-volume.js';

const NS = 'factory';
const job = {
    id: '11111111-1111-4111-8111-111111111111',
    leaseToken: '22222222-2222-4222-8222-222222222222',
    executorType: 'claude-code',
    rootJobId: null,
} as unknown as BoardJob;
const readout = { name: 'claude-turns', argv: ['node', '-e', 'x'], env: { SESSION_ID: 's' }, timeoutMs: 5_000 };

const ok = (body: unknown): K8sResponse => ({ status: 200, body: JSON.stringify(body) });

function world(special: (method: K8sMethod, path: string) => K8sResponse | undefined = () => undefined) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    let name = '';
    const deps: K8sDeps = {
        sleep: async () => {},
        config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NS }),
        request: async (method, path, body) => {
            calls.push({ method, path, body });
            const special_ = special(method, path);
            if (special_) return special_;
            if (method === 'POST' && path === jobsPath(NS)) {
                name = (body as { metadata: { name: string } }).metadata.name;
                return { status: 201, body: '{}' };
            }
            if (method === 'GET' && path === `${jobsPath(NS)}/${name}`) return ok({ status: { succeeded: 1 } });
            if (method === 'GET' && path === jobPodsPath(NS, runnerName(job))) {
                return ok({ items: [{ metadata: { name: 'task-pod' }, status: { phase: 'Failed' } }] });
            }
            if (method === 'GET' && path.includes('/pods?')) {
                return ok({
                    items: [
                        {
                            metadata: { name: 'reader-pod' },
                            status: {
                                phase: 'Succeeded',
                                containerStatuses: [{ name: 'readout', state: { terminated: { exitCode: 0 } } }],
                            },
                        },
                    ],
                });
            }
            if (method === 'GET' && path.includes('/pods/reader-pod/log'))
                return { status: 200, body: '{"turns":4}\n' };
            if (method === 'DELETE') return { status: 200, body: '{}' };
            throw new Error(`unscripted ${method} ${path}`);
        },
    };
    return { deps, calls };
}

describe('the reader Job of an adopted finished group', () => {
    it('runs the readout over the task volume without a supervisor and answers its stdout', async () => {
        const { deps, calls } = world();
        const answered = await readViaReaderJob(deps, job, readout);
        expect(answered).toMatchObject({ exitCode: 0, stdout: '{"turns":4}\n', timedOut: false });
        const created = calls.find((c) => c.method === 'POST')!.body as {
            spec: {
                template: {
                    spec: {
                        containers: Record<string, unknown>[];
                        volumes: { persistentVolumeClaim: { claimName: string } }[];
                    };
                };
            };
        };
        const pod = created.spec.template.spec;
        expect(pod.containers).toHaveLength(1);
        expect(pod.containers[0]!.command).toEqual(readout.argv);
        expect(pod.containers[0]!.env).toContainEqual({ name: 'SESSION_ID', value: 's' });
        expect(pod.containers[0]!.volumeMounts).toEqual([{ name: 'task', mountPath: '/task' }]);
        expect(pod.volumes[0]!.persistentVolumeClaim.claimName).toBe(taskVolumeName(job));
    });

    it('deletes its Job when it is done', async () => {
        const { deps, calls } = world();
        await readViaReaderJob(deps, job, readout);
        expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    });

    it('answers timedOut, never hangs, when the Job never ends', async () => {
        const { deps, calls } = world((method, path) =>
            method === 'GET' && path.startsWith(`${jobsPath(NS)}/`) ? ok({ status: { active: 1 } }) : undefined
        );
        let now = 0;
        deps.sleep = async () => {
            now += 2_000;
            await Promise.resolve();
        };
        const real = Date.now;
        Date.now = () => real() + now;
        try {
            const answered = await readViaReaderJob(deps, job, { ...readout, timeoutMs: 3_000 });
            expect(answered.timedOut).toBe(true);
            expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
        } finally {
            Date.now = real;
        }
    });

    it('answers timedOut when the Job ends on its own deadline', async () => {
        const { deps } = world((method, path) =>
            method === 'GET' && path.startsWith(`${jobsPath(NS)}/`)
                ? ok({
                      status: {
                          failed: 1,
                          conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }],
                      },
                  })
                : undefined
        );
        expect((await readViaReaderJob(deps, job, readout)).timedOut).toBe(true);
    });

    it('keeps the experimental-warning stderr line out of the pod log, and carries the container resources', async () => {
        const { deps, calls } = world();
        const configured = {
            ...deps,
            config: { ...deps.config, runnerResources: { ...deps.config.runnerResources, cpuRequest: '250m' } },
        };
        await readViaReaderJob(configured, job, readout);
        const created = calls.find((c) => c.method === 'POST')!.body as {
            spec: { template: { spec: { containers: { env: unknown[]; resources?: unknown }[] } } };
        };
        const container = created.spec.template.spec.containers[0]!;
        expect(container.env).toContainEqual({ name: 'NODE_OPTIONS', value: '--disable-warning=ExperimentalWarning' });
        expect(container.resources).toEqual({ requests: { cpu: '250m' } });
    });

    it('threads a log the transport cut so the caller sees a head cut at a line boundary', async () => {
        const { deps } = world((method, path) =>
            method === 'GET' && path.includes('/pods/reader-pod/log')
                ? { status: 200, body: '{"turns":4}\n', truncated: true }
                : undefined
        );
        expect(await readViaReaderJob(deps, job, readout)).toMatchObject({ truncated: true });
    });

    it('keeps a failed readout text reachable as detail', async () => {
        const { deps } = world((method, path) => {
            if (method === 'GET' && path.includes('/pods?') && path.includes('factory-read-')) {
                return ok({
                    items: [
                        {
                            metadata: { name: 'reader-pod' },
                            status: {
                                phase: 'Failed',
                                containerStatuses: [{ name: 'readout', state: { terminated: { exitCode: 1 } } }],
                            },
                        },
                    ],
                });
            }
            if (method === 'GET' && path.startsWith(`${jobsPath(NS)}/`)) return ok({ status: { failed: 1 } });
            if (method === 'GET' && path.includes('/pods/reader-pod/log')) return { status: 200, body: 'boom\n' };
        });
        const answered = await readViaReaderJob(deps, job, readout);
        expect(answered).toMatchObject({ exitCode: 1, stderr: 'boom\n', stdout: '' });
    });

    it('waits for the group pod to be terminal before it creates the reader', async () => {
        let reads = 0;
        const { deps, calls } = world((method, path) => {
            if (method !== 'GET' || path !== jobPodsPath(NS, runnerName(job))) return;
            reads += 1;
            return ok({
                items: [{ metadata: { name: 'task-pod' }, status: { phase: reads < 3 ? 'Running' : 'Succeeded' } }],
            });
        });
        const answered = await readViaReaderJob(deps, job, readout);
        expect(answered.timedOut).toBe(false);
        expect(reads).toBe(3);
        expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    });

    it('answers timedOut without creating a reader while the group pod still holds the volume', async () => {
        const { deps, calls } = world((method, path) =>
            method === 'GET' && path === jobPodsPath(NS, runnerName(job))
                ? ok({ items: [{ metadata: { name: 'task-pod' }, status: { phase: 'Running' } }] })
                : undefined
        );
        let now = 0;
        deps.sleep = async () => {
            now += 2_000;
            await Promise.resolve();
        };
        const real = Date.now;
        Date.now = () => real() + now;
        try {
            expect((await readViaReaderJob(deps, job, { ...readout, timeoutMs: 3_000 })).timedOut).toBe(true);
            expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
        } finally {
            Date.now = real;
        }
    });

    it('throws when the Job is refused, for the caller to answer unmeasured', async () => {
        const { deps } = world((method) => (method === 'POST' ? { status: 403, body: 'forbidden' } : undefined));
        await expect(readViaReaderJob(deps, job, readout)).rejects.toThrow(/403/);
    });
});
