import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { JOB_LABEL, LEASE_LABEL } from '../src/labels.js';
import { configmapsPath, podsPath, secretsPath } from '../src/k8s-auxspec.js';
import { jobsPath, runnerJobName, secretName } from '../src/k8s-podspec.js';
import { createKubernetesReaper } from '../src/k8s-reaper.js';
import { taskVolumesPath } from '../src/k8s-task-volume.js';
import { TASK_BOARD_LABEL, TASK_ROOT_LABEL, TASK_UNSCHEDULABLE_LABEL, boardIdentity } from '../src/task-volume.js';
import type { K8sMethod, K8sRequest, K8sResponse } from '../src/k8s-transport.js';
import { createReaper, type OrphanGroup } from '../src/reaper.js';
import { AGENT_CONTAINER, SUPERVISOR_CONTAINER } from '../src/supervisor-contract.js';

/**
 * The kubernetes reaper arm, offline: the request function is injected (the way every k8s suite
 * here does it), so the test is a router over (method, path) that records what the arm asked the
 * API server for. No cluster, no RBAC, no kubelet.
 */

const JOB = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const NAMESPACE = 'factory';

interface Recorded {
    method: K8sMethod;
    path: string;
    body?: unknown;
}

/** A router that answers each (method, path) from a table and records every call. */
const router = (
    answers: readonly (readonly [K8sMethod, string, K8sResponse])[],
    // A status every unlisted GET answers, so a test can model a 500 without listing every path.
    fallbackStatus = 404
): { request: K8sRequest; calls: Recorded[] } => {
    const calls: Recorded[] = [];
    return {
        calls,
        request: async (method, path, body) => {
            calls.push({ method, path, body });
            const hit = answers.find(([m, p]) => m === method && p === path);
            if (hit) return hit[2];
            if (method === 'GET' && path.startsWith(`${jobsPath(NAMESPACE)}?`)) {
                return { status: 200, body: JSON.stringify({ items: [] }) };
            }
            return { status: fallbackStatus, body: '' };
        },
    };
};

/** A leftover aux Job of one attempt (a readout), as the job+lease selector lists it. */
const auxJob = (name: string, jobId: string, lease: string, created: string) => ({
    metadata: {
        name,
        uid: `uid-${name}`,
        labels: { [JOB_LABEL]: jobId, [LEASE_LABEL]: lease },
        creationTimestamp: created,
    },
});

const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NAMESPACE });

const LIST_JOBS = `${jobsPath(NAMESPACE)}?labelSelector=${encodeURIComponent('factory.job,factory.lease')}`;

const deleteCalls = (calls: readonly Recorded[]) =>
    calls.filter((call) => call.method === 'DELETE').map((call) => call.path);

const AUX = 'factory-ocread-0123456789abcdef';
const group = (overrides: Partial<OrphanGroup> = {}): OrphanGroup => ({
    jobId: JOB,
    leaseToken: LEASE,
    createdAtMs: 0,
    objects: [{ kind: 'job', name: AUX }],
    ...overrides,
});
const AUX_DELETE = `${jobsPath(NAMESPACE)}/${AUX}?propagationPolicy=Foreground`;

describe('the kubernetes reaper arm: scan', () => {
    // A declared service is a sidecar of its attempt's pod (issue #773): it goes with its Job, so
    // the arm lists Jobs alone — no service pod, no headless Service.
    it('lists the attempt Jobs, and nothing else', async () => {
        const { request, calls } = router([]);
        const arm = createKubernetesReaper({ config, request });

        await arm.scan();

        expect(calls).toEqual([{ method: 'GET', path: LIST_JOBS }]);
    });

    it('scopes the selector to this release when one is configured', async () => {
        const scoped = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NAMESPACE, K8S_RELEASE: 'factory' });
        const { request, calls } = router([]);
        await createKubernetesReaper({ config: scoped, request }).scan();
        // The release term is load-bearing: two releases sharing a namespace against different
        // boards must never reap each other's Jobs as "unknown jobs".
        expect(calls.map((call) => call.path)).toEqual([
            `${jobsPath(NAMESPACE)}?labelSelector=${encodeURIComponent(
                'factory.job,factory.lease,app.kubernetes.io/instance=factory'
            )}`,
        ]);
    });

    it('groups by job and lease, keeping the oldest creationTimestamp of the group', async () => {
        const jobs = JSON.stringify({
            items: [
                auxJob('factory-ocread-new', JOB, LEASE, '2026-09-02T00:00:00Z'),
                auxJob('factory-cturns-old', JOB, LEASE, '2026-09-01T00:00:00Z'),
            ],
        });
        const { request } = router([['GET', LIST_JOBS, { status: 200, body: jobs }]]);

        expect(await createKubernetesReaper({ config, request }).scan()).toEqual([
            {
                jobId: JOB,
                leaseToken: LEASE,
                // The OLDEST creationTimestamp — the grace window is measured from the moment
                // the attempt's objects began to exist, not from the youngest of them.
                createdAtMs: Date.parse('2026-09-01T00:00:00Z'),
                objects: [
                    { kind: 'job', name: 'factory-ocread-new', uid: 'uid-factory-ocread-new' },
                    { kind: 'job', name: 'factory-cturns-old', uid: 'uid-factory-cturns-old' },
                ],
            },
        ]);
    });

    it('dates a row by an RFC3339 timestamp with a fraction and an offset', async () => {
        const items = [auxJob('p', JOB, LEASE, '2026-09-01T02:00:00.5+02:00')];
        const { request } = router([['GET', LIST_JOBS, { status: 200, body: JSON.stringify({ items }) }]]);
        const groups = (await createKubernetesReaper({ config, request }).scan())!;
        expect(groups.map((g) => g.createdAtMs)).toEqual([Date.parse('2026-09-01T00:00:00.500Z')]);
    });

    it('skips rows missing either label', async () => {
        const jobs = JSON.stringify({
            items: [
                auxJob('good', JOB, LEASE, '2026-09-01T00:00:00Z'),
                // Unlabelled junk never becomes somebody's orphan.
                { metadata: { name: 'junk', uid: 'uid-junk' } },
                { metadata: { name: 'half', uid: 'uid-half', labels: { [JOB_LABEL]: JOB } } },
            ],
        });
        const { request } = router([['GET', LIST_JOBS, { status: 200, body: jobs }]]);

        expect(await createKubernetesReaper({ config, request }).scan()).toEqual([
            {
                jobId: JOB,
                leaseToken: LEASE,
                createdAtMs: Date.parse('2026-09-01T00:00:00Z'),
                objects: [{ kind: 'job', name: 'good', uid: 'uid-good' }],
            },
        ]);
    });

    it.each([
        [
            'an in-scope Job with no creationTimestamp',
            { metadata: { name: 'x', labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE } } },
        ],
        ['an in-scope Job with an unparsable creationTimestamp', auxJob('x', JOB, LEASE, 'not-a-date')],
        ['an in-scope Job dated "0"', auxJob('x', JOB, LEASE, '0')],
        ['an in-scope Job dated on a day the calendar lacks', auxJob('x', JOB, LEASE, '2026-02-31T00:00:00Z')],
        ['an in-scope Job dated with no time', auxJob('x', JOB, LEASE, '2026-09-01')],
        ['an in-scope Job dated in docker’s spelling', auxJob('x', JOB, LEASE, '2026-09-01 00:00:00 +0000 UTC')],
        ['an item no one named', { metadata: { labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE } } }],
        ['an empty item', {}],
        ['an item named by a number', { metadata: { name: 5 } }],
        [
            'an item with no uid',
            {
                metadata: {
                    name: 'x',
                    labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE },
                    creationTimestamp: '2026-09-01T00:00:00Z',
                },
            },
        ],
        [
            'an item with an empty uid',
            {
                metadata: {
                    name: 'x',
                    uid: '',
                    labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE },
                    creationTimestamp: '2026-09-01T00:00:00Z',
                },
            },
        ],
        // #869 round 2: a job, lease or holder label that is present but no uuid would become the attempt identity.
        ['an in-scope Job whose lease label is no lease', auxJob('x', JOB, 'corrupt', '2026-09-01T00:00:00Z')],
        ['an in-scope Job whose lease label is empty', auxJob('x', JOB, '', '2026-09-01T00:00:00Z')],
        ['an in-scope Job whose job label is no job id', auxJob('x', 'corrupt', LEASE, '2026-09-01T00:00:00Z')],
        [
            'a Job whose holder label is no lease',
            {
                metadata: {
                    name: 'x',
                    uid: 'uid-x',
                    labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE, 'factory.holder': 'corrupt' },
                    creationTimestamp: '2026-09-01T00:00:00Z',
                },
            },
        ],
    ])('answers nothing when a listed row is malformed — %s', async (_name, row) => {
        // A row that cannot be dated or named proves nothing about the rest: a group dated from the
        // other rows could read as out of its grace (#869).
        const items = [auxJob('good', JOB, LEASE, '2026-09-01T00:00:00Z'), row];
        const { request } = router([['GET', LIST_JOBS, { status: 200, body: JSON.stringify({ items }) }]]);
        await expect(createKubernetesReaper({ config, request }).scan()).resolves.toBeNull();
    });

    // #869 round 2: a Job named as a runner whose spec is unreadable cannot be said to run no agent.
    it.each([
        ['no spec', undefined],
        ['a spec with no pod template', {}],
        ['a container with no name', { template: { spec: { containers: [{}] } } }],
        ['a suspend that is no boolean', { suspend: 'yes', template: { spec: { containers: [{ name: 'agent' }] } } }],
    ])('answers nothing when a listed runner Job has %s', async (_name, spec) => {
        const runnerJob = {
            metadata: {
                name: runnerJobName({ id: JOB, leaseToken: LEASE } as BoardJob),
                uid: 'uid-runner',
                labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE },
                creationTimestamp: '2026-09-01T00:00:00Z',
            },
            ...(spec === undefined ? {} : { spec }),
            status: { succeeded: 1 },
        };
        const { request } = router([['GET', LIST_JOBS, { status: 200, body: JSON.stringify({ items: [runnerJob] }) }]]);
        await expect(createKubernetesReaper({ config, request }).scan()).resolves.toBeNull();
    });

    it('answers nothing when the Jobs cannot be read — inconclusive reaps nothing', async () => {
        const refused = router([['GET', LIST_JOBS, { status: 403, body: '{}' }]]);
        await expect(createKubernetesReaper({ config, request: refused.request }).scan()).resolves.toBeNull();

        const throwing: K8sRequest = async () => {
            throw new Error('connection reset');
        };
        await expect(createKubernetesReaper({ config, request: throwing }).scan()).resolves.toBeNull();
    });
});

describe('the kubernetes reaper arm: reap', () => {
    it('deletes each listed Job by name with Foreground propagation', async () => {
        const { request, calls } = router([['DELETE', AUX_DELETE, { status: 200, body: '' }]]);
        const removed = await createKubernetesReaper({ config, request }).reap(group(), 'gone');

        expect(removed).toEqual([`job ${AUX}`]);
        // The checkout claim is pinned in full below — here the read answers nothing (this router
        // models a claim that was already released), so nothing is deleted on a maybe.
        expect(deleteCalls(calls).filter((path) => !path.startsWith(secretsPath(NAMESPACE)))).toEqual([AUX_DELETE]);
    });

    it('reads 404 and 409 as the object already going away, and keeps the answer honest', async () => {
        for (const status of [404, 409]) {
            const { request } = router([['DELETE', AUX_DELETE, { status, body: '' }]]);
            expect(await createKubernetesReaper({ config, request }).reap(group(), 'gone'), String(status)).toEqual([]);
        }
    });

    it('deletes the attempt-scoped env Secret by its derived name, and answers it to the log', async () => {
        const runnerSecret = `${secretsPath(NAMESPACE)}/${secretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob)}`;
        const { request, calls } = router([
            ['DELETE', AUX_DELETE, { status: 200, body: '' }],
            ['DELETE', runnerSecret, { status: 200, body: '' }],
        ]);

        const removed = await createKubernetesReaper({ config, request }).reap(group(), 'gone');

        const secrets = deleteCalls(calls).filter((path) => path.startsWith(secretsPath(NAMESPACE)));
        // The attempt's one Secret (issue #773: the gates hold none of their own).
        expect(secrets).toEqual([runnerSecret]);
        // A 2xx Secret delete is a removal like any other.
        expect(removed).toContain(`secret ${runnerSecret.split('/').pop()}`);
    });

    it('deletes the checkout claim only when the job is gone, by uid precondition, never while a replacement lives', async () => {
        const claimPath = `${configmapsPath(NAMESPACE)}/factory-job-${JOB}-claim`;
        const { request, calls } = router([
            // The read the precondition is built from — the fence's own release shape, holder and all.
            [
                'GET',
                claimPath,
                { status: 200, body: JSON.stringify({ metadata: { uid: 'claim-uid-1' }, data: { holder: LEASE } }) },
            ],
            ['DELETE', claimPath, { status: 200, body: '' }],
        ]);

        await createKubernetesReaper({ config, request }).reap(group(), 'gone');
        // The one way a claim goes (issue #821): its holder's groups confirmed ended, then the delete.
        expect(deleteCalls(calls)).toContainEqual(claimPath);
        // The delete can only ever reach the exact incarnation this call read.
        const claimDelete = calls.find((call) => call.method === 'DELETE' && call.path === claimPath);
        expect(claimDelete?.body).toEqual({
            apiVersion: 'v1',
            kind: 'DeleteOptions',
            preconditions: { uid: 'claim-uid-1' },
        });

        const superseded = router([], 404);
        await createKubernetesReaper({ config, request: superseded.request }).reap(group(), 'superseded');
        // A live replacement attempt holds the claim; the reaper must never touch it.
        expect(deleteCalls(superseded.calls).some((path) => path.startsWith(configmapsPath(NAMESPACE)))).toBe(false);
    });

    it('defers the claim when the read cannot identify an incarnation — never a delete on a maybe', async () => {
        const claimPath = `${configmapsPath(NAMESPACE)}/factory-job-${JOB}-claim`;
        const { request, calls } = router([
            // 2xx but no uid: garbage is never proof of anything, and an UNCONDITIONED delete
            // could reach a newer claim. Nothing is deleted; the next round reads again.
            ['GET', claimPath, { status: 200, body: JSON.stringify({ metadata: {} }) }],
        ]);

        await createKubernetesReaper({ config, request }).reap(group(), 'gone');

        expect(deleteCalls(calls).some((path) => path.startsWith(configmapsPath(NAMESPACE)))).toBe(false);
    });

    it('deletes the derived Secret BEFORE the Job, and stops the round when it fails', async () => {
        // Once the listed Job is gone, no next scan can rediscover the (job, lease) pair to
        // re-derive this name — a Secret the Job never owned has nothing to collect it. So a failed
        // Secret delete must hold the Job back: here the Secret answers 500, and nothing but it
        // may be deleted all round.
        const secret = `${secretsPath(NAMESPACE)}/${secretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob)}`;
        const { request, calls } = router([['DELETE', secret, { status: 500, body: '' }]]);

        expect(await createKubernetesReaper({ config, request }).reap(group(), 'gone')).toEqual([]);
        expect(deleteCalls(calls)).toEqual([secret]);
    });

    it('deletes the Secret ahead of the Job, and a 404 Secret does not block the teardown', async () => {
        const secret = `${secretsPath(NAMESPACE)}/${secretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob)}`;
        const { request, calls } = router([
            ['DELETE', secret, { status: 404, body: '' }],
            ['DELETE', AUX_DELETE, { status: 200, body: '' }],
        ]);

        const removed = await createKubernetesReaper({ config, request }).reap(group(), 'gone');

        // Ordering is the point: the Secret delete is the FIRST call, before the Job — and an
        // already-gone Secret never holds the round back.
        expect(deleteCalls(calls)[0]).toBe(secret);
        expect(removed).toEqual([`job ${AUX}`]);
    });

    it('answers what it removed without throwing on any single delete failure', async () => {
        const failing: K8sRequest = async (method) => {
            if (method === 'DELETE') throw new Error('connection reset');
            return { status: 200, body: JSON.stringify({ items: [] }) };
        };
        expect(await createKubernetesReaper({ config, request: failing }).reap(group(), 'gone')).toEqual([]);
    });
});

// Issue #792: a runner that finished after its driver died is the next claim's to read. Superseded
// is no reason to delete it — only a job that can never be claimed again (gone) is.
describe('the kubernetes reaper arm: an unread finished runner', () => {
    const runnerJob = runnerJobName({ id: JOB, leaseToken: LEASE } as BoardJob);
    const finishedRunner = {
        metadata: {
            name: runnerJob,
            uid: 'uid-1',
            labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE },
            creationTimestamp: '2026-10-01T00:00:00Z',
        },
        // A Job that ran an agent: a supervisor-only group's is no run to adopt (issue #821).
        spec: { template: { spec: { containers: [{ name: 'supervisor' }, { name: 'agent' }] } } },
        status: { succeeded: 1 },
    };
    const lists = (jobs: unknown[]): readonly (readonly [K8sMethod, string, K8sResponse])[] => [
        ['GET', LIST_JOBS, { status: 200, body: JSON.stringify({ items: jobs }) }],
    ];

    it('marks a finished runner Job unread on the scan, and a running one not', async () => {
        const running = { ...finishedRunner, status: { active: 1 } };
        const arm = createKubernetesReaper({ config, request: router(lists([finishedRunner])).request });
        expect((await arm.scan())![0]!.objects).toEqual([
            { kind: 'job', name: runnerJob, uid: 'uid-1', unread: true, runner: true },
        ]);

        const live = createKubernetesReaper({ config, request: router(lists([running])).request });
        expect((await live.scan())![0]!.objects).toEqual([
            { kind: 'job', name: runnerJob, uid: 'uid-1', runner: true },
        ]);
    });

    // A supervisor-only group's Job (an agentless node, the group an adoption made) ran no agent:
    // no run to adopt, so nothing to spare (issue #821).
    it('never marks a finished supervisor-only Job unread', async () => {
        const supervisorOnly = {
            ...finishedRunner,
            spec: { template: { spec: { containers: [{ name: 'supervisor' }] } } },
        };
        const arm = createKubernetesReaper({ config, request: router(lists([supervisorOnly])).request });
        expect((await arm.scan())![0]!.objects).toEqual([{ kind: 'job', name: runnerJob, uid: 'uid-1', runner: true }]);
    });

    it('never deletes an unread finished runner of a job that is still live', async () => {
        const { request, calls } = router(lists([finishedRunner]));
        const arm = createKubernetesReaper({ config, request });
        const reaper = createReaper({
            board: { leases: async () => [{ id: JOB, status: 'queued', leaseToken: null }] },
            arm,
            intervalMs: 0,
            graceMs: 0,
            log: () => {},
        });

        await reaper.sweep();

        expect(deleteCalls(calls)).toEqual([]);
    });

    it('reaps it once the job can never be claimed again', async () => {
        const { request, calls } = router(lists([finishedRunner]));
        const arm = createKubernetesReaper({ config, request });

        await arm.reap({ ...group(), objects: [{ kind: 'job', name: runnerJob, unread: true }] }, 'gone');

        expect(deleteCalls(calls)).toContain(`${jobsPath(NAMESPACE)}/${runnerJob}?propagationPolicy=Foreground`);
    });
});

describe('paused runner recovery after a driver restart', () => {
    const name = 'factory-runner-orphan';
    const jobPath = `${jobsPath(NAMESPACE)}/${name}?propagationPolicy=Foreground`;
    const pausedJob = {
        metadata: {
            name,
            uid: 'uid-1',
            labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE },
            creationTimestamp: '2026-09-01T00:00:00Z',
            annotations: { 'bellows.ai/paused-deadline': JSON.stringify({ deadline: 60, at: 1 }) },
        },
        spec: { activeDeadlineSeconds: null },
    };
    const lists: readonly (readonly [K8sMethod, string, K8sResponse])[] = [
        ['GET', LIST_JOBS, { status: 200, body: JSON.stringify({ items: [pausedJob] }) }],
    ];

    it.each(['gone', 'superseded', 'unclaimed', 'live', 'unreachable'] as const)(
        'reaps a paused Job only when the board condemns its lease: %s',
        async (state) => {
            const { request, calls } = router([...lists, ['DELETE', jobPath, { status: 200, body: '' }]]);
            const reaper = createReaper({
                arm: createKubernetesReaper({ config, request }),
                board: {
                    leases: async () =>
                        state === 'unreachable'
                            ? null
                            : state === 'gone'
                              ? []
                              : [
                                    {
                                        id: JOB,
                                        status: 'running',
                                        leaseToken: state === 'live' ? LEASE : state === 'unclaimed' ? null : JOB,
                                    },
                                ],
                },
                intervalMs: 1000,
                graceMs: 0,
                log: () => {},
            });
            await reaper.sweep();
            if (state === 'live' || state === 'unreachable') {
                expect(deleteCalls(calls)).toEqual([]);
            } else {
                expect(deleteCalls(calls)).toContain(jobPath);
                expect(deleteCalls(calls).filter((path) => path.startsWith(jobsPath(NAMESPACE)))).toEqual([jobPath]);
            }
        }
    );

    it('rediscovers a paused Job when deletion fails and retries next sweep', async () => {
        const base = router(lists);
        let attempts = 0;
        const request: K8sRequest = async (method, path, body) => {
            if (method === 'DELETE' && path === jobPath) {
                attempts += 1;
                return { status: attempts === 1 ? 500 : 200, body: '' };
            }
            return base.request(method, path, body);
        };
        const reaper = createReaper({
            arm: createKubernetesReaper({ config, request }),
            board: { leases: async () => [] },
            intervalMs: 1000,
            graceMs: 0,
            log: () => {},
        });
        await reaper.sweep();
        await reaper.sweep();
        expect(attempts).toBe(2);
    });
});

/*
 * Issue #821: a runner Job its driver suspended because the teardown could not be confirmed is no
 * run for the next claim to adopt — the reaper takes it, its derived Secrets first, a refused one
 * stopping the round with the Job still listed. And the checkout claim goes the one way a claim
 * ever goes: only once every group its holder can have left is confirmed gone.
 */
describe('the kubernetes reaper arm: suspended runners and confirmed claims (#821)', () => {
    const pair = { id: JOB, leaseToken: LEASE } as BoardJob;
    const runnerJob = runnerJobName(pair);
    const claimPath = `${configmapsPath(NAMESPACE)}/factory-job-${JOB}-claim`;
    const suspendedRunner = {
        metadata: {
            name: runnerJob,
            uid: 'uid-1',
            labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE },
            creationTimestamp: '2026-10-01T00:00:00Z',
        },
        // A runner Job as the apiserver holds it: its pod template names the supervisor and the agent.
        spec: {
            suspend: true,
            template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } },
        },
        status: { failed: 1 },
    };
    const lists = (jobs: unknown[]): readonly (readonly [K8sMethod, string, K8sResponse])[] => [
        ['GET', LIST_JOBS, { status: 200, body: JSON.stringify({ items: jobs }) }],
    ];
    const claimRead: readonly [K8sMethod, string, K8sResponse] = [
        'GET',
        claimPath,
        { status: 200, body: JSON.stringify({ metadata: { uid: 'claim-uid-1' }, data: { holder: LEASE } }) },
    ];
    const secrets = [secretName(pair)].map((name) => `${secretsPath(NAMESPACE)}/${name}`);
    const sweep = (request: K8sRequest) =>
        createReaper({
            // The job is terminal: a live job's runner Job is its next claim's fence's (issue #821).
            board: { leases: async () => [{ id: JOB, status: 'failed', leaseToken: null }] },
            arm: createKubernetesReaper({ config, request, sleep: async () => {} }),
            intervalMs: 0,
            graceMs: 0,
            log: () => {},
        }).sweep();

    it('never marks a suspended runner Job unread', async () => {
        const arm = createKubernetesReaper({ config, request: router(lists([suspendedRunner])).request });
        expect((await arm.scan())![0]!.objects).toEqual([{ kind: 'job', name: runnerJob, uid: 'uid-1', runner: true }]);
    });

    it('reaps a suspended runner of a terminal job Secret first, then the Job', async () => {
        const { request, calls } = router([
            ...lists([suspendedRunner]),
            ...secrets.map((path) => ['DELETE', path, { status: 200, body: '' }] as const),
        ]);
        await sweep(request);
        expect(deleteCalls(calls)).toEqual([
            ...secrets,
            `${jobsPath(NAMESPACE)}/${runnerJob}?propagationPolicy=Foreground`,
        ]);
    });

    it('stops the round at a refused Secret delete, the suspended Job still listed', async () => {
        const { request, calls } = router([
            ...lists([suspendedRunner]),
            ['DELETE', secrets[0]!, { status: 500, body: '' }],
        ]);
        await sweep(request);
        expect(deleteCalls(calls)).toEqual(secrets);
    });

    const reapGone = async (extra: readonly (readonly [K8sMethod, string, K8sResponse])[]) => {
        const { request, calls } = router([...extra, claimRead, ['DELETE', claimPath, { status: 200, body: '' }]]);
        const arm = createKubernetesReaper({ config, request, sleep: async () => {} });
        await arm.reap({ ...group(), objects: [{ kind: 'job', name: runnerJob }] }, 'gone');
        // Any delete of the claim, whatever its query: none may be issued on an unconfirmed end.
        return deleteCalls(calls).some((path) => path === claimPath || path.startsWith(`${claimPath}?`));
    };

    it('deletes a gone job’s claim once its holder’s groups are confirmed gone', async () => {
        expect(await reapGone([])).toBe(true);
    });

    it('keeps the claim when the Job delete of the round failed', async () => {
        expect(
            await reapGone([
                [
                    'DELETE',
                    `${jobsPath(NAMESPACE)}/${runnerJob}?propagationPolicy=Foreground`,
                    { status: 500, body: '' },
                ],
            ])
        ).toBe(false);
    });

    it('keeps the claim while the Job deletion is still pending through the bound', async () => {
        expect(
            await reapGone([
                ['GET', `${jobsPath(NAMESPACE)}/${runnerJob}`, { status: 200, body: JSON.stringify({ status: {} }) }],
            ])
        ).toBe(false);
    });

    it('keeps the claim while a writer pod of the holder is still listed', async () => {
        const writers = `${podsPath(NAMESPACE)}?labelSelector=${encodeURIComponent(`${JOB_LABEL}=${JOB},${LEASE_LABEL}=${LEASE}`)}`;
        expect(
            await reapGone([
                ['GET', writers, { status: 200, body: JSON.stringify({ items: [{ metadata: { name: 'gate' } }] }) }],
            ])
        ).toBe(false);
    });
});

/*
 * Issue #821 review, round 3: the claim a reaped group's job holds may already be a replacement's
 * — the task reopened after the board answered terminal. The reaper acts only for the condemned
 * attempt: a claim whose holder is neither its lease nor the reclaim token derived from it is left
 * alone, and nothing of that holder is deleted.
 */
describe('the kubernetes reaper arm: only the condemned attempt’s claim (#821)', () => {
    const OTHER = '99999999-9999-4999-8999-999999999999';
    const claimPath = `${configmapsPath(NAMESPACE)}/factory-job-${JOB}-claim`;
    const reapWithHolder = async (holder: string) => {
        const { request, calls } = router([
            [
                'GET',
                claimPath,
                { status: 200, body: JSON.stringify({ metadata: { uid: 'claim-uid-9' }, data: { holder } }) },
            ],
            ['DELETE', claimPath, { status: 200, body: '' }],
        ]);
        await createKubernetesReaper({ config, request, sleep: async () => {} }).reap(group(), 'gone');
        return deleteCalls(calls);
    };

    it("deletes nothing of a replacement holder's, and not its claim", async () => {
        const deletes = await reapWithHolder(OTHER);
        const other = { id: JOB, leaseToken: OTHER } as BoardJob;
        expect(deletes.some((path) => path.includes(OTHER) || path.includes(runnerJobName(other)))).toBe(false);
        expect(deletes.some((path) => path.includes(secretName(other)))).toBe(false);
        expect(deletes.some((path) => path.startsWith(claimPath))).toBe(false);
    });

    it("still reaps the condemned attempt's own claim", async () => {
        expect((await reapWithHolder(LEASE)).some((path) => path === claimPath)).toBe(true);
    });
});

describe('the kubernetes reaper arm: a live job’s runner Job is the fence’s (#821)', () => {
    const runnerJob = runnerJobName({ id: JOB, leaseToken: LEASE } as BoardJob);
    const running = {
        metadata: {
            name: runnerJob,
            uid: 'uid-1',
            labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE },
            creationTimestamp: '2026-10-01T00:00:00Z',
        },
        spec: { template: { spec: { containers: [{ name: 'supervisor' }, { name: 'agent' }] } } },
        status: { active: 1 },
    };
    const lists: readonly (readonly [K8sMethod, string, K8sResponse])[] = [
        ['GET', LIST_JOBS, { status: 200, body: JSON.stringify({ items: [running] }) }],
    ];
    const sweep = async (lease: { leaseToken: string | null; status: string }) => {
        const { request, calls } = router(lists);
        await createReaper({
            board: { leases: async () => [{ id: JOB, ...lease }] as never },
            arm: createKubernetesReaper({ config, request, sleep: async () => {} }),
            intervalMs: 0,
            graceMs: 0,
            log: () => {},
        }).sweep();
        return deleteCalls(calls);
    };

    it('deletes nothing of a superseded attempt’s runner while the job lives, even one listed running', async () => {
        expect(await sweep({ leaseToken: '99999999-9999-4999-8999-999999999999', status: 'running' })).toEqual([]);
    });

    it('reaps it, Secrets first, once the job is terminal', async () => {
        const deletes = await sweep({ leaseToken: null, status: 'failed' });
        expect(
            deletes.at(-1)?.startsWith(`${jobsPath(NAMESPACE)}/${runnerJob}?`) ||
                deletes.includes(`${jobsPath(NAMESPACE)}/${runnerJob}?propagationPolicy=Foreground`)
        ).toBe(true);
        expect(deletes.findIndex((path) => path.startsWith(secretsPath(NAMESPACE)))).toBe(0);
    });
});

/*
 * Issue #821 review, round 6: the reaper deletes the incarnation it listed, by uid, and never a
 * reclaim group's derived-name Secret by name — the Job owns it, and goes by uid.
 */
describe('the kubernetes reaper arm: listed incarnations only (#821)', () => {
    it('deletes a listed Job by the uid it was listed with', async () => {
        const { request, calls } = router([]);
        await createKubernetesReaper({ config, request, sleep: async () => {} }).reap(
            { ...group(), objects: [{ kind: 'job', name: 'factory-gate-x', uid: 'listed-uid' }] },
            'gone'
        );
        expect(
            calls.find(
                (call) => call.method === 'DELETE' && call.path.startsWith(`${jobsPath(NAMESPACE)}/factory-gate-x?`)
            )?.body
        ).toEqual({
            apiVersion: 'v1',
            kind: 'DeleteOptions',
            preconditions: { uid: 'listed-uid' },
        });
    });

    // A reclaim group's names are its invocation's own (random lease): its Secrets go first, like any attempt's.
    it('deletes a reclaim group’s Secrets before its Job, by the names its own lease derives', async () => {
        const { request, calls } = router([]);
        await createKubernetesReaper({ config, request, sleep: async () => {} }).reap(
            { ...group(), objects: [{ kind: 'job', name: 'factory-reclaim-0123456789abcdef', uid: 'listed-uid' }] },
            'gone'
        );
        const deletes = deleteCalls(calls);
        const jobAt = deletes.findIndex((path) => path.includes('factory-reclaim-0123456789abcdef'));
        expect(deletes.findIndex((path) => path.startsWith(secretsPath(NAMESPACE)))).toBe(0);
        expect(jobAt).toBeGreaterThan(0);
    });
});

describe('the kubernetes reaper arm: a 409 on a listed uid is no removal (#821)', () => {
    it('keeps the claim when a listed object answers its uid precondition with 409', async () => {
        const claimPath = `${configmapsPath(NAMESPACE)}/factory-job-${JOB}-claim`;
        const runnerJob = runnerJobName({ id: JOB, leaseToken: LEASE } as BoardJob);
        const { request, calls } = router([
            ['DELETE', `${jobsPath(NAMESPACE)}/${runnerJob}?propagationPolicy=Foreground`, { status: 409, body: '' }],
            [
                'GET',
                claimPath,
                { status: 200, body: JSON.stringify({ metadata: { uid: 'claim-uid-1' }, data: { holder: LEASE } }) },
            ],
            ['DELETE', claimPath, { status: 200, body: '' }],
        ]);
        await createKubernetesReaper({ config, request, sleep: async () => {} }).reap(
            { ...group(), objects: [{ kind: 'job', name: runnerJob, uid: 'listed-uid' }] },
            'gone'
        );
        expect(deleteCalls(calls).some((path) => path.startsWith(claimPath))).toBe(false);
    });
});

describe('the kubernetes reaper arm: task volumes (issue #775)', () => {
    const ROOT = '11111111-1111-4111-8111-111111111111';
    const OTHER = '44444444-4444-4444-8444-444444444444';
    const LIST_VOLUMES = `${taskVolumesPath(NAMESPACE)}?labelSelector=${encodeURIComponent(TASK_ROOT_LABEL)}`;
    const claim = (root: string, generation: number, extra: Record<string, unknown> = {}, labels = {}) => ({
        metadata: {
            name: `factory-task-${root}-${generation}`,
            uid: `uid-${root.slice(0, 4)}-${generation}`,
            labels: { [TASK_ROOT_LABEL]: root, [TASK_BOARD_LABEL]: boardIdentity(config), ...labels },
            ...extra,
        },
    });
    const listing = (items: unknown[], status = 200): readonly [K8sMethod, string, K8sResponse] => [
        'GET',
        LIST_VOLUMES,
        { status, body: JSON.stringify({ items }) },
    ];
    const armOver = (answers: readonly (readonly [K8sMethod, string, K8sResponse])[]) => {
        const { request, calls } = router(answers);
        return { arm: createKubernetesReaper({ config, request }), calls };
    };

    it('lists every generation by the root label, grouped by root, unschedulable ones included', async () => {
        const { arm } = armOver([
            listing([claim(ROOT, 1), claim(ROOT, 2, {}, { [TASK_UNSCHEDULABLE_LABEL]: 'true' }), claim(OTHER, 1)]),
        ]);
        const listed = await arm.scanVolumes!();
        expect(listed!.threads).toEqual([
            {
                root: ROOT,
                volumes: [
                    { name: `factory-task-${ROOT}-1`, uid: `uid-1111-1`, createdAtMs: null },
                    { name: `factory-task-${ROOT}-2`, uid: `uid-1111-2`, createdAtMs: null },
                ],
            },
            { root: OTHER, volumes: [{ name: `factory-task-${OTHER}-1`, uid: `uid-4444-1`, createdAtMs: null }] },
        ]);
        expect(listed!.skipped).toEqual([]);
    });

    it('carries the claim’s creationTimestamp, null when it has none', async () => {
        const { arm } = armOver([
            listing([claim(ROOT, 1, { creationTimestamp: '2026-10-01T00:00:00Z' }), claim(ROOT, 2)]),
        ]);
        const volumes = (await arm.scanVolumes!())!.threads[0]!.volumes;
        expect(volumes.map((volume) => volume.createdAtMs)).toEqual([Date.parse('2026-10-01T00:00:00Z'), null]);
    });

    it.each([
        ['a claim whose root label is no uuid', claim('not-a-uuid', 1)],
        ['a claim whose name is no generation of its root', claim(ROOT, 1, { name: 'factory-task-x' })],
    ])('skips and names %s without discarding the rest of the listing', async (_name, junk) => {
        const { arm } = armOver([listing([junk, claim(OTHER, 1)])]);
        const listed = (await arm.scanVolumes!())!;
        expect(listed.threads.map((thread) => thread.root)).toEqual([OTHER]);
        expect(listed.skipped).toHaveLength(1);
    });

    it.each([
        ['another board', { [TASK_BOARD_LABEL]: 'ffffffffffffffff' }],
        ['no board at all', { [TASK_BOARD_LABEL]: undefined }],
    ])('never lists a claim made for %s: only this board’s volumes are ever reaped', async (_name, labels) => {
        const { arm } = armOver([listing([claim(ROOT, 1), claim(OTHER, 1, {}, labels)])]);
        const listed = (await arm.scanVolumes!())!;
        expect(listed.threads.map((thread) => thread.root)).toEqual([ROOT]);
        expect(listed.skipped).toEqual([]);
    });

    it('leaves a claim that is already terminating to its deletion', async () => {
        const { arm } = armOver([listing([claim(ROOT, 1, { deletionTimestamp: '2026-10-01T00:00:00Z' })])]);
        expect(await arm.scanVolumes!()).toEqual({ threads: [], skipped: [] });
    });

    it.each([
        ['a refused list', [listing([], 500)]],
        ['a transport failure', []],
        ['a claim without a uid', [listing([claim(ROOT, 1, { uid: undefined })])]],
    ] as const)('answers null — delete nothing — on %s', async (_name, answers) => {
        const { arm } = armOver(answers);
        expect(await arm.scanVolumes!()).toBeNull();
    });

    it('deletes every generation of a thread, each under the uid it was listed with', async () => {
        const { arm, calls } = armOver([
            ['DELETE', `${taskVolumesPath(NAMESPACE)}/factory-task-${ROOT}-1`, { status: 200, body: '' }],
            ['DELETE', `${taskVolumesPath(NAMESPACE)}/factory-task-${ROOT}-2`, { status: 200, body: '' }],
        ]);
        const removed = await arm.reapVolumes!({
            root: ROOT,
            volumes: [
                { name: `factory-task-${ROOT}-1`, uid: 'u1' },
                { name: `factory-task-${ROOT}-2`, uid: 'u2' },
            ],
        });
        expect(removed).toEqual([`volume factory-task-${ROOT}-1`, `volume factory-task-${ROOT}-2`]);
        expect(calls.map((c) => c.body)).toEqual([
            { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'u1' } },
            { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'u2' } },
        ]);
    });

    it('does not report a generation whose delete failed or met another incarnation, and goes on', async () => {
        const { arm } = armOver([
            ['DELETE', `${taskVolumesPath(NAMESPACE)}/factory-task-${ROOT}-1`, { status: 409, body: '' }],
            ['DELETE', `${taskVolumesPath(NAMESPACE)}/factory-task-${ROOT}-2`, { status: 200, body: '' }],
        ]);
        const removed = await arm.reapVolumes!({
            root: ROOT,
            volumes: [
                { name: `factory-task-${ROOT}-1`, uid: 'u1' },
                { name: `factory-task-${ROOT}-2`, uid: 'u2' },
            ],
        });
        expect(removed).toEqual([`volume factory-task-${ROOT}-2`]);
    });

    describe('swept with the board', () => {
        const FINAL = Date.parse('2026-10-01T00:00:00Z');
        const HOUR = 3_600_000;
        const factsOf = (over: Record<string, unknown> = {}) => ({
            live: false,
            lastFinalizedAt: new Date(FINAL).toISOString(),
            artifactsComplete: true,
            checkpoint: 'complete' as const,
            checkpointFinalizedAt: new Date(FINAL).toISOString(),
            ...over,
        });
        const sweep = async (
            thread: ReturnType<typeof factsOf>,
            ageH: number,
            listed = [claim(ROOT, 1), claim(ROOT, 2)]
        ) => {
            const { arm, calls } = armOver([
                listing(listed),
                ['DELETE', `${taskVolumesPath(NAMESPACE)}/factory-task-${ROOT}-1`, { status: 200, body: '' }],
                ['DELETE', `${taskVolumesPath(NAMESPACE)}/factory-task-${ROOT}-2`, { status: 200, body: '' }],
            ]);
            await createReaper({
                board: { leases: async () => [{ id: ROOT, status: 'succeeded', leaseToken: null, thread }] },
                arm,
                intervalMs: 0,
                graceMs: 0,
                volumePolicy: { ttlMs: 24 * HOUR, boundMs: 168 * HOUR },
                now: () => FINAL + ageH * HOUR,
                log: () => undefined,
            }).sweep();
            return deleteCalls(calls);
        };

        it('deletes all generations after the ttl, together', async () => {
            expect(await sweep(factsOf(), 25)).toEqual([
                `${taskVolumesPath(NAMESPACE)}/factory-task-${ROOT}-1`,
                `${taskVolumesPath(NAMESPACE)}/factory-task-${ROOT}-2`,
            ]);
        });

        it.each([
            ['inside the ttl', factsOf(), 23],
            ['while a job is live', factsOf({ live: true }), 500],
            ['while artifacts are pending', factsOf({ artifactsComplete: false }), 100],
            ['while the checkpoint is truncated', factsOf({ checkpoint: 'truncated' }), 100],
            ['when the last attempt never finalized', factsOf({ lastFinalizedAt: null }), 500],
        ])('keeps the volumes %s', async (_name, facts, ageH) => {
            expect(await sweep(facts, ageH)).toEqual([]);
        });

        it('deletes a truncated thread only at the bound', async () => {
            expect(await sweep(factsOf({ checkpoint: 'truncated' }), 169)).toHaveLength(2);
        });

        it('deletes nothing when the claim list is refused', async () => {
            const { arm, calls } = armOver([listing([], 500)]);
            await createReaper({
                board: { leases: async () => [{ id: ROOT, status: 'succeeded', leaseToken: null, thread: factsOf() }] },
                arm,
                intervalMs: 0,
                graceMs: 0,
                volumePolicy: { ttlMs: HOUR, boundMs: HOUR },
                now: () => FINAL + 500 * HOUR,
                log: () => undefined,
            }).sweep();
            expect(deleteCalls(calls)).toEqual([]);
        });
    });
});

describe('a sweep over the real kubernetes arm (issue #831)', () => {
    it('is aborted, never ok, when the Job list fails but the volume list is proven', async () => {
        const LIST_VOLUMES = `${taskVolumesPath(NAMESPACE)}?labelSelector=${encodeURIComponent(TASK_ROOT_LABEL)}`;
        const { request, calls } = router([
            ['GET', LIST_JOBS, { status: 503, body: '' }],
            ['GET', LIST_VOLUMES, { status: 200, body: JSON.stringify({ items: [] }) }],
        ]);
        const outcomes: string[] = [];
        const reaper = createReaper({
            board: { leases: async () => [] },
            arm: createKubernetesReaper({ config, request }),
            intervalMs: 3_600_000,
            graceMs: 0,
            log: () => undefined,
            volumePolicy: { ttlMs: 1, boundMs: 1 },
            observe: { sweep: (outcome) => void outcomes.push(outcome), scanned: () => undefined },
        });
        await reaper.sweep();
        expect(outcomes).toEqual(['aborted']);
        expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    });
});
