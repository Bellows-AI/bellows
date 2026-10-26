import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { loadDriverConfig } from '../src/config.js';
import { jobsPath, runnerJobName, secretName } from '../src/k8s/k8s-podspec.js';
import { holderGroupsOf } from '../src/k8s/k8s-group.js';
import { createKubernetesRunner } from '../src/k8s/k8s-runner.js';
import type { K8sMethod, K8sRequest, K8sResponse } from '../src/k8s/k8s-transport.js';
import { StartupRefused } from '../src/startup-cause.js';
import { TASK_UNSCHEDULABLE_LABEL } from '../src/task-volume.js';
import { taskVolumeServer } from './fixtures/k8s-apiserver.js';
import {
    createStepBroker,
    type StepBroker,
    type StepSink,
    stepLost,
    type SupervisorEndpoint,
} from '../src/step-control.js';
import {
    AGENT_CONTAINER,
    SUPERVISOR_ENV,
    type StepRequest,
    type StepResult,
    type SupervisorReport,
} from '../src/supervisor-contract.js';

/**
 * The kubernetes task group (issue #771): one Job per attempt, created by its first step and ended
 * by the loop's `finish`. What these pin is the acceptance of the change — the sync, the tree probe,
 * the review snapshot, the publish, the helpers and the reclaim create no Job or container of
 * their own — over a fake apiserver that records every object the driver creates.
 */
const NAMESPACE = 'factory';
const USER = '44444444-4444-4444-8444-444444444444';
const SESSION = { id: '33333333-3333-4333-8333-333333333333', resume: false };
const CONTROL_TOKEN = 'supervisor-control-token';
const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NAMESPACE, RUNNER_SERVICES: '0' });

const job = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    attempts: 1,
    maxAttempts: 1,
    lastAttempt: false,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    executorRefusal: null,
    planRefusal: null,
    skillRefusal: null,
    masterPrompt:
        'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone',
    resumeSessionId: null,
    followUp: false,
    ownSession: false,
    continuesInterrupted: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
    rootCommand: 'fix the failing build',
    repo: 'Bellows-AI/factory',
    env: { GITHUB_TOKEN: 'ghs_claim' },
    supervisorEnv: {
        [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130',
        [SUPERVISOR_ENV.controlToken]: CONTROL_TOKEN,
        [SUPERVISOR_ENV.agentToken]: 'tok-agent',
        [SUPERVISOR_ENV.exportToken]: 'tok-export',
    },
} as BoardJob;

const ok = (stdout = ''): StepResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const json = (body: unknown, status = 200): K8sResponse => ({ status, body: JSON.stringify(body) });

interface Created {
    jobs: { name: string; containers: string[] }[];
    secrets: string[];
    deletedJobs: string[];
    deletedSecrets: string[];
}

/** A fake apiserver that keeps the checkout claim honest and records every Job and Secret the driver creates. */
function cluster(
    options: {
        ended?: boolean;
        imagePull?: string;
        agentExit?: number;
        vanished?: boolean;
        /** What the attempt's group Job reads answer, when it answers at all (else the Job as it is). */
        groupJob?: () => K8sResponse | undefined;
        podStatus?: unknown;
        podSpec?: unknown;
        /** The pod list a read answers, read by read; a status code is a list that did not answer. */
        podItems?: (read: number) => unknown[] | number;
    } = {}
) {
    const created: Created = { jobs: [], secrets: [], deletedJobs: [], deletedSecrets: [] };
    const claims = new Map<string, { uid: string; holder: string; claimSeq: string }>();
    const gone = new Set<string>();
    const configmaps = `/api/v1/namespaces/${NAMESPACE}/configmaps`;
    const secrets = `/api/v1/namespaces/${NAMESPACE}/secrets`;
    const serveVolumes = taskVolumeServer(NAMESPACE);
    let podReads = 0;
    const request: K8sRequest = async (method: K8sMethod, path: string, body?: unknown) => {
        const volume = serveVolumes(method, path, body);
        if (volume) return volume;
        if (path === configmaps && method === 'POST') {
            const claim = body as { metadata: { name: string }; data: { holder: string; claimSeq: string } };
            if (claims.has(claim.metadata.name)) return { status: 409, body: '{}' };
            claims.set(claim.metadata.name, { uid: `uid-${claims.size}`, ...claim.data });
            return json({}, 201);
        }
        if (path.startsWith(`${configmaps}/`)) {
            const name = path.slice(configmaps.length + 1);
            const claim = claims.get(name);
            if (method === 'DELETE') {
                claims.delete(name);
                return json({});
            }
            return claim ? json({ metadata: { uid: claim.uid }, data: claim }) : { status: 404, body: '{}' };
        }
        if (path === secrets && method === 'POST') {
            const name = (body as { metadata: { name: string } }).metadata.name;
            created.secrets.push(name);
            return json({ metadata: { uid: `uid-${name}` } }, 201);
        }
        if (path.startsWith(`${secrets}/`)) {
            created.deletedSecrets.push(path.slice(secrets.length + 1));
            return json({});
        }
        if (path === jobsPath(NAMESPACE) && method === 'POST') {
            const spec = body as {
                metadata: { name: string };
                spec: { template: { spec: { containers: { name: string }[] } } };
            };
            gone.delete(spec.metadata.name);
            created.jobs.push({
                name: spec.metadata.name,
                containers: spec.spec.template.spec.containers.map((c) => c.name),
            });
            return json({ metadata: { uid: `uid-${spec.metadata.name}` } }, 201);
        }
        if (path.startsWith(`${jobsPath(NAMESPACE)}/`)) {
            const name = path.slice(jobsPath(NAMESPACE).length + 1).split('?')[0]!;
            if (method === 'DELETE') {
                created.deletedJobs.push(name);
                gone.add(name);
                return json({});
            }
            // A merge patch (the resume of a Job created suspended) lands on a Job that exists.
            if (method === 'PATCH') return gone.has(name) ? { status: 404, body: '{}' } : json({});
            // The attempt's group serves until finished; any other Job (a close-time readout) is long done.
            const isGroup = name === runnerJobName(job);
            // A reclaim group's derived name never created reads 404, as the apiserver answers it.
            const neverMade = name.startsWith('factory-reclaim-') && !created.jobs.some((made) => made.name === name);
            if (gone.has(name) || neverMade || (isGroup && options.vanished)) return { status: 404, body: '{}' };
            const scripted = isGroup ? options.groupJob?.() : undefined;
            if (scripted) return scripted;
            return json({
                metadata: { name, uid: `uid-${name}` },
                status: !isGroup || options.ended ? { succeeded: 1 } : {},
            });
        }
        if (path.endsWith('/log')) return { status: 200, body: '' };
        // The sweep's selector lists, and the pod discovery by `job-name`.
        if (path.includes('labelSelector')) {
            if (!decodeURIComponent(path).includes('job-name=')) return json({ items: [] });
            if (options.podItems) {
                podReads += 1;
                const items = options.podItems(podReads);
                return typeof items === 'number' ? { status: items, body: '' } : json({ items });
            }
            if (options.podStatus) {
                const spec = options.podSpec ? { spec: options.podSpec } : {};
                return json({ items: [{ metadata: { name: 'pod-1' }, ...spec, status: options.podStatus }] });
            }
            if (options.imagePull) {
                return json({
                    items: [
                        {
                            metadata: { name: 'pod-1' },
                            status: {
                                containerStatuses: [
                                    {
                                        name: AGENT_CONTAINER,
                                        state: { waiting: { reason: 'ErrImagePull', message: options.imagePull } },
                                    },
                                ],
                            },
                        },
                    ],
                });
            }
            // A live pod: the agent has exited with its status, the supervisor beside it is still serving.
            return json({
                items: [
                    {
                        metadata: { name: 'pod-1' },
                        status: {
                            phase: 'Running',
                            containerStatuses: [
                                { name: AGENT_CONTAINER, state: { terminated: { exitCode: options.agentExit ?? 0 } } },
                                { name: 'supervisor', state: { running: {} } },
                            ],
                        },
                    },
                ],
            });
        }
        return { status: 404, body: '{}' };
    };
    return { request, created, claims, podReads: () => podReads };
}

/** The supervised-step channel: records every step, answers each by kind, and reports on demand. */
function steps(answer: (step: StepRequest) => StepResult = () => ok(), contacted = true) {
    const submitted: StepRequest[] = [];
    const tokens = new Set<string>();
    const released: string[] = [];
    let report!: (r: SupervisorReport) => void;
    const reported = new Promise<SupervisorReport>((resolve) => {
        report = resolve;
    });
    const sink: StepSink = {
        submit: async (token, step) => {
            tokens.add(token);
            submitted.push(step);
            return answer(step);
        },
        awaitReport: () => reported,
        agentEnded: () => undefined,
        contacted: () => contacted,
        release: (token) => {
            released.push(token);
        },
        attach: () => undefined,
        cancel: () => undefined,
    };
    return { sink, submitted, tokens, report, released };
}

/**
 * The attempt's supervisor played over a real broker: it pulls every step and answers the ones
 * `answer` has a result for, holding the rest unanswered — a supervisor busy with them, or gone.
 */
function supervisedBy(broker: StepBroker, answer: (step: StepRequest) => StepResult | null) {
    let serving = true;
    const pulled: StepRequest[] = [];
    const loop = (async () => {
        while (serving) {
            const step = await broker.next(CONTROL_TOKEN, 20, new AbortController().signal);
            if (!step || step === 'closed') continue;
            pulled.push(step);
            const result = answer(step);
            if (result) broker.settle(CONTROL_TOKEN, step.id, step.invocation, result);
        }
    })();
    return {
        pulled,
        stop: async () => {
            serving = false;
            await loop;
        },
    };
}

const REPORT: SupervisorReport = {
    id: 'report-1',
    outcome: 'completed',
    cause: null,
    agentExit: 0,
    agentEnd: 'exit',
    drained: true,
    serving: true,
};

const FAST = async (): Promise<void> => undefined;
/** A poll pace that lets a supervisor played on timers reach the broker between polls. */
const TICK = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
const runner = (request: K8sRequest, sink: StepSink, endpoint?: SupervisorEndpoint, sleep = FAST) =>
    createKubernetesRunner(config, request, sleep, { steps: sink, ...(endpoint ? { endpoint } : {}) });

const kinds = (s: { submitted: StepRequest[] }): string[] => s.submitted.map((step) => step.kind);

describe('the task group of one attempt', () => {
    it('creates one Job for the whole attempt: the sync, probe, snapshot, publish, helper and finish create none of their own', async () => {
        const api = cluster({ ended: true });
        const s = steps((step) => {
            if (step.kind === 'sync') return ok('{"ok":true,"reason":null,"fingerprint":"fp"}');
            if (step.kind === 'probe') return ok(`${JSON.stringify({ cloned: false })}\n`);
            if (step.kind === 'snapshot') return ok('{"ok":true}');
            if (step.kind === 'helper') return ok('{}');
            return ok();
        });
        const k8s = runner(api.request, s.sink);

        expect(await k8s.syncCheckout(job, undefined, SESSION)).toMatchObject({ ok: true });
        await k8s.probeTree(job);
        await k8s.snapshotTree(job, 'review-1');
        await k8s.runHelper(job, { phase: 'pre', helperId: 'noop', input: {}, githubWriting: false } as never);
        await k8s.publishGit(job, 'ghs_publish_fresh');
        await k8s.finish(job);

        // One Job: the attempt's group — and every step went to its supervisor.
        expect(api.created.jobs).toEqual([
            { name: runnerJobName(job), containers: [AGENT_CONTAINER, 'supervisor', 'exporter'] },
        ]);
        expect(kinds(s)).toEqual(expect.arrayContaining(['sync', 'probe', 'snapshot', 'helper', 'finish']));
        expect(s.tokens).toEqual(new Set([CONTROL_TOKEN]));
        // One Secret — the runner's — under the name the admission policy admits; none for a step.
        expect(api.created.secrets).toEqual([secretName(job)]);
        // The group goes when the attempt does.
        expect(api.created.deletedSecrets).toContain(secretName(job));
    });

    // Issue #983: the gate manager's probes run on kubernetes through the same supervised probe step.
    it('probes the tree around a gate through the attempt’s supervisor, the mutation guard asked since a moment', async () => {
        const api = cluster({ ended: true });
        const s = steps((step) => (step.kind === 'probe' ? ok('{"fingerprint":"fp","mutatedSince":true}\n') : ok()));
        const k8s = runner(api.request, s.sink);

        expect(await k8s.probeGateTree(job, 1_700_000_000_000)).toEqual({ fingerprint: 'fp', mutatedSince: true });
        expect(s.submitted.find((step) => step.kind === 'probe')).toMatchObject({
            env: { MUTATED_SINCE_MS: '1700000000000' },
        });
    });

    it("gives the sync and the publish step the board's minted tokens, and none reaches a Secret", async () => {
        const api = cluster({ ended: true });
        const s = steps((step) => (step.kind === 'sync' ? ok('{"ok":true,"reason":null}') : ok('{"cloned":false}')));
        const k8s = runner(api.request, s.sink);
        await k8s.syncCheckout(job, undefined, SESSION, 'ghs_sync_minted');
        await k8s.publishGit(job, 'ghs_publish_minted');

        const sync = s.submitted.find((step) => step.kind === 'sync')!;
        expect(sync.env.GITHUB_TOKEN).toBe('ghs_sync_minted');
        // The claim's own value under the reserved name rides nothing.
        expect(JSON.stringify(s.submitted)).not.toContain('ghs_claim');
        expect(JSON.stringify(api.created)).not.toContain('ghs_sync_minted');
        expect(JSON.stringify(api.created)).not.toContain('ghs_publish_minted');
        expect(JSON.stringify(api.created)).not.toContain('ghs_claim');
    });

    it('releases the agent on `run`, waits for the supervisor’s report and leaves the group up for the steps after it', async () => {
        const api = cluster();
        const s = steps((step) => (step.kind === 'sync' ? ok('{"ok":true,"reason":null}') : ok()));
        const k8s = runner(api.request, s.sink);
        await k8s.syncCheckout(job, undefined, SESSION);
        const running = k8s.run(job, SESSION);
        s.report(REPORT);

        const outcome = await running;

        // The close-time turn readout is a `probe` step of the task pod, not a Job of its own.
        expect(kinds(s)).toEqual(['sync', 'go', 'probe']);
        // The supervisor reported and serves on: its channel stays open for the steps after it.
        expect(s.released).toEqual([]);
        expect(outcome).toMatchObject({ exitCode: 0, timedOut: false, started: true });
        // The Job is still the attempt's: nothing deleted it, and nothing else was created.
        expect(api.created.deletedJobs).toEqual([]);
        expect(api.created.jobs.filter((created) => created.name === runnerJobName(job))).toHaveLength(1);
    });

    it('reads the budget’s end from the supervisor’s report as the run’s timeout', async () => {
        const api = cluster({ agentExit: 143 });
        const s = steps((step) => (step.kind === 'sync' ? ok('{"ok":true,"reason":null}') : ok()));
        const k8s = runner(api.request, s.sink);
        await k8s.syncCheckout(job, undefined, SESSION);
        const running = k8s.run(job, SESSION);
        s.report({ ...REPORT, outcome: 'timed_out', cause: 'timeout', agentExit: 143, serving: false });
        expect(await running).toMatchObject({ exitCode: 143, timedOut: true });
    });

    it('takes the group down and hands the checkout back when the sync fails', async () => {
        const api = cluster();
        const s = steps(() => ok('{"ok":false,"reason":"the rebase conflicts"}'));
        const k8s = runner(api.request, s.sink);

        expect(await k8s.syncCheckout(job, undefined, SESSION)).toMatchObject({
            ok: false,
            reason: 'the rebase conflicts',
        });

        expect(api.created.deletedJobs).toEqual([runnerJobName(job)]);
        expect(api.created.deletedSecrets).toContain(secretName(job));
        // The claim is free again: a replacement's sync takes it at once.
        const replacement = runner(api.request, steps(() => ok('{"ok":true,"reason":null}')).sink);
        expect(await replacement.syncCheckout(job, undefined, SESSION)).toMatchObject({ ok: true });
    });

    // Issue #824 D11: typed by the cause the pod's words prove, for the loop's one startup decision.
    it('refuses a group whose image cannot be pulled with the cause it proves, naming the image problem', async () => {
        const api = cluster({ imagePull: 'manifest unknown' });
        const s = steps(() => ok('{"ok":true,"reason":null}'), false);
        const k8s = runner(api.request, s.sink);

        const refused = k8s.syncCheckout(job, undefined, SESSION);

        await expect(refused).rejects.toBeInstanceOf(StartupRefused);
        await expect(refused).rejects.toMatchObject({
            startupCause: 'image',
            role: 'executor',
            message: expect.stringContaining('cannot be pulled'),
        });
        // No step was submitted to a supervisor that never came up, and the group is gone.
        expect(s.submitted).toEqual([]);
        expect(api.created.deletedJobs).toEqual([runnerJobName(job)]);
    });

    // #924: a pod lost before the supervisor's first contact ends the attempt at once, not at the bound.
    describe('a task pod lost before its supervisor made contact', () => {
        const starting = { metadata: { name: 'pod-1' }, status: { phase: 'Pending' } };
        const disrupted = {
            metadata: { name: 'pod-1' },
            status: {
                phase: 'Failed',
                conditions: [{ type: 'DisruptionTarget', status: 'True', reason: 'EvictionByEvictionAPI' }],
            },
        };
        async function lostSync(podItems: (read: number) => unknown[] | number) {
            const api = cluster({ podItems });
            const patched: string[] = [];
            const request: K8sRequest = async (method, path, body) => {
                if (method === 'PATCH' && path.includes('/persistentvolumeclaims/')) patched.push(path);
                return api.request(method, path, body);
            };
            const thrown = await runner(request, steps(() => ok(), false).sink)
                .syncCheckout(job, undefined, SESSION)
                .then(
                    () => null,
                    (e: unknown) => e
                );
            return { thrown, patched, reads: api.podReads() };
        }

        it('is a transient refusal as soon as a pod seen starting is gone, with no volume marked', async () => {
            const { thrown, patched, reads } = await lostSync((read) => (read < 3 ? [starting] : []));

            expect(thrown).toBeInstanceOf(StartupRefused);
            expect(thrown).toMatchObject({ startupCause: 'transient', message: expect.stringContaining('was lost') });
            expect(reads).toBeLessThanOrEqual(4);
            expect(patched).toEqual([]);
        });

        it('is a transient refusal as soon as the pod carries a disruption mark', async () => {
            const { thrown, reads } = await lostSync(() => [disrupted]);

            expect(thrown).toMatchObject({ startupCause: 'transient', message: expect.stringContaining('was lost') });
            expect(reads).toBeLessThanOrEqual(2);
        });

        it('counts no pod that was never seen: an empty list before the first pod waits on', async () => {
            const { thrown, reads } = await lostSync(() => []);

            expect(thrown).toMatchObject({
                startupCause: 'transient',
                message: expect.stringContaining('never came up'),
            });
            expect(reads).toBeGreaterThan(100);
        });

        it('counts no unconfirmed read: a list that did not answer is not a pod gone', async () => {
            const { thrown, reads } = await lostSync((read) => (read < 3 ? [starting] : 500));

            expect(thrown).toBeInstanceOf(Error);
            expect(reads).toBeGreaterThan(100);
        });
    });

    describe('a task pod held Pending by its volume', () => {
        const AFFINITY = '0/3 nodes are available: 3 node(s) had volume node affinity conflict.';
        const pending = (message: string) => ({
            phase: 'Pending',
            conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message }],
        });
        /** The sync of an attempt whose supervisor never answers, with the volume patches the driver sent. */
        async function stuckSync(podStatus: unknown, steal?: { holder: string; fromRead: number }) {
            const api = cluster({ podStatus });
            const patched: { path: string; body: unknown }[] = [];
            let claimReads = 0;
            let readsAtPatch = 0;
            const request: K8sRequest = async (method, path, body) => {
                if (method === 'PATCH' && path.includes('/persistentvolumeclaims/')) {
                    patched.push({ path, body });
                    readsAtPatch = claimReads;
                }
                const answer = await api.request(method, path, body);
                // From the given claim read on, the checkout claim is held by another attempt.
                if (method === 'GET' && path.includes('/configmaps/')) claimReads += 1;
                if (
                    steal &&
                    claimReads >= steal.fromRead &&
                    method === 'GET' &&
                    path.includes('/configmaps/') &&
                    answer.status === 200
                ) {
                    const claim = JSON.parse(answer.body) as { data: object };
                    return {
                        status: 200,
                        body: JSON.stringify({ ...claim, data: { ...claim.data, holder: steal.holder } }),
                    };
                }
                return answer;
            };
            const s = steps(() => ok(), false);
            const thrown = await runner(request, s.sink)
                .syncCheckout(job, undefined, SESSION)
                .then(
                    () => null,
                    (e: unknown) => e
                );
            return { thrown, patched, api, readsAtPatch };
        }

        it('is an infrastructure loss, never a failure: refused as transient, its volume marked unschedulable', async () => {
            const { thrown, patched, api } = await stuckSync(pending(AFFINITY));

            expect(thrown).toBeInstanceOf(StartupRefused);
            expect(thrown).toMatchObject({
                startupCause: 'transient',
                message: expect.stringContaining('volume node affinity'),
            });
            expect(patched).toEqual([
                {
                    path: expect.stringMatching(/\/persistentvolumeclaims\/.+/),
                    body: { metadata: { labels: { [TASK_UNSCHEDULABLE_LABEL]: 'true' } } },
                },
            ]);
            // The group is gone, as for any refused start; the volume is not deleted here.
            expect(api.created.deletedJobs).toEqual([runnerJobName(job)]);
        });

        it.each([
            [
                'a mix of reasons',
                '0/5 nodes are available: 2 Insufficient cpu, 3 node(s) had volume node affinity conflict.',
            ],
            [
                'a taint beside the conflict',
                '0/3 nodes are available: 1 node(s) had untolerated taint, 2 node(s) had volume node affinity conflict.',
            ],
            ['words without a node count', 'pod has unbound volumes: volume node affinity conflict'],
        ])('marks nothing for %s: the volume is not proven the fault', async (_name, message) => {
            const { thrown, patched } = await stuckSync(pending(message));

            expect(thrown).toBeInstanceOf(StartupRefused);
            expect(thrown).toMatchObject({ startupCause: 'transient' });
            expect(patched).toEqual([]);
        });

        it('marks nothing once the claim is no longer ours: a fenced attempt touches no volume', async () => {
            // The claim reads of an undisturbed attempt end with the one before the mark: lose just that one.
            const { readsAtPatch } = await stuckSync(pending(AFFINITY));
            const { thrown, patched } = await stuckSync(pending(AFFINITY), {
                holder: 'another-lease',
                fromRead: readsAtPatch,
            });

            expect(thrown).toBeInstanceOf(StartupRefused);
            expect(patched).toEqual([]);
        });

        it('marks nothing for a pod held Pending for another reason: not a volume fault', async () => {
            const { thrown, patched } = await stuckSync(pending('0/3 nodes are available: 3 Insufficient cpu.'));

            expect(thrown).toBeInstanceOf(StartupRefused);
            expect(patched).toEqual([]);
        });
    });

    it('creates no group for a lease its driver killed, for the sync or any later step', async () => {
        const api = cluster({ ended: true });
        const s = steps();
        const k8s = runner(api.request, s.sink);
        await k8s.kill(job);

        await expect(k8s.syncCheckout(job, undefined, SESSION)).rejects.toThrow(/was killed/);
        await expect(k8s.probeTree(job)).rejects.toThrow(/was killed/);

        expect(api.created.jobs).toEqual([]);
        expect(api.created.secrets).toEqual([]);
        expect(s.submitted).toEqual([]);
    });

    // Issue #773 D10: a sidecar held on its image names its own role and image, never the executor's.
    const heldSidecar = (name: string, image: string, reason: string, message: string) => ({
        initContainerStatuses: [{ name, image, state: { waiting: { reason, message } } }],
        containerStatuses: [
            { name: 'supervisor', state: { waiting: { reason: 'PodInitializing' } } },
            { name: AGENT_CONTAINER, state: { waiting: { reason: 'PodInitializing' } } },
        ],
    });

    it.each([
        { name: 'svc-db', image: 'registry.example/db:17', role: 'service', service: 'db', words: 'service "db"' },
        { name: 'gate', image: 'registry.example/gate:1', role: 'gate', service: undefined, words: 'gate' },
    ])(
        'refuses a group whose $name sidecar image cannot be pulled, naming that sidecar',
        async ({ name, image, role, service, words }) => {
            const api = cluster({ podStatus: heldSidecar(name, image, 'ErrImagePull', 'manifest unknown') });
            const s = steps(() => ok('{"ok":true,"reason":null}'), false);
            const k8s = runner(api.request, s.sink);

            const refused = k8s.syncCheckout(job, undefined, SESSION);

            await expect(refused).rejects.toBeInstanceOf(StartupRefused);
            await expect(refused).rejects.toMatchObject({
                startupCause: 'image',
                role,
                service,
                message: `the ${words} image "${image}" cannot be pulled: ErrImagePull — manifest unknown`,
            });
            expect(s.submitted).toEqual([]);
        }
    );

    it('names a held sidecar’s image from the pod spec when its status names none, never the executor’s', async () => {
        const status = heldSidecar('gate', '', 'ErrImagePull', 'manifest unknown');
        const { image: _none, ...imageless } = status.initContainerStatuses[0]!;
        const api = cluster({
            podStatus: { ...status, initContainerStatuses: [imageless] },
            podSpec: { initContainers: [{ name: 'gate', image: 'registry.example/gate:2' }] },
        });
        const k8s = runner(api.request, steps(() => ok(), false).sink);

        await expect(k8s.syncCheckout(job, undefined, SESSION)).rejects.toMatchObject({
            startupCause: 'image',
            role: 'gate',
            message: 'the gate image "registry.example/gate:2" cannot be pulled: ErrImagePull — manifest unknown',
        });
    });

    it('names the sidecar a back-off of no proven cause held to the bound, never the executor', async () => {
        const api = cluster({
            podStatus: heldSidecar('svc-db', 'registry.example/db:17', 'ImagePullBackOff', 'Back-off pulling image'),
        });
        const k8s = runner(api.request, steps(() => ok(), false).sink);

        const refused = k8s.syncCheckout(job, undefined, SESSION);

        await expect(refused).rejects.not.toBeInstanceOf(StartupRefused);
        await expect(refused).rejects.toThrow(
            'the service "db" image "registry.example/db:17" cannot be pulled: ImagePullBackOff — Back-off pulling image'
        );
    });

    it('refuses a sidecar whose container config the kubelet rejects as that sidecar’s', async () => {
        const api = cluster({
            podStatus: heldSidecar(
                'svc-db',
                'registry.example/db:17',
                'CreateContainerConfigError',
                'secret "x" not found'
            ),
        });
        const k8s = runner(api.request, steps(() => ok(), false).sink);

        await expect(k8s.syncCheckout(job, undefined, SESSION)).rejects.toMatchObject({
            name: 'StartupRefused',
            startupCause: 'config',
            role: 'service',
            service: 'db',
            message: 'the service "db" container cannot start: CreateContainerConfigError — secret "x" not found',
        });
    });

    it('creates a supervisor-only group for an adopted attempt, which has no agent to start', async () => {
        const api = cluster({ ended: true });
        const s = steps(() => ok('{"cloned":false}'));
        const k8s = runner(api.request, s.sink);

        await k8s.publishGit(job);

        expect(api.created.jobs).toEqual([{ name: runnerJobName(job), containers: ['supervisor'] }]);
    });

    /*
     * Issue #823: a group whose supervisor is gone — it ended without a report the driver took, or
     * a kill took it away — leaves nothing to answer a step. Its channel is released, so the probe
     * and `finish` the loop still sends fail at once instead of waiting out each step's timeout and
     * the answer grace, three times over.
     */
    it('fails the probe and `finish` at once once the group ended with no report taken', async () => {
        const api = cluster({ ended: true });
        const broker = createStepBroker();
        broker.open(CONTROL_TOKEN);
        const supervisor = supervisedBy(broker, (step) =>
            step.kind === 'sync' ? ok('{"ok":true,"reason":null}') : ok()
        );
        const k8s = runner(api.request, broker, undefined, TICK);
        try {
            await k8s.syncCheckout(job, undefined, SESSION);
            await k8s.run(job, SESSION);
        } finally {
            await supervisor.stop();
        }
        const asked = Date.now();
        expect(await k8s.probeTree(job)).toBeNull();
        await k8s.finish(job);
        expect(Date.now() - asked).toBeLessThan(5_000);
    });

    it('releases the channel when the run cannot be read to its end: the Job vanished', async () => {
        const api = cluster({ vanished: true });
        const s = steps((step) => (step.kind === 'sync' ? ok('{"ok":true,"reason":null}') : ok()));
        const k8s = runner(api.request, s.sink);
        await k8s.syncCheckout(job, undefined, SESSION);
        // A Job deleted under the run is an infrastructure loss the loop parks, not a rejection.
        expect((await k8s.run(job, SESSION)).infraLoss).toMatch(/deleted before it exited/);
        expect(s.released).toEqual([CONTROL_TOKEN]);
    });

    it('fails a step in flight at once when a kill takes the group away', async () => {
        const api = cluster();
        const broker = createStepBroker();
        broker.open(CONTROL_TOKEN);
        const supervisor = supervisedBy(broker, (step) =>
            step.kind === 'sync' ? ok('{"ok":true,"reason":null}') : null
        );
        const k8s = runner(api.request, broker, undefined, TICK);
        try {
            await k8s.syncCheckout(job, undefined, SESSION);
            const probing = k8s.probeTree(job);
            while (!supervisor.pulled.some((step) => step.kind === 'probe')) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            await k8s.kill(job);
            expect(await probing).toBeNull();
        } finally {
            await supervisor.stop();
        }
    });

    it('does not end a group it never created, and never throws for one', async () => {
        const api = cluster();
        const s = steps();
        await runner(api.request, s.sink).finish(job);
        expect(s.submitted).toEqual([]);
        expect(api.created.deletedJobs).toEqual([]);
    });
});

/** The uid the fake apiserver gave the attempt's group Job when it was created (`uid-<name>`). */
const GROUP_JOB_UID = `uid-${runnerJobName(job)}`;

// Issue #869: the end of a finished run reads its Job before anything is deleted, and a read that
// proves nothing is no word that it ended or that it did not.
describe('the end of a group whose Job cannot be read', () => {
    const TERMINAL = json({ metadata: { uid: GROUP_JOB_UID }, status: { succeeded: 1 } });
    const started = async (groupJob: () => K8sResponse | undefined) => {
        const api = cluster({ groupJob });
        const s = steps((step) => (step.kind === 'sync' ? ok('{"ok":true,"reason":null}') : ok()));
        const k8s = runner(api.request, s.sink);
        await k8s.syncCheckout(job, undefined, SESSION);
        return { api, k8s };
    };

    it('keeps a finished run whose Job first reads as null, and gives the claim back once it reads terminal', async () => {
        let armed = false;
        let reads = 0;
        const { api, k8s } = await started(() => {
            if (!armed) return;
            reads += 1;
            return reads === 1 ? { status: 200, body: 'null' } : TERMINAL;
        });
        armed = true;

        await k8s.finish(job);

        expect(api.created.deletedJobs).toEqual([]);
        expect(api.claims.size).toBe(0);
    });

    it.each([
        ['an empty object', { status: 200, body: '{}' }],
        ['null', { status: 200, body: 'null' }],
        ['a Status body', json({ kind: 'Status', status: 'Failure', message: 'etcd leader changed' })],
        ['a truncated body', { status: 200, body: '{"status":{"succ' }],
        ['a count that is no number', json({ metadata: { uid: GROUP_JOB_UID }, status: { succeeded: 'corrupt' } })],
        ['a negative count', json({ metadata: { uid: GROUP_JOB_UID }, status: { failed: -1 } })],
        ['a 503', { status: 503, body: 'unavailable' }],
    ])('deletes no Job and keeps the claim when every read of it answers %s', async (_name, answer) => {
        let armed = false;
        const { api, k8s } = await started(() => (armed ? answer : undefined));
        armed = true;

        await k8s.finish(job);

        expect(api.created.deletedJobs).toEqual([]);
        expect(api.claims.size).toBe(1);
    });

    it('holds an unread group across finishes, deleting nothing more, and ends it kept once its Job reads terminal', async () => {
        let armed = false;
        let readable = false;
        const { api, k8s } = await started(() => {
            if (!armed) return;
            return readable ? TERMINAL : { status: 200, body: '{}' };
        });
        armed = true;

        await k8s.finish(job);
        const secretsAfterFirst = api.created.deletedSecrets.length;
        await k8s.finish(job);

        // The retry reads the Job first: unreadable, it is left held — no Job and no Secret deleted.
        expect(api.created.deletedJobs).toEqual([]);
        expect(api.created.deletedSecrets).toHaveLength(secretsAfterFirst);
        expect(api.claims.size).toBe(1);

        readable = true;
        await k8s.finish(job);

        // Ended kept: its run is adoptable, so the Job stays, and the checkout goes back.
        expect(api.created.deletedJobs).toEqual([]);
        expect(api.claims.size).toBe(0);
    });

    it('ends a held group destructively when its Job reads as still pending', async () => {
        let armed = false;
        let unreadable = true;
        const { api, k8s } = await started(() => {
            if (!armed) return;
            return unreadable
                ? { status: 503, body: 'unavailable' }
                : json({ metadata: { uid: GROUP_JOB_UID }, status: { active: 1 } });
        });
        armed = true;
        await k8s.finish(job);
        unreadable = false;

        await k8s.finish(job);

        // It did not end the first time: Secrets, then the Job, as before.
        expect(api.created.deletedJobs).toEqual([runnerJobName(job)]);
    });
});

// Issue #869: a listing that is no list of named objects licenses no delete, and no verdict of "none".
describe('the lists that decide a delete', () => {
    const MALFORMED = [
        ['an empty entry', {}],
        ['an entry named by a number', { metadata: { name: 5 } }],
        ['an entry with no uid', { metadata: { name: 'x' } }],
        ['an entry with an empty uid', { metadata: { name: 'x', uid: '' } }],
    ] as const;

    it.each([
        ...MALFORMED,
        ['an entry with no uid', { metadata: { name: 'x', labels: { 'factory.lease': job.leaseToken } } }],
    ] as const)('names no holder groups from a listing that carries %s', async (_name, entry) => {
        const request: K8sRequest = async () => json({ items: [entry] });
        expect(await holderGroupsOf({ config, request, sleep: FAST }, job, job.leaseToken)).toBeNull();
    });

    it.each([
        ['a Status', json({ kind: 'Status', status: 'Failure' })],
        ['null', { status: 200, body: 'null' }],
        ['a 404', { status: 404, body: '{}' }],
    ])('names no holder groups from %s', async (_name, answer) => {
        const request: K8sRequest = async () => answer;
        expect(await holderGroupsOf({ config, request, sleep: FAST }, job, job.leaseToken)).toBeNull();
    });
});

describe('the terminal reclaim of a thread (issue #775)', () => {
    // The thread's tree lives on its own task volume, which only the reaper deletes: the reclaim is an
    // acknowledged no-op, so it creates no group, no Secret and opens no endpoint.
    it('acknowledges without creating a group or a Secret, and without a supervisor endpoint', async () => {
        const api = cluster({ ended: true });
        const s = steps(() => ok('{}'));

        expect(await runner(api.request, s.sink).reclaimWorktree(job)).toEqual({
            ok: true,
            removed: false,
            reason: null,
        });

        expect(api.created.jobs).toEqual([]);
        expect(api.created.secrets).toEqual([]);
        expect(kinds(s)).toEqual([]);
    });
});

/**
 * Issue #967: a gate in flight waits on the supervisor's answer, and the runner Job is the only thing
 * that says the supervisor is gone once the agent has reported. The Job is watched for the group's
 * whole life; a confirmed end releases the steps, an unconfirmed read never does.
 */
describe('a step in flight when the runner Job ends under a reporting group (#967)', () => {
    const WATCH_MS = 10;
    const GATE = { command: 'npm test', cwd: '/work', env: {}, timeoutMs: 600_000 };
    const FAILED = json({
        metadata: { uid: GROUP_JOB_UID },
        status: { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] },
    });
    const FAILURE_TARGET = json({
        metadata: { uid: GROUP_JOB_UID },
        status: { conditions: [{ type: 'FailureTarget', status: 'True', reason: 'PodFailurePolicy' }] },
    });
    const NOT_FOUND: K8sResponse = { status: 404, body: '{}' };
    const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const lostWithin = async (gating: Promise<unknown>, ms = 3_000): Promise<'lost' | 'hung' | 'other'> =>
        Promise.race([
            gating.then(
                () => 'other' as const,
                (e: unknown) => (stepLost(e) ? ('lost' as const) : ('other' as const))
            ),
            settle(ms).then(() => 'hung' as const),
        ]);

    /** The group up, the agent reported and the supervisor serving; a gate pulled and held unanswered. */
    async function gateHeld(script: { answer?: () => K8sResponse | undefined }, agent = true) {
        const api = cluster({ groupJob: () => script.answer?.() });
        const requested = { groupJobGets: 0 };
        const request: K8sRequest = async (method, path, body, options) => {
            if (method === 'GET' && path.endsWith(`/jobs/${runnerJobName(job)}`)) requested.groupJobGets += 1;
            return api.request(method, path, body, options);
        };
        const broker = createStepBroker();
        broker.open(CONTROL_TOKEN);
        const released = vi.spyOn(broker, 'release');
        const supervisor = supervisedBy(broker, (step) =>
            step.kind === 'sync' ? ok('{"ok":true,"reason":null}') : step.kind === 'gate' ? null : ok()
        );
        const k8s = createKubernetesRunner(config, request, TICK, { steps: broker, groupWatchMs: WATCH_MS });
        if (agent) {
            await k8s.syncCheckout(job, undefined, SESSION);
            const running = k8s.run(job, SESSION);
            broker.report(CONTROL_TOKEN, REPORT);
            await running;
        }
        const gating = k8s.runGate(job, GATE);
        gating.catch(() => undefined);
        while (!supervisor.pulled.some((step) => step.kind === 'gate')) await settle(5);
        return {
            k8s,
            gating,
            supervisor,
            requested,
            broker,
            released,
            /** Ends the group this test made, so no watch outlives it. */
            end: async () => {
                await k8s.kill(job).catch(() => undefined);
                await supervisor.stop();
            },
        };
    }

    it.each([
        ['the Job fails', FAILED],
        ['the Job is deleted', NOT_FOUND],
        ['the Job is only marked FailureTarget', FAILURE_TARGET],
    ])('fails a gate in flight at once when %s, after the agent reported', async (_name, ended) => {
        const script: { answer?: () => K8sResponse | undefined } = {};
        const held = await gateHeld(script);
        try {
            script.answer = () => ended;
            expect(await lostWithin(held.gating)).toBe('lost');
        } finally {
            script.answer = () => json({ metadata: { uid: GROUP_JOB_UID }, status: { succeeded: 1 } });
            await held.end();
        }
    });

    it("fails a supervisor-only group's gate at once on the Job's loss", async () => {
        const script: { answer?: () => K8sResponse | undefined } = {};
        const held = await gateHeld(script, false);
        try {
            script.answer = () => NOT_FOUND;
            expect(await lostWithin(held.gating)).toBe('lost');
        } finally {
            script.answer = () => json({ metadata: { uid: GROUP_JOB_UID }, status: { succeeded: 1 } });
            await held.end();
        }
    });

    // Guards: these hold before the fix as well; they pin the confirmed-only rule.
    it.each([
        ['a 500', { status: 500, body: 'boom' }],
        ['a transport throw', 'throw' as const],
        ['null', { status: 200, body: 'null' }],
        ['a malformed status', json({ metadata: { uid: GROUP_JOB_UID }, status: { failed: 'x' } })],
        ['a Job with no condition', json({ metadata: { uid: GROUP_JOB_UID }, status: {} })],
        [
            'a FailureTarget that is not True',
            json({
                metadata: { uid: GROUP_JOB_UID },
                status: { conditions: [{ type: 'FailureTarget', status: 'False' }] },
            }),
        ],
    ])('never fails a waiting gate on an unconfirmed Job read: %s', async (_name, unread) => {
        const script: { answer?: () => K8sResponse | undefined } = {};
        const held = await gateHeld(script);
        try {
            const before = held.requested.groupJobGets;
            script.answer = () => {
                if (unread === 'throw') throw new Error('socket hang up');
                return unread;
            };
            await settle(WATCH_MS * 20);
            expect(held.requested.groupJobGets).toBeGreaterThan(before);
            expect(await lostWithin(held.gating, 50)).toBe('hung');
            script.answer = () => NOT_FOUND;
            expect(await lostWithin(held.gating)).toBe('lost');
        } finally {
            script.answer = () => json({ metadata: { uid: GROUP_JOB_UID }, status: { succeeded: 1 } });
            await held.end();
        }
    });

    it('fails a gate in flight at once when the Job read is another incarnation of the same name', async () => {
        const script: { answer?: () => K8sResponse | undefined } = {};
        const held = await gateHeld(script);
        try {
            script.answer = () => json({ metadata: { uid: 'uid-a-replacement' }, status: { active: 1 } });
            expect(await lostWithin(held.gating)).toBe('lost');
        } finally {
            script.answer = () => json({ metadata: { uid: GROUP_JOB_UID }, status: { succeeded: 1 } });
            await held.end();
        }
    });

    it('never ends a group on a Job read that carries no uid', async () => {
        const script: { answer?: () => K8sResponse | undefined } = {};
        const held = await gateHeld(script);
        try {
            const before = held.requested.groupJobGets;
            script.answer = () => json({ metadata: {}, status: { active: 1 } });
            await settle(WATCH_MS * 20);
            expect(held.requested.groupJobGets).toBeGreaterThan(before);
            expect(await lostWithin(held.gating, 50)).toBe('hung');
        } finally {
            script.answer = () => json({ metadata: { uid: GROUP_JOB_UID }, status: { succeeded: 1 } });
            await held.end();
        }
    });

    /** Reads stop growing and a later confirmed end releases nothing: the group is no longer this watch's. */
    async function stopsWatching(
        held: Awaited<ReturnType<typeof gateHeld>>,
        script: { answer?: () => K8sResponse | undefined }
    ) {
        await settle(WATCH_MS * 3);
        const after = held.requested.groupJobGets;
        const released = held.released.mock.calls.length;
        script.answer = () => NOT_FOUND;
        await settle(WATCH_MS * 20);
        expect(held.requested.groupJobGets).toBe(after);
        expect(held.released.mock.calls.length).toBe(released);
    }

    it('stops watching, and releases nothing, once the group is killed', async () => {
        const script: { answer?: () => K8sResponse | undefined } = {};
        const held = await gateHeld(script);
        try {
            await held.k8s.kill(job);
            await stopsWatching(held, script);
        } finally {
            await held.end();
        }
    });

    it('stops watching, and releases nothing, once the group is finished', async () => {
        const script: { answer?: () => K8sResponse | undefined } = {};
        const held = await gateHeld(script);
        try {
            await held.k8s.finish(job);
            await stopsWatching(held, script);
        } finally {
            await held.end();
        }
    });

    it('stops watching, and releases nothing, once the attempt is abandoned to the next holder', async () => {
        const script: { answer?: () => K8sResponse | undefined } = {};
        const held = await gateHeld(script);
        try {
            held.k8s.abandon(job);
            await stopsWatching(held, script);
            expect(await lostWithin(held.gating, 50)).toBe('hung');
        } finally {
            await held.end();
        }
    });
});
