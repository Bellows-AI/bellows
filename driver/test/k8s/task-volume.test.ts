import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import type { K8sRequest } from '../../src/k8s/k8s-transport.js';
import { REVIEWER_HOME } from '../../src/claim.js';
import type { Call } from '../fixtures/k8s-apiserver.js';
import {
    FIRST_GENERATION,
    TASK_GENERATION_LABEL,
    TASK_MOUNT,
    TASK_ROOT_LABEL,
    TASK_VOLUME,
    taskRootOf,
    taskVolumeName,
    taskVolumeSpec,
} from '../../src/task-volume.js';
import { job, SESSION, POD_NAMES, everyPodSpec, namespace, routed, runner } from '../fixtures/k8s-suite.js';

describe("scoping the kubernetes mounts to the thread's own task volume (issue #775)", () => {
    // Every pod of an attempt mounts ONE volume claim, the thread's own, by name: there is no spec
    // shape here that reaches a shared claim, another task's tree or a parent directory of one.
    // The supervisor runs the attempt's steps (the sync, the publish) on the task checkout, so it
    // mounts the task volume like every other pod.
    it.each(POD_NAMES.filter((name) => name !== 'the service sidecar'))(
        'mounts the whole task volume of the thread on %s, and no subPath',
        (name) => {
            const { pod } = everyPodSpec({ RUNNER_SERVICES: '0' })[name]();
            const mount = pod.containers[0]!.volumeMounts?.find((m) => m.name === TASK_VOLUME);
            expect(mount).toEqual({ name: TASK_VOLUME, mountPath: TASK_MOUNT });
        }
    );

    // A thread root that is no uuid is refused before any pod spec exists: the claim name and the
    // checkout path both derive from it.
    it.each(POD_NAMES)('refuses to build %s for a thread root that is not a uuid', (name) => {
        const build = everyPodSpec({ RUNNER_SERVICES: '0' }, { ...job, rootJobId: '../../etc' })[name];
        expect(build).toThrow(/not a uuid|task worktree/);
    });
});

describe("the thread's task volume claim (issue #775)", () => {
    const volumes = `/api/v1/namespaces/${namespace}/persistentvolumeclaims`;
    const SESSION_OF = { id: SESSION, resume: false };
    const sync = (request: K8sRequest, of: BoardJob = job) => runner(request).run(of, SESSION_OF);
    const volumeCalls = (calls: Call[]) => calls.filter((call) => call.path.startsWith(volumes));
    const posts = (calls: Call[]) => volumeCalls(calls).filter((call) => call.method === 'POST');
    type Claim = ReturnType<typeof taskVolumeSpec>;
    const specOf = (of: BoardJob = job): Claim =>
        taskVolumeSpec(loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }), of);

    it('is named, generated, labelled and sized as the thread root alone, with no ownerReferences', () => {
        const claim = specOf({ ...job, id: '44444444-4444-4444-8444-444444444444', rootJobId: job.id });
        expect(claim.metadata.name).toBe(`factory-task-${job.id}-1`);
        expect(claim.metadata.labels).toMatchObject({
            [TASK_ROOT_LABEL]: job.id,
            [TASK_GENERATION_LABEL]: String(FIRST_GENERATION),
        });
        expect(claim.spec.accessModes).toEqual(['ReadWriteOncePod']);
        expect(claim.spec.resources.requests.storage).toBeTruthy();
        // Nothing owns it: a Job's TTL or a pod's deletion never garbage-collects the task's tree.
        expect(claim.metadata).not.toHaveProperty('ownerReferences');
        expect(claim.apiVersion).toBe('v1');
        expect(claim.kind).toBe('PersistentVolumeClaim');
    });

    it('takes its storage class, access mode and size from the configuration', () => {
        const config = loadDriverConfig({
            EXECUTOR: 'kubernetes',
            K8S_NAMESPACE: namespace,
            TASK_VOLUME_STORAGE_CLASS: 'efs-sc',
            TASK_VOLUME_ACCESS_MODE: 'ReadWriteOnce',
            TASK_VOLUME_SIZE: '7Gi',
        });
        const claim = taskVolumeSpec(config, job);
        expect(claim.spec).toEqual({
            accessModes: ['ReadWriteOnce'],
            resources: { requests: { storage: '7Gi' } },
            storageClassName: 'efs-sc',
        });
    });

    it('is stamped with this board’s identity, which differs between boards', () => {
        const other = loadDriverConfig({
            EXECUTOR: 'kubernetes',
            K8S_NAMESPACE: namespace,
            JOB_BOARD_URL: 'http://b:1',
        });
        const mine = taskVolumeSpec(loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }), job);
        expect(mine.metadata.labels['factory.task-board']).toMatch(/^[0-9a-f]{16}$/);
        expect(taskVolumeSpec(other, job).metadata.labels['factory.task-board']).not.toBe(
            mine.metadata.labels['factory.task-board']
        );
    });

    it('carries the release label the runner Jobs carry, so a release cleanup finds its claims', () => {
        const withRelease = loadDriverConfig({
            EXECUTOR: 'kubernetes',
            K8S_NAMESPACE: namespace,
            K8S_RELEASE: 'lane-a',
        });
        expect(taskVolumeSpec(withRelease, job).metadata.labels).toMatchObject({
            'app.kubernetes.io/instance': 'lane-a',
        });
        expect(
            taskVolumeSpec(loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }), job).metadata.labels
        ).not.toHaveProperty('app.kubernetes.io/instance');
    });

    it('is created once by a thread first attempt, and read, not created again, by its next', async () => {
        const { request, calls } = routed(() => undefined);
        await sync(request);
        await sync(request);
        expect(posts(calls)).toHaveLength(1);
        expect(posts(calls)[0]!.body).toEqual(specOf());
        expect(volumeCalls(calls).filter((call) => call.method === 'GET').length).toBeGreaterThanOrEqual(2);
    });

    it('is created for the thread root, shared by every job of the thread', async () => {
        const { request, calls } = routed(() => undefined);
        await sync(request, { ...job, id: '55555555-5555-4555-8555-555555555555', rootJobId: job.id });
        expect((posts(calls)[0]!.body as Claim).metadata.name).toBe(taskVolumeName(job));
    });

    it('is never created for an attempt that was aborted: the sync stands down with no create', async () => {
        const { request, calls } = routed(() => undefined);
        const aborted = new AbortController();
        aborted.abort();
        const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
        await expect(runner(request).syncCheckout(repoJob, aborted.signal, SESSION_OF)).rejects.toThrow();
        expect(posts(calls)).toEqual([]);
    });

    it('is adopted when the create answers 409: the claim is read again and nothing else is created', async () => {
        const stored = JSON.stringify(specOf());
        let reads = 0;
        const { request, calls } = routed((method, path) => {
            if (!path.startsWith(volumes)) return;
            // The thread's claims are listed by label: none the first time, the racing creation's the second.
            if (method === 'GET') {
                return { status: 200, body: JSON.stringify({ items: reads++ === 0 ? [] : [JSON.parse(stored)] }) };
            }
            return { status: 409, body: '{"reason":"AlreadyExists"}' };
        });
        await sync(request);
        expect(posts(calls)).toHaveLength(1);
        expect(reads).toBe(2);
    });

    it('is never created on an answer that is not a 404: a refused read throws and creates nothing', async () => {
        const { request, calls } = routed((method, path) =>
            method === 'GET' && path.startsWith(volumes) ? { status: 500, body: 'unavailable' } : undefined
        );
        await expect(sync(request)).rejects.toThrow(/task volume/);
        expect(posts(calls)).toEqual([]);
    });

    it('is refused when the claim that holds its name is another thread’s: it throws, creating nothing', async () => {
        const foreign = specOf();
        foreign.metadata.labels[TASK_ROOT_LABEL] = '66666666-6666-4666-8666-666666666666';
        const { request, calls } = routed((method, path) =>
            method === 'GET' && path.startsWith(volumes)
                ? { status: 200, body: JSON.stringify({ items: [foreign] }) }
                : undefined
        );
        // The listing is by the thread's label, so another thread's claim in it is a listing that proves nothing.
        await expect(sync(request)).rejects.toThrow(/listing the task volumes/);
        expect(posts(calls)).toEqual([]);
    });

    it.each([
        ['null', 'null'],
        ['an empty object', '{}'],
        ['a Status with no metadata', JSON.stringify({ kind: 'Status', status: 'Success' })],
        ['cut JSON', '{"metadata":{"name":'],
    ])('is inconclusive on a 200 whose body is %s: it throws and creates nothing', async (_name, body) => {
        const { request, calls } = routed((method, path) =>
            method === 'GET' && path.startsWith(volumes) ? { status: 200, body } : undefined
        );
        await expect(sync(request)).rejects.toThrow();
        expect(posts(calls)).toEqual([]);
    });

    it('is not named for a thread root that is not a uuid: nothing reaches the cluster', async () => {
        const { request, calls } = routed(() => undefined);
        await expect(sync(request, { ...job, rootJobId: '../../etc' })).rejects.toThrow(/not a uuid/);
        expect(volumeCalls(calls)).toEqual([]);
        expect(() => taskRootOf({ id: job.id, rootJobId: '../../etc' })).toThrow(/not a uuid/);
    });

    it.each(POD_NAMES.filter((name) => name !== 'the service sidecar'))(
        'is the only claim %s mounts, at /task, never the shared workspaces claim',
        (name) => {
            const { pod } = everyPodSpec({ RUNNER_SERVICES: '0' })[name]();
            const withVolumes = pod as typeof pod & {
                volumes?: { name: string; persistentVolumeClaim?: { claimName: string } }[];
                initContainers?: typeof pod.containers;
            };
            const claims = (withVolumes.volumes ?? []).flatMap((volume) =>
                volume.persistentVolumeClaim ? [volume.persistentVolumeClaim.claimName] : []
            );
            expect(claims).toEqual([taskVolumeName(job)]);
            const mounts = [...pod.containers, ...(withVolumes.initContainers ?? [])].flatMap(
                (container) => (container.volumeMounts ?? []) as { name: string; mountPath?: string }[]
            );
            const task = mounts.filter((mount) => mount.name === TASK_VOLUME);
            expect(task.length).toBeGreaterThan(0);
            expect(mounts.filter((mount) => /workspace/i.test(mount.name))).toEqual([]);
            expect(task.every((mount) => mount.mountPath === TASK_MOUNT || mount.mountPath === REVIEWER_HOME)).toBe(
                true
            );
        }
    );
});
