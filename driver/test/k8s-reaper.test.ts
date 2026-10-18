import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { JOB_LABEL, LEASE_LABEL } from '../src/labels.js';
import { configmapsPath, podsPath, secretsPath, servicesPath } from '../src/k8s-auxspec.js';
import { gateEnvSecretName, jobsPath, runnerJobName, secretName } from '../src/k8s-podspec.js';
import { createKubernetesReaper } from '../src/k8s-reaper.js';
import type { K8sMethod, K8sRequest, K8sResponse } from '../src/k8s-transport.js';
import { createReaper, type OrphanGroup } from '../src/reaper.js';

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

const pod = (name: string, jobId: string, lease: string, created: string) => ({
    metadata: {
        name,
        labels: { [JOB_LABEL]: jobId, [LEASE_LABEL]: lease, 'factory.service': 'postgres' },
        creationTimestamp: created,
    },
});

const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NAMESPACE });

const LIST_JOBS = `${jobsPath(NAMESPACE)}?labelSelector=${encodeURIComponent('factory.job,factory.lease')}`;
const LIST_PODS = `${podsPath(NAMESPACE)}?labelSelector=${encodeURIComponent('factory.job,factory.service')}`;
const LIST_SERVICES = `${servicesPath(NAMESPACE)}?labelSelector=${encodeURIComponent('factory.job,factory.service')}`;

const deleteCalls = (calls: readonly Recorded[]) =>
    calls.filter((call) => call.method === 'DELETE').map((call) => call.path);

const group = (overrides: Partial<OrphanGroup> = {}): OrphanGroup => ({
    jobId: JOB,
    leaseToken: LEASE,
    createdAtMs: 0,
    objects: [
        { kind: 'pod', name: `${JOB}-${LEASE}-svc-postgres` },
        { kind: 'service', name: `factory-svc-abc` },
    ],
    ...overrides,
});

describe('the kubernetes reaper arm: scan', () => {
    it('lists service resources and attempt Jobs', async () => {
        const body = JSON.stringify({ items: [] });
        const { request, calls } = router([
            ['GET', LIST_PODS, { status: 200, body }],
            ['GET', LIST_SERVICES, { status: 200, body }],
        ]);
        const arm = createKubernetesReaper({ config, request });

        await arm.scan();

        expect(calls).toEqual([
            { method: 'GET', path: LIST_PODS },
            { method: 'GET', path: LIST_SERVICES },
            { method: 'GET', path: LIST_JOBS },
        ]);
    });

    it('scopes the selector to this release when one is configured', async () => {
        const scoped = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NAMESPACE, K8S_RELEASE: 'factory' });
        const expected = `${podsPath(NAMESPACE)}?labelSelector=${encodeURIComponent(
            'factory.job,factory.service,app.kubernetes.io/instance=factory'
        )}`;
        const body = JSON.stringify({ items: [] });
        const { request, calls } = router([
            ['GET', expected, { status: 200, body }],
            [
                'GET',
                `${servicesPath(NAMESPACE)}?labelSelector=${encodeURIComponent(
                    'factory.job,factory.service,app.kubernetes.io/instance=factory'
                )}`,
                { status: 200, body },
            ],
        ]);
        const arm = createKubernetesReaper({ config: scoped, request });

        await arm.scan();

        // The release term is load-bearing: two releases sharing a namespace against different
        // boards must never reap each other's fleets as "unknown jobs".
        expect(calls[0]?.path).toBe(expected);
        expect(calls[2]?.path).toBe(
            `${jobsPath(NAMESPACE)}?labelSelector=${encodeURIComponent(
                'factory.job,factory.lease,app.kubernetes.io/instance=factory'
            )}`
        );
    });

    it('groups by job and lease, keeping the oldest creationTimestamp of the group', async () => {
        const pods = JSON.stringify({
            items: [
                pod('old-pod', JOB, LEASE, '2026-09-01T00:00:00Z'),
                pod('new-pod', JOB, LEASE, '2026-09-02T00:00:00Z'),
            ],
        });
        const services = JSON.stringify({ items: [] });
        const { request } = router([
            ['GET', LIST_PODS, { status: 200, body: pods }],
            ['GET', LIST_SERVICES, { status: 200, body: services }],
        ]);
        const arm = createKubernetesReaper({ config, request });

        const groups = await arm.scan();

        expect(groups).toEqual([
            {
                jobId: JOB,
                leaseToken: LEASE,
                // The OLDEST creationTimestamp — the grace window is measured from the moment
                // the fleet began to exist, not from the youngest pod in it.
                createdAtMs: Date.parse('2026-09-01T00:00:00Z'),
                objects: [
                    { kind: 'pod', name: 'old-pod' },
                    { kind: 'pod', name: 'new-pod' },
                ],
            },
        ]);
    });

    it('skips rows missing either label, and objects the API has not named', async () => {
        const pods = JSON.stringify({
            items: [
                pod('good', JOB, LEASE, '2026-09-01T00:00:00Z'),
                // A runner pod: factory.job + factory.lease but no factory.service — never reaped here.
                {
                    metadata: { name: 'runner-pod', labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE } },
                },
                // Unlabelled junk never becomes somebody's orphan.
                { metadata: { name: 'junk' } },
                { metadata: { labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE } } },
            ],
        });
        const { request } = router([
            ['GET', LIST_PODS, { status: 200, body: pods }],
            ['GET', LIST_SERVICES, { status: 200, body: JSON.stringify({ items: [] }) }],
        ]);
        const arm = createKubernetesReaper({ config, request });

        const groups = await arm.scan();

        expect(groups).toEqual([
            {
                jobId: JOB,
                leaseToken: LEASE,
                createdAtMs: Date.parse('2026-09-01T00:00:00Z'),
                objects: [{ kind: 'pod', name: 'good' }],
            },
        ]);
    });

    it('defers the entire scan when Jobs cannot be listed', async () => {
        const empty = { status: 200, body: JSON.stringify({ items: [] }) };
        const { request } = router([
            ['GET', LIST_PODS, empty],
            ['GET', LIST_SERVICES, empty],
            ['GET', LIST_JOBS, { status: 403, body: '{}' }],
        ]);
        await expect(createKubernetesReaper({ config, request }).scan()).resolves.toEqual([]);
    });

    it('answers nothing when either list cannot be read — inconclusive reaps nothing', async () => {
        const failing = router([['GET', LIST_SERVICES, { status: 200, body: JSON.stringify({ items: [] }) }]], 500);
        const arm = createKubernetesReaper({ config, request: failing.request });
        await expect(arm.scan()).resolves.toEqual([]);

        const throwing: K8sRequest = async () => {
            throw new Error('connection reset');
        };
        const arm2 = createKubernetesReaper({ config, request: throwing });
        await expect(arm2.scan()).resolves.toEqual([]);
    });
});

describe('the kubernetes reaper arm: reap', () => {
    const emptyLists: readonly (readonly [K8sMethod, string, K8sResponse])[] = [
        ['GET', LIST_PODS, { status: 200, body: JSON.stringify({ items: [] }) }],
        ['GET', LIST_SERVICES, { status: 200, body: JSON.stringify({ items: [] }) }],
    ];

    it('deletes each pod and Service by name with Foreground propagation, tolerating 404/409', async () => {
        const { request, calls } = router([
            ...emptyLists,
            [
                'DELETE',
                `${podsPath(NAMESPACE)}/${JOB}-${LEASE}-svc-postgres?propagationPolicy=Foreground`,
                { status: 200, body: '' },
            ],
            [
                'DELETE',
                `${servicesPath(NAMESPACE)}/factory-svc-abc?propagationPolicy=Foreground`,
                { status: 200, body: '' },
            ],
        ]);
        const arm = createKubernetesReaper({ config, request });

        const removed = await arm.reap(group(), 'gone');

        expect(removed).toEqual([`pod ${JOB}-${LEASE}-svc-postgres`, 'service factory-svc-abc']);
        const fleet = deleteCalls(calls).filter((path) => !path.startsWith(secretsPath(NAMESPACE)));
        expect(fleet).toEqual([
            `${podsPath(NAMESPACE)}/${JOB}-${LEASE}-svc-postgres?propagationPolicy=Foreground`,
            `${servicesPath(NAMESPACE)}/factory-svc-abc?propagationPolicy=Foreground`,
            // The checkout claim is pinned in full below — here the read answers nothing (this
            // router models a claim that was already released), so nothing is deleted on a maybe.
        ]);
    });

    it('reads 404 and 409 as the object already going away, and keeps the answer honest', async () => {
        const { request } = router([
            ...emptyLists,
            ['DELETE', `${podsPath(NAMESPACE)}/svc-postgres?propagationPolicy=Foreground`, { status: 404, body: '' }],
            [
                'DELETE',
                `${servicesPath(NAMESPACE)}/factory-svc-abc?propagationPolicy=Foreground`,
                { status: 409, body: '' },
            ],
        ]);
        const arm = createKubernetesReaper({ config, request });

        expect(await arm.reap(group(), 'gone')).toEqual([]);
    });

    it('deletes the attempt-scoped env Secrets by their derived names, and answers them to the log', async () => {
        const runnerSecret = `${secretsPath(NAMESPACE)}/${secretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob)}`;
        const { request, calls } = router([
            ...emptyLists,
            [
                'DELETE',
                `${podsPath(NAMESPACE)}/${JOB}-${LEASE}-svc-postgres?propagationPolicy=Foreground`,
                { status: 200, body: '' },
            ],
            ['DELETE', runnerSecret, { status: 200, body: '' }],
        ]);
        const arm = createKubernetesReaper({ config, request });

        const removed = await arm.reap(group(), 'gone');

        const secrets = deleteCalls(calls).filter((path) => path.startsWith(secretsPath(NAMESPACE)));
        expect(secrets).toEqual([
            runnerSecret,
            `${secretsPath(NAMESPACE)}/${gateEnvSecretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob)}`,
        ]);
        // A 2xx Secret delete is a removal like any other; the gate Secret’s 404 is not.
        expect(removed).toContain(`secret ${runnerSecret.split('/').pop()}`);
    });

    it('deletes the checkout claim only when the job is gone, by uid precondition, never while a replacement lives', async () => {
        const claimPath = `${configmapsPath(NAMESPACE)}/factory-job-${JOB}-claim`;
        const { request, calls } = router([
            ...emptyLists,
            // The read the precondition is built from — the fence's own release shape, holder and all.
            [
                'GET',
                claimPath,
                { status: 200, body: JSON.stringify({ metadata: { uid: 'claim-uid-1' }, data: { holder: LEASE } }) },
            ],
            ['DELETE', claimPath, { status: 200, body: '' }],
        ]);
        const arm = createKubernetesReaper({ config, request });

        await arm.reap(group(), 'gone');
        // The one way a claim goes (issue #821): its holder's groups confirmed ended, then the delete.
        expect(deleteCalls(calls)).toContainEqual(claimPath);
        // The delete can only ever reach the exact incarnation this call read.
        const claimDelete = calls.find((call) => call.method === 'DELETE' && call.path === claimPath);
        expect(claimDelete?.body).toEqual({
            apiVersion: 'v1',
            kind: 'DeleteOptions',
            preconditions: { uid: 'claim-uid-1' },
        });

        const superseded = router([...emptyLists], 404);
        const arm2 = createKubernetesReaper({ config, request: superseded.request });
        await arm2.reap(group(), 'superseded');
        // A live replacement attempt holds the claim; the reaper must never touch it.
        expect(deleteCalls(superseded.calls).some((path) => path.startsWith(configmapsPath(NAMESPACE)))).toBe(false);
    });

    it('defers the claim when the read cannot identify an incarnation — never a delete on a maybe', async () => {
        const claimPath = `${configmapsPath(NAMESPACE)}/factory-job-${JOB}-claim`;
        const { request, calls } = router([
            ...emptyLists,
            // 2xx but no uid: garbage is never proof of anything, and an UNCONDITIONED delete
            // could reach a newer claim. Nothing is deleted; the next round reads again.
            ['GET', claimPath, { status: 200, body: JSON.stringify({ metadata: {} }) }],
        ]);
        const arm = createKubernetesReaper({ config, request });

        await arm.reap(group(), 'gone');

        expect(deleteCalls(calls).some((path) => path.startsWith(configmapsPath(NAMESPACE)))).toBe(false);
    });

    it('deletes the derived Secrets BEFORE the Pod and Service, and stops the round when one fails', async () => {
        // Once the listed Pod and Service are gone, no next scan can rediscover the (job, lease)
        // pair to re-derive these names — a Secret has no ownerReferences. So a failed Secret
        // delete must hold back the fleet: here the FIRST Secret answers 500, and nothing but
        // that one Secret may be deleted all round.
        const names = [
            secretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob),
            gateEnvSecretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob),
        ].map((name) => `${secretsPath(NAMESPACE)}/${name}`);
        const { request, calls } = router([['DELETE', names[0]!, { status: 500, body: '' }]]);
        const arm = createKubernetesReaper({ config, request });

        const removed = await arm.reap(group(), 'gone');

        expect(removed).toEqual([]);
        expect(deleteCalls(calls)).toEqual([names[0]]);
    });

    it('deletes Secrets ahead of the fleet, and 404 Secrets do not block teardown', async () => {
        const names = [
            secretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob),
            gateEnvSecretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob),
        ].map((name) => `${secretsPath(NAMESPACE)}/${name}`);
        const { request, calls } = router([
            ...names.map((path): readonly [K8sMethod, string, K8sResponse] => [
                'DELETE',
                path,
                { status: 404, body: '' },
            ]),
            ...[
                `${podsPath(NAMESPACE)}/${JOB}-${LEASE}-svc-postgres?propagationPolicy=Foreground`,
                `${servicesPath(NAMESPACE)}/factory-svc-abc?propagationPolicy=Foreground`,
            ].map((path): readonly [K8sMethod, string, K8sResponse] => ['DELETE', path, { status: 200, body: '' }]),
        ]);
        const arm = createKubernetesReaper({ config, request });

        const removed = await arm.reap(group(), 'gone');

        // Ordering is the point: the two Secret deletes are the FIRST two calls, before any
        // fleet object — and already-gone Secrets never hold the round back.
        expect(deleteCalls(calls).slice(0, names.length)).toEqual(names);
        expect(removed).toEqual([`pod ${JOB}-${LEASE}-svc-postgres`, 'service factory-svc-abc']);
    });

    it('answers what it removed without throwing on any single delete failure', async () => {
        const failing: K8sRequest = async (method) => {
            if (method === 'DELETE') throw new Error('connection reset');
            return { status: 200, body: JSON.stringify({ items: [] }) };
        };
        const arm = createKubernetesReaper({ config, request: failing });

        expect(await arm.reap(group(), 'gone')).toEqual([]);
    });
});

// Issue #792: a runner that finished after its driver died is the next claim's to read. Superseded
// is no reason to delete it — only a job that can never be claimed again (gone) is.
describe('the kubernetes reaper arm: an unread finished runner', () => {
    const runnerJob = runnerJobName({ id: JOB, leaseToken: LEASE } as BoardJob);
    const finishedRunner = {
        metadata: {
            name: runnerJob,
            labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE },
            creationTimestamp: '2026-10-01T00:00:00Z',
        },
        // A Job that ran an agent: a supervisor-only group's is no run to adopt (issue #821).
        spec: { template: { spec: { containers: [{ name: 'supervisor' }, { name: 'agent' }] } } },
        status: { succeeded: 1 },
    };
    const lists = (jobs: unknown[]): readonly (readonly [K8sMethod, string, K8sResponse])[] => [
        ['GET', LIST_JOBS, { status: 200, body: JSON.stringify({ items: jobs }) }],
        ['GET', LIST_PODS, { status: 200, body: JSON.stringify({ items: [] }) }],
        ['GET', LIST_SERVICES, { status: 200, body: JSON.stringify({ items: [] }) }],
    ];

    it('marks a finished runner Job unread on the scan, and a running one not', async () => {
        const running = { ...finishedRunner, status: { active: 1 } };
        const arm = createKubernetesReaper({ config, request: router(lists([finishedRunner])).request });
        expect((await arm.scan())[0]!.objects).toEqual([{ kind: 'job', name: runnerJob, unread: true, runner: true }]);

        const live = createKubernetesReaper({ config, request: router(lists([running])).request });
        expect((await live.scan())[0]!.objects).toEqual([{ kind: 'job', name: runnerJob, runner: true }]);
    });

    // A supervisor-only group's Job (an agentless node, the group an adoption made) ran no agent:
    // no run to adopt, so nothing to spare (issue #821).
    it('never marks a finished supervisor-only Job unread', async () => {
        const supervisorOnly = {
            ...finishedRunner,
            spec: { template: { spec: { containers: [{ name: 'supervisor' }] } } },
        };
        const arm = createKubernetesReaper({ config, request: router(lists([supervisorOnly])).request });
        expect((await arm.scan())[0]!.objects).toEqual([{ kind: 'job', name: runnerJob, runner: true }]);
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
            labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE },
            creationTimestamp: '2026-09-01T00:00:00Z',
            annotations: { 'bellows.ai/paused-deadline': JSON.stringify({ deadline: 60, at: 1 }) },
        },
        spec: { activeDeadlineSeconds: null },
    };
    const lists: readonly (readonly [K8sMethod, string, K8sResponse])[] = [
        ['GET', LIST_PODS, { status: 200, body: JSON.stringify({ items: [] }) }],
        ['GET', LIST_SERVICES, { status: 200, body: JSON.stringify({ items: [] }) }],
        ['GET', LIST_JOBS, { status: 200, body: JSON.stringify({ items: [pausedJob] }) }],
    ];

    it.each(['gone', 'superseded', 'unclaimed', 'live', 'unreachable'] as const)(
        'reaps a service-free paused Job only when the board condemns its lease: %s',
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
            labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE },
            creationTimestamp: '2026-10-01T00:00:00Z',
        },
        spec: { suspend: true },
        status: { failed: 1 },
    };
    const lists = (jobs: unknown[]): readonly (readonly [K8sMethod, string, K8sResponse])[] => [
        ['GET', LIST_JOBS, { status: 200, body: JSON.stringify({ items: jobs }) }],
        ['GET', LIST_PODS, { status: 200, body: JSON.stringify({ items: [] }) }],
        ['GET', LIST_SERVICES, { status: 200, body: JSON.stringify({ items: [] }) }],
    ];
    const claimRead: readonly [K8sMethod, string, K8sResponse] = [
        'GET',
        claimPath,
        { status: 200, body: JSON.stringify({ metadata: { uid: 'claim-uid-1' }, data: { holder: LEASE } }) },
    ];
    const secrets = [secretName(pair), gateEnvSecretName(pair)].map((name) => `${secretsPath(NAMESPACE)}/${name}`);
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
        expect((await arm.scan())[0]!.objects).toEqual([{ kind: 'job', name: runnerJob, runner: true }]);
    });

    it('reaps a suspended runner of a terminal job Secrets first, the gate Secret, then the Job', async () => {
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

    it('stops the round at a refused gate Secret delete, the suspended Job still listed', async () => {
        const { request, calls } = router([
            ...lists([suspendedRunner]),
            ['DELETE', secrets[0]!, { status: 200, body: '' }],
            ['DELETE', secrets[1]!, { status: 500, body: '' }],
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
        const writers = `${podsPath(NAMESPACE)}?labelSelector=${encodeURIComponent(`${JOB_LABEL}=${JOB},${LEASE_LABEL}=${LEASE},!factory.service`)}`;
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
        expect(
            deletes.some((path) => path.includes(secretName(other)) || path.includes(gateEnvSecretName(other)))
        ).toBe(false);
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
            labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE },
            creationTimestamp: '2026-10-01T00:00:00Z',
        },
        spec: { template: { spec: { containers: [{ name: 'supervisor' }, { name: 'agent' }] } } },
        status: { active: 1 },
    };
    const lists: readonly (readonly [K8sMethod, string, K8sResponse])[] = [
        ['GET', LIST_JOBS, { status: 200, body: JSON.stringify({ items: [running] }) }],
        ['GET', LIST_PODS, { status: 200, body: JSON.stringify({ items: [] }) }],
        ['GET', LIST_SERVICES, { status: 200, body: JSON.stringify({ items: [] }) }],
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
