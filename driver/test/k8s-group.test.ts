import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { jobsPath, runnerJobName, secretName } from '../src/k8s-podspec.js';
import { holderGroupsOf } from '../src/k8s-group.js';
import { createKubernetesRunner } from '../src/k8s-runner.js';
import type { K8sMethod, K8sRequest, K8sResponse } from '../src/k8s-transport.js';
import { StartupRefused } from '../src/startup-cause.js';
import { taskVolumeServer } from './fixtures/k8s-apiserver.js';
import { createStepBroker, type StepBroker, type StepSink, type SupervisorEndpoint } from '../src/step-control.js';
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
    } = {}
) {
    const created: Created = { jobs: [], secrets: [], deletedJobs: [], deletedSecrets: [] };
    const claims = new Map<string, { uid: string; holder: string; claimSeq: string }>();
    const gone = new Set<string>();
    const configmaps = `/api/v1/namespaces/${NAMESPACE}/configmaps`;
    const secrets = `/api/v1/namespaces/${NAMESPACE}/secrets`;
    const serveVolumes = taskVolumeServer(NAMESPACE);
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
    return { request, created, claims };
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
