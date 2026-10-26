import { describe, expect, it, vi } from 'vitest';
import { loadDriverConfig } from '../src/config.js';
import { claudeExportScript } from '../src/container-scripts.js';
import { jobPodsPath, secretsPath } from '../src/k8s/k8s-auxspec.js';
import { jobsPath } from '../src/k8s/k8s-podspec.js';
import { createKubernetesReaper } from '../src/k8s/k8s-reaper.js';
import { taskVolumesPath } from '../src/k8s/k8s-task-volume.js';
import type { K8sMethod, K8sRequest, K8sResponse } from '../src/k8s/k8s-transport.js';
import type { VolumeExportChannel, VolumeExportProof } from '../src/loop/loop-export.js';
import type { VolumeThread } from '../src/reaper.js';
import { VOLUME_EXPORT_CLEANUP_MS } from '../src/reaper-export.js';

/**
 * The kubernetes arm of the reaper's export-before-delete (issue #938): the one-shot exporter pod over
 * the thread's newest task volume claim. The request function is injected, so the test is a router over
 * (method, path) that records what the arm asked the API server for.
 */

const NAMESPACE = 'factory';
const ROOT = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = { jobId: '22222222-2222-4222-8222-222222222222', claimSeq: 3 };
const POD_UID = 'pod-uid-1';
const NAME = `factory-export-${ROOT}`;
const CLAIM = `${taskVolumesPath(NAMESPACE)}/factory-task-${ROOT}-2`;
const JOB = `${jobsPath(NAMESPACE)}/${NAME}`;
const JOB_DELETE = `${JOB}?propagationPolicy=Foreground`;
const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NAMESPACE, K8S_RELEASE: 'factory' });
const thread: VolumeThread = {
    root: ROOT,
    volumes: [
        { name: `factory-task-${ROOT}-1`, uid: 'claim-uid-1' },
        { name: `factory-task-${ROOT}-2`, uid: 'claim-uid-2' },
    ],
};

const json = (status: number, body: unknown): K8sResponse => ({ status, body: JSON.stringify(body) });
const jobState = (status: unknown): K8sResponse => json(200, { metadata: { uid: POD_UID }, status });
const pendingPods = json(200, {
    items: [{ status: { phase: 'Pending', containerStatuses: [{ state: { waiting: {} } }] } }],
});

interface Recorded {
    method: K8sMethod;
    path: string;
    body?: unknown;
    opts?: { signal?: AbortSignal; timeoutMs?: number };
}

interface World {
    claim?: K8sResponse | Error;
    create?: K8sResponse | Error;
    /** Ms the create waits before it answers (a timeout that arrives late, not an immediate throw). */
    createDelayMs?: number;
    /** The answer to creating the export's Secret. */
    secret?: K8sResponse | Error;
    /** The Job under the name as a GET reads it, given the run id this export labelled its Job with. */
    held?: (run: string | undefined) => K8sResponse | Error;
    /** Each pod GET answers the next entry, the last one forever. */
    pod?: (K8sResponse | Error)[];
    /** The answer to listing the Job's pods. */
    pods?: K8sResponse | Error;
    del?: K8sResponse | Error;
    proof?: VolumeExportProof;
    channel?: null | 'throws';
    drainMs?: number;
}

const scene = (world: World = {}) => {
    const calls: Recorded[] = [];
    const close = vi.fn();
    const channel: VolumeExportChannel = {
        url: 'http://driver.factory.svc:8130/control',
        token: 'export-token',
        proof: () => world.proof ?? { drained: true },
        close,
    };
    const states = [...(world.pod ?? [jobState({ succeeded: 1 })])];
    const request: K8sRequest = async (method, path, body, opts) => {
        calls.push({ method, path, ...(body === undefined ? {} : { body }), ...(opts ? { opts } : {}) });
        if (world.createDelayMs && method === 'POST' && path === jobsPath(NAMESPACE)) {
            await new Promise((resolve) => setTimeout(resolve, world.createDelayMs));
        }
        const answer =
            method === 'GET' && path === CLAIM
                ? (world.claim ?? json(200, {}))
                : method === 'POST' && path === secretsPath(NAMESPACE)
                  ? (world.secret ?? json(201, {}))
                  : method === 'POST'
                    ? (world.create ?? json(201, { metadata: { uid: POD_UID } }))
                    : method === 'GET' && path.startsWith(jobPodsPath(NAMESPACE, NAME))
                      ? (world.pods ?? json(200, { items: [] }))
                      : method === 'GET' && path === JOB && world.held
                        ? world.held(runOf(calls))
                        : method === 'GET' && path === JOB
                          ? (states.length > 1 ? states.shift() : states[0])!
                          : method === 'DELETE'
                            ? (world.del ?? json(200, {}))
                            : json(404, {});
        if (answer instanceof Error) throw answer;
        return answer;
    };
    const arm = createKubernetesReaper({
        config,
        request,
        sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
        exporting: {
            open: async () => {
                if (world.channel === 'throws') throw new Error('listen failed');
                return world.channel === null ? null : channel;
            },
            drainMs: world.drainMs ?? 600,
        },
    });
    return { arm, calls, close, controller: new AbortController() };
};

const deletes = (calls: Recorded[]): Omit<Recorded, 'opts'>[] =>
    calls
        .filter((call) => call.method === 'DELETE' && call.path.startsWith(JOB))
        .map(({ opts: _opts, ...call }) => call);
const secretDeletes = (calls: Recorded[]): Recorded[] =>
    calls.filter((call) => call.method === 'DELETE' && call.path.startsWith(secretsPath(NAMESPACE)));
const runOf = (calls: Recorded[]): string | undefined =>
    (
        calls.find((call) => call.method === 'POST' && call.path === jobsPath(NAMESPACE))?.body as {
            metadata?: { labels?: Record<string, string> };
        }
    )?.metadata?.labels?.['factory.volume-export-run'];
const created = (calls: Recorded[]) =>
    calls.find((call) => call.method === 'POST' && call.path === jobsPath(NAMESPACE))!.body as {
        kind: string;
        metadata: { name: string; labels: Record<string, string> };
        spec: {
            backoffLimit: number;
            activeDeadlineSeconds: number;
            template: {
                metadata: { labels: Record<string, string> };
                spec: {
                    restartPolicy: string;
                    automountServiceAccountToken: boolean;
                    securityContext: { seccompProfile: unknown };
                    volumes: unknown;
                    containers: {
                        image: string;
                        command: string[];
                        env: { name: string; value?: string; valueFrom?: unknown }[];
                        securityContext: { allowPrivilegeEscalation: boolean };
                        volumeMounts: unknown;
                    }[];
                };
            };
        };
    };

describe('the kubernetes arm: exporting a thread’s volume before its delete (#938)', () => {
    it('creates the exporter Job over the newest claim, hardened, deadline-bound and labelled for the runner network policy', async () => {
        const { arm, calls, controller } = scene();
        await arm.exportVolume!(thread, ATTEMPT, controller.signal);
        const pod = created(calls);
        expect(pod.kind).toBe('Job');
        expect(pod.metadata.name).toBe(NAME);
        // The chart's runner policy selects factory.job + the release label; the driver admission policy
        // lets the driver create only factory.job-labelled objects. Neither the lease nor the holder label.
        expect(pod.metadata.labels).toEqual({
            'factory.job': `volume-export-${ROOT}`,
            'factory.volume-export': ROOT,
            'factory.volume-export-run': expect.any(String),
            'app.kubernetes.io/instance': 'factory',
        });
        expect(pod.spec.template.metadata.labels).toEqual(pod.metadata.labels);
        expect(pod.spec.backoffLimit).toBe(0);
        expect(pod.spec.activeDeadlineSeconds).toBe(1);
        const spec = pod.spec.template.spec;
        expect(spec.restartPolicy).toBe('Never');
        expect(spec.automountServiceAccountToken).toBe(false);
        expect(spec.securityContext.seccompProfile).toEqual({ type: 'RuntimeDefault' });
        expect(spec.volumes).toEqual([
            { name: 'task', persistentVolumeClaim: { claimName: `factory-task-${ROOT}-2` } },
        ]);
        const container = spec.containers[0]!;
        expect(spec.containers).toHaveLength(1);
        expect(container.image).toBe(config.executorImages['claude-code']);
        expect(container.command).toEqual(['node', '-e', claudeExportScript]);
        expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
        expect(container.volumeMounts).toEqual([{ name: 'task', mountPath: '/task' }]);
        const env = Object.fromEntries(container.env.map((e) => [e.name, e.value]));
        expect(env).toMatchObject({
            CLAUDE_TRANSCRIPT_DIR: `/task/.factory/transcripts/${ROOT}`,
            EXPORT_ONCE: 'partial',
            EXPORT_ONCE_CAUSE: 'reaper_export',
            BELLOWS_CONTROL_URL: 'http://driver.factory.svc:8130/control',
        });
        // The token is never on the Job object: it is read from the export's own Secret.
        expect(JSON.stringify(pod)).not.toContain('export-token');
        const secretName = `factory-job-export-${runOf(calls)}-env`;
        expect(secretName).toMatch(/^factory-job-[a-z0-9-]+-env$/);
        expect(container.env.find((e) => e.name === 'BELLOWS_CONTROL_TOKEN')).toEqual({
            name: 'BELLOWS_CONTROL_TOKEN',
            valueFrom: { secretKeyRef: { name: secretName, key: 'BELLOWS_CONTROL_TOKEN' } },
        });
        const secret = calls.find((call) => call.method === 'POST' && call.path === secretsPath(NAMESPACE))!;
        // The Job first, then the Secret it owns: the garbage collector removes the Secret with the Job.
        expect(calls.indexOf(secret)).toBeGreaterThan(calls.findIndex((call) => call.path === jobsPath(NAMESPACE)));
        expect(secret.body).toMatchObject({
            kind: 'Secret',
            type: 'Opaque',
            metadata: {
                name: secretName,
                labels: { 'factory.job': `volume-export-${ROOT}` },
                ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: NAME, uid: POD_UID, controller: false }],
            },
            stringData: { BELLOWS_CONTROL_TOKEN: 'export-token' },
        });
        expect(Number(env.EXPORT_GIVEUP_MS)).toBeLessThan(600);
        expect(Number(env.EXPORT_DRAIN_GIVEUP_MS)).toBeLessThan(600);
    });

    it('is drained when the relay proved it, and deletes the pod by uid and closes the channel once', async () => {
        const { arm, calls, close, controller } = scene();
        await expect(arm.exportVolume!(thread, ATTEMPT, controller.signal)).resolves.toEqual({ result: 'drained' });
        expect(deletes(calls)).toEqual([
            {
                method: 'DELETE',
                path: JOB_DELETE,
                body: { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: POD_UID } },
            },
        ]);
        expect(close).toHaveBeenCalledTimes(1);
        expect(secretDeletes(calls)).toHaveLength(1);
    });

    it('is inconclusive when the pod finished without the relay’s proof, even Succeeded', async () => {
        const { arm, calls, controller } = scene({ proof: { drained: false, why: 'a chunk was refused' } });
        const result = await arm.exportVolume!(thread, ATTEMPT, controller.signal);
        expect(result).toEqual({ result: 'inconclusive', why: expect.stringContaining('a chunk was refused') });
        expect(deletes(calls)).toHaveLength(1);
    });

    it('is never_started when the pod never left Pending at the deadline, and deletes it by uid', async () => {
        const { arm, calls, close, controller } = scene({
            pod: [jobState({ active: 1 })],
            pods: pendingPods,
            drainMs: 200,
        });
        const result = await arm.exportVolume!(thread, ATTEMPT, controller.signal);
        expect(result.result).toBe('never_started');
        expect(deletes(calls)).toHaveLength(1);
        expect(deletes(calls)[0]!.body).toMatchObject({ preconditions: { uid: POD_UID } });
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('is inconclusive when the pod is still Running at the deadline, and deletes it', async () => {
        const { arm, calls, controller } = scene({
            pod: [jobState({ active: 1 })],
            pods: json(200, { items: [{ status: { phase: 'Running' } }] }),
            drainMs: 200,
        });
        expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('inconclusive');
        expect(deletes(calls)).toHaveLength(1);
    });

    it('is inconclusive when the pods cannot be listed at the deadline, and deletes the Job', async () => {
        const { arm, calls, controller } = scene({
            pod: [jobState({ active: 1 })],
            pods: json(403, {}),
            drainMs: 200,
        });
        expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('inconclusive');
        expect(deletes(calls)).toHaveLength(1);
    });

    it.each([
        ['a 403', json(403, { message: 'forbidden' })],
        ['a 404 (the pod vanished)', json(404, {})],
        ['a transport timeout', new Error('timed out')],
        ['a body that is not JSON', { status: 200, body: '<html>' }],
        ['a Job without a status', json(200, { metadata: { uid: POD_UID } })],
        ['a Job under another uid', json(200, { metadata: { uid: 'other' }, status: { succeeded: 1 } })],
    ])('is inconclusive on %s reading the pod, and still deletes the pod once', async (_name, answer) => {
        const { arm, calls, controller } = scene({ pod: [answer] });
        expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('inconclusive');
        expect(deletes(calls)).toHaveLength(1);
    });

    it('is never_started when the API server refuses the create, and runs nothing', async () => {
        const { arm, calls, close, controller } = scene({ create: json(403, { message: 'denied' }) });
        expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('never_started');
        expect(calls.some((call) => call.method === 'GET' && call.path === JOB)).toBe(false);
        expect(deletes(calls)).toEqual([]);
        expect(calls.some((call) => call.path === secretsPath(NAMESPACE))).toBe(false);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('is never_started when the Secret is refused: the Job is deleted by uid and the Secret delete is still owed once', async () => {
        const { arm, calls, controller } = scene({ secret: json(403, { message: 'denied' }) });
        expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('never_started');
        expect(deletes(calls)).toHaveLength(1);
        expect(deletes(calls)[0]!.body).toMatchObject({ preconditions: { uid: POD_UID } });
        expect(secretDeletes(calls)).toHaveLength(1);
    });

    it('is inconclusive when the create answers no uid, since the Secret has no owner to name', async () => {
        const { arm, calls, controller } = scene({ create: json(201, {}) });
        expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('inconclusive');
        expect(calls.some((call) => call.path === secretsPath(NAMESPACE))).toBe(false);
    });

    describe('a create that timed out (the Job may exist)', () => {
        it('removes the Job under the name, by the uid it reads, when it carries this export’s label', async () => {
            const { arm, calls, controller } = scene({
                create: new Error('timed out'),
                held: (run) =>
                    json(200, { metadata: { uid: 'ours-uid', labels: { 'factory.volume-export-run': run } } }),
            });
            expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('inconclusive');
            expect(deletes(calls)).toEqual([
                {
                    method: 'DELETE',
                    path: JOB_DELETE,
                    body: { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'ours-uid' } },
                },
            ]);
            expect(secretDeletes(calls)).toEqual([]);
        });

        it('cleans up after a create that timed out late, under its own bound and with no run signal', async () => {
            const { arm, calls, controller } = scene({
                create: new Error('timed out'),
                drainMs: 4000,
                createDelayMs: 2500,
                held: (run) =>
                    json(200, { metadata: { uid: 'ours-uid', labels: { 'factory.volume-export-run': run } } }),
            });
            const result = await arm.exportVolume!(thread, ATTEMPT, controller.signal);
            expect(result.result).toBe('inconclusive');
            const cleanup = calls.filter(
                (call) => call.path === JOB_DELETE || (call.method === 'GET' && call.path === JOB)
            );
            expect(cleanup).toHaveLength(2);
            for (const call of cleanup) {
                expect(call.opts?.signal).toBeUndefined();
                expect(call.opts?.timeoutMs).toBeGreaterThan(1);
                expect(call.opts?.timeoutMs).toBeLessThanOrEqual(VOLUME_EXPORT_CLEANUP_MS);
            }
        });

        it('reads and deletes with no signal after the reaper stopped', async () => {
            const { arm, calls, controller } = scene({
                create: new Error('aborted'),
                held: (run) =>
                    json(200, { metadata: { uid: 'ours-uid', labels: { 'factory.volume-export-run': run } } }),
            });
            controller.abort();
            await arm.exportVolume!(thread, ATTEMPT, controller.signal);
            expect(deletes(calls)).toHaveLength(1);
            expect(calls.find((call) => call.method === 'GET' && call.path === JOB)?.opts?.signal).toBeUndefined();
        });

        it.each([
            [
                'another export’s label',
                () => json(200, { metadata: { uid: 'theirs', labels: { 'factory.volume-export-run': 'other' } } }),
            ],
            ['no label', () => json(200, { metadata: { uid: 'theirs' } })],
            ['a read that failed', () => json(500, {})],
            ['a Job that is not there', () => json(404, {})],
        ])('leaves a Job under the name with %s alone', async (_name, held) => {
            const { arm, calls, controller } = scene({ create: new Error('timed out'), held });
            expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('inconclusive');
            expect(deletes(calls)).toEqual([]);
        });
    });

    describe('a Job already under the export name (409: a second replica’s, or a crashed driver’s)', () => {
        const CONFLICT = json(409, { reason: 'AlreadyExists' });
        const heldAgo = (ms: number) => () =>
            json(200, { metadata: { uid: 'held-uid', creationTimestamp: new Date(Date.now() - ms).toISOString() } });

        it('leaves one within its deadline alone: contended and uncounted, nothing deleted, no Secret made', async () => {
            const { arm, calls, controller } = scene({ create: CONFLICT, held: heldAgo(100) });
            expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('contended');
            expect(deletes(calls)).toEqual([]);
            expect(secretDeletes(calls)).toEqual([]);
        });

        it('deletes a stale one’s Secret, named by its run label, before the Job', async () => {
            const stale = () =>
                json(200, {
                    metadata: {
                        uid: 'held-uid',
                        creationTimestamp: new Date(Date.now() - 5_000).toISOString(),
                        labels: { 'factory.volume-export-run': 'run-x' },
                    },
                });
            const { arm, calls, controller } = scene({ create: CONFLICT, held: stale });
            expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('contended');
            const secret = calls.findIndex(
                (call) =>
                    call.method === 'DELETE' && call.path === `${secretsPath(NAMESPACE)}/factory-job-export-run-x-env`
            );
            expect(secret).toBeGreaterThan(-1);
            expect(secret).toBeLessThan(calls.findIndex((call) => call.path === JOB_DELETE));
        });

        it('counts a stale one the API server will not delete as a failed attempt', async () => {
            const { arm, controller } = scene({ create: CONFLICT, held: heldAgo(5_000), del: json(403, {}) });
            expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('inconclusive');
        });

        it('deletes one past the whole budget, by the uid just read, and exports next round', async () => {
            const { arm, calls, controller } = scene({ create: CONFLICT, held: heldAgo(5_000) });
            expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('contended');
            expect(deletes(calls)).toEqual([
                {
                    method: 'DELETE',
                    path: JOB_DELETE,
                    body: { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'held-uid' } },
                },
            ]);
        });

        it.each([
            ['cannot be read', () => json(500, {}), 'inconclusive'],
            ['has no creation time', () => json(200, { metadata: { uid: 'held-uid' } }), 'inconclusive'],
            ['is gone', () => json(404, {}), 'contended'],
        ])('leaves one that %s alone', async (_name, held, result) => {
            const { arm, calls, controller } = scene({ create: CONFLICT, held });
            expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe(result);
            expect(deletes(calls)).toEqual([]);
        });
    });

    it('is never_started with no control endpoint, or one that fails to open, and creates nothing', async () => {
        for (const channel of [null, 'throws'] as const) {
            const { arm, calls, controller } = scene({ channel });
            expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('never_started');
            expect(calls.some((call) => call.method === 'POST')).toBe(false);
        }
    });

    it('skips a claim the API server says is gone (404), and keeps one it could not read', async () => {
        const gone = scene({ claim: json(404, {}) });
        await expect(gone.arm.exportVolume!(thread, ATTEMPT, gone.controller.signal)).resolves.toEqual({
            result: 'gone',
        });
        for (const claim of [json(403, {}), new Error('timed out'), json(500, {})]) {
            const failed = scene({ claim });
            expect((await failed.arm.exportVolume!(thread, ATTEMPT, failed.controller.signal)).result).toBe(
                'inconclusive'
            );
            expect(failed.calls.some((call) => call.method === 'POST')).toBe(false);
        }
    });

    it('deletes the pod once and keeps the volume when the reaper stops mid-export', async () => {
        const { arm, calls, close, controller } = scene({ pod: [jobState({ active: 1 })], drainMs: 5000 });
        const pending = arm.exportVolume!(thread, ATTEMPT, controller.signal);
        await vi.waitFor(() => expect(calls.some((call) => call.method === 'GET' && call.path === JOB)).toBe(true));
        controller.abort();
        expect((await pending).result).toBe('inconclusive');
        expect(deletes(calls)).toHaveLength(1);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('does not let a failed delete change what the export proved', async () => {
        const { arm, controller } = scene({ del: json(500, {}) });
        await expect(arm.exportVolume!(thread, ATTEMPT, controller.signal)).resolves.toEqual({ result: 'drained' });
    });
});
