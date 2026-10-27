import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import {
    AGENT_CONTAINER,
    EXPORTER_CONTAINER,
    SUPERVISOR_CONTAINER,
    SUPERVISOR_BINDING,
    SUPERVISOR_BINDING_PATH,
    SUPERVISOR_REBIND_GRACE_MS,
    SUPERVISOR_REPORT_MS,
    SUPERVISOR_WINDDOWN_MS,
} from '../../src/supervisor-contract.js';
import { commandMark } from '../../src/runner.js';
import type { K8sMethod, K8sRequest, K8sResponse } from '../../src/k8s/k8s-transport.js';
import { REBIND_DEADLINE_MS } from '../../src/runner.js';
import {
    bindingBody,
    finalizeWaitMs,
    heartbeatPeriodMs,
    orphanBoundMs,
    takeoverBoundMs,
} from '../../src/supervisor-plan.js';
import { jobsPath, runnerJobName, runnerJobSpec, secretName } from '../../src/k8s/k8s-podspec.js';
import { jobPath } from '../../src/k8s/k8s-auxspec.js';
import { createKubernetesRunner } from '../../src/k8s/k8s-runner.js';
import {
    carriedPastLoss,
    decisionOf,
    LOSS_ROWS,
    TERMINATION_ROWS,
    type TerminationRow,
} from '../fixtures/termination-table.js';
import { RETENTION_ROWS } from '../fixtures/retention-table.js';
import { STARTUP_ROWS, type StartupRow, startupDecisionOf } from '../fixtures/startup-table.js';
import { StartupRefused } from '../../src/startup-cause.js';
import type { RunOutcome } from '../../src/runner.js';
import {
    SUPERVISED,
    job,
    SESSION,
    namespace,
    podName,
    FAKE,
    fakeRequest,
    routed,
    fakeSteps,
    runner,
    NEW_TOKEN,
    START,
} from '../fixtures/k8s-suite.js';

const MISMATCH_ROW = 'a run specced for another session than its group' as const;

const SILENT_ROW = 'a supervisor that started and never answered' as const;

const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';

describe('the bound a runner pod outlives a lost driver by', () => {
    it('is a quarter of the lease, clamped to [30 s, 90 s], so the group ends inside the lost driver’s lease', () => {
        expect(orphanBoundMs(loadDriverConfig({ DRIVER_LEASE_SECONDS: '120' }))).toBe(30_000);
        expect(orphanBoundMs(loadDriverConfig({ DRIVER_LEASE_SECONDS: '300' }))).toBe(75_000);
        expect(orphanBoundMs(loadDriverConfig({ DRIVER_LEASE_SECONDS: '3600' }))).toBe(90_000);
    });

    // Issue #824: the adopting claim waits out a finalizing supervisor for its wind-down, longer than
    // the most an orphaned one keeps serving steps — a lost driver's group ends inside that wait.
    it('is shorter than the wind-down an adopting claim waits a finalizing supervisor out for', () => {
        expect(orphanBoundMs(loadDriverConfig({ DRIVER_LEASE_SECONDS: '3600' }))).toBeLessThan(SUPERVISOR_WINDDOWN_MS);
    });

    it('reaches the supervisor as its orphan bound and the exporter as a give-up that outlasts a takeover', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', DRIVER_LEASE_SECONDS: '120' });
        const bound = String(orphanBoundMs(config));
        const takeover = takeoverBoundMs(config);
        const pod = runnerJobSpec(
            config,
            { ...job, executorType: 'claude-code', ...SUPERVISED },
            { id: SESSION, resume: false }
        ).spec.template.spec;
        const envOf = (name: string) => pod.containers.find((container) => container.name === name)?.env;
        expect(envOf(SUPERVISOR_CONTAINER)).toContainEqual({ name: 'SUPERVISOR_ORPHAN_MS', value: bound });
        expect(envOf(EXPORTER_CONTAINER)).toContainEqual({ name: 'EXPORT_DRAIN_GIVEUP_MS', value: String(takeover) });
        expect(envOf(EXPORTER_CONTAINER)).toContainEqual({
            name: 'EXPORT_GIVEUP_MS',
            value: String(Math.max(600_000, takeover)),
        });
    });
});

describe('the holder a supervisor follows, on kubernetes', () => {
    it('reaches the supervisor container alone: its claim and the file a newer holder names itself in', () => {
        const pod = runnerJobSpec(
            loadDriverConfig({ EXECUTOR: 'kubernetes' }),
            { ...job, executorType: 'claude-code', ...SUPERVISED },
            { id: SESSION, resume: false }
        ).spec.template.spec;
        const envOf = (name: string) => pod.containers.find((container) => container.name === name)?.env;
        expect(envOf(SUPERVISOR_CONTAINER)).toContainEqual({
            name: 'SUPERVISOR_CLAIM_SEQ',
            value: String(job.claimSeq),
        });
        expect(envOf(SUPERVISOR_CONTAINER)).toContainEqual({
            name: 'SUPERVISOR_BINDING_FILE',
            value: SUPERVISOR_BINDING_PATH,
        });
        const others = pod.containers.filter((container) => container.name !== SUPERVISOR_CONTAINER);
        expect(JSON.stringify(others)).not.toMatch(/SUPERVISOR_(CLAIM_SEQ|BINDING_FILE|TAKEOVER_MS)/);
    });

    it('waits for a newer holder the lease plus the rebind grace, and the next claim waits a finalizing supervisor out for more than that', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', DRIVER_LEASE_SECONDS: '120' });
        expect(takeoverBoundMs(config)).toBe(120_000 + SUPERVISOR_REBIND_GRACE_MS);
        const pod = runnerJobSpec(
            config,
            { ...job, executorType: 'claude-code', ...SUPERVISED },
            { id: SESSION, resume: false }
        ).spec.template.spec;
        const supervisor = pod.containers.find((container) => container.name === SUPERVISOR_CONTAINER);
        expect(supervisor?.env).toContainEqual({
            name: 'SUPERVISOR_TAKEOVER_MS',
            value: String(takeoverBoundMs(config)),
        });
    });

    // The next claim's wait must outlast a lost-but-alive driver's last contact (its heartbeat learning
    // the lease is gone), the takeover bound counted from it, and the report: at every lease, not one.
    it.each(['60', '120', '3600'])(
        'waits a finalizing supervisor out past the takeover bound at a %s s lease',
        (lease) => {
            const config = loadDriverConfig({ EXECUTOR: 'kubernetes', DRIVER_LEASE_SECONDS: lease });
            expect(finalizeWaitMs(config)).toBeGreaterThanOrEqual(
                heartbeatPeriodMs(config) + takeoverBoundMs(config) + SUPERVISOR_REPORT_MS
            );
            expect(finalizeWaitMs(config)).toBe(
                SUPERVISOR_WINDDOWN_MS + heartbeatPeriodMs(config) + takeoverBoundMs(config)
            );
        }
    );
});

describe('how a started run ends, on kubernetes (the conformance table)', () => {
    const session = { id: SESSION, resume: false };
    const runnerPath = () => jobPath(namespace, runnerJobName(job));
    /** The runner Job answers `answer`; every other Job — the close-time read — ends as the fake's own. */
    const onlyRunner = (answer: K8sResponse) => (_method: K8sMethod, path: string) =>
        path === runnerPath() ? answer : undefined;
    const podWith = (supervisorExit: number) => ({
        status: 200,
        body: JSON.stringify({
            items: [
                {
                    metadata: { name: podName },
                    status: {
                        containerStatuses: [
                            { name: 'agent', state: { terminated: { exitCode: 0 } } },
                            { name: 'supervisor', state: { terminated: { exitCode: supervisorExit } } },
                        ],
                    },
                },
            ],
        }),
    });
    const ACTIVE = { status: 200, body: JSON.stringify({ metadata: { uid: 'job-uid-1' }, status: { active: 1 } }) };
    const GONE = { status: 404, body: '{"kind":"Status"}' };

    /** A Stop that lands while the run polls: the loop's kill deletes the runner Job. */
    const killedMidRun = () => {
        const base = fakeRequest({ job: ACTIVE });
        let deleted = false;
        let r: ReturnType<typeof runner> | null = null;
        const request: K8sRequest = (method, path, body) => {
            if (path.startsWith(runnerPath())) {
                if (method === 'DELETE') {
                    deleted = true;
                    return Promise.resolve({ status: 200, body: '{}' });
                }
                if (method === 'GET' && !deleted) void r?.kill(job);
                if (method === 'GET' && deleted) return Promise.resolve(GONE);
            }
            return base.request(method, path, body);
        };
        r = runner(request);
        return r.run(job, session);
    };

    const reportedThenCrashed = (agentEnd = 'exited') => {
        const steps = fakeSteps();
        steps.report({
            id: 'report-1',
            outcome: null,
            cause: null,
            agentExit: 0,
            agentEnd,
            drained: true,
            serving: true,
        });
        const { request } = routed(onlyRunner(ACTIVE), { pods: podWith(70) });
        return runner(request, {}, undefined, steps.sink).run(job, session);
    };

    /** The supervisor reports the budget ended the agent; the Job then reads 404 under the poll. */
    const vanishedAfterBudget = () => {
        const steps = fakeSteps();
        steps.report({
            id: 'report-1',
            outcome: 'timed_out',
            cause: 'timeout',
            agentExit: 137,
            agentEnd: 'killed',
            drained: true,
            serving: true,
        });
        return runner(fakeRequest({ job: GONE }).request, {}, undefined, steps.sink).run(job, session);
    };

    const vanishedAfterLost = () => {
        const steps = fakeSteps();
        steps.report({
            id: 'report-1',
            outcome: 'lost',
            cause: 'lost',
            agentExit: null,
            agentEnd: 'lost',
            drained: true,
            serving: true,
        });
        return runner(fakeRequest({ job: GONE }).request, {}, undefined, steps.sink).run(job, session);
    };

    const ends: Record<TerminationRow, () => Promise<RunOutcome>> = {
        'an agent that exits 0 under a finalizing supervisor': () => runner(fakeRequest().request).run(job, session),
        'an agent its run budget ended': () =>
            runner(routed(onlyRunner(FAKE.failed as K8sResponse)).request).run(job, session),
        'a group the driver hard-killed mid-run': killedMidRun,
        'a runner the platform took away mid-run': () => runner(fakeRequest({ job: GONE }).request).run(job, session),
        'a runner the platform took away after the budget ended its agent': vanishedAfterBudget,
        'a supervisor that ended without finalizing, nothing initiating it': () =>
            runner(
                routed(
                    onlyRunner({
                        status: 200,
                        body: JSON.stringify({ metadata: { uid: 'job-uid-1' }, status: { failed: 1 } }),
                    }),
                    {
                        pods: podWith(70),
                    }
                ).request
            ).run(job, session),
        'a supervisor that reported, then crashed before the verdict read': () => reportedThenCrashed(),
        // A report that finalized nothing is no finalization (`reportFinalized`), attached or adopted.
        'a supervisor that reported an unlaunched group, then crashed': () => reportedThenCrashed('unlaunched'),
        // A lost agent is no finalized run either, attached or vanished under the poll.
        'a supervisor that reported its agent lost, then crashed': () => reportedThenCrashed('lost'),
        'a runner the platform took away after the supervisor reported its agent lost': () => vanishedAfterLost(),
    };

    it.each(TERMINATION_ROWS)('%s: %s', async (row, expected) => {
        expect(decisionOf(await ends[row]())).toBe(expected);
    });

    it.each(LOSS_ROWS)('%s: carries nothing past the loss', async (row) => {
        const outcome = await ends[row]();
        expect(outcome.infraLoss).toBeDefined();
        expect(carriedPastLoss(outcome)).toEqual([]);
    });
});

describe('what a closed run leaves for the next claim, on kubernetes (the retention conformance table, #828)', () => {
    const adopter: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
    const priorName = runnerJobName(job);
    const prior = {
        metadata: {
            name: priorName,
            uid: `uid-${priorName}`,
            labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken },
            annotations: {
                'factory.claim-seq': '1',
                'factory.session': SESSION,
                'factory.command': commandMark(job.command),
            },
        },
        spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
        status: { startTime: START, succeeded: 1 },
    };

    it.each(RETENTION_ROWS)('%s: %s', async (_row, expected) => {
        // One cluster for both claims: the runner Job is listed once the run closed, until it is deleted.
        let closed = false;
        let deleted = false;
        const { request } = routed((method, path) => {
            // The runner Job is tracked from before the run starts: closing the run must never delete it.
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/${priorName}`)) deleted = true;
            if (closed && method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: deleted ? [] : [prior] }) };
            }
        });

        const first = runner(request);
        await first.run(job, { id: SESSION, resume: false });
        closed = true;
        expect(deleted).toBe(false);

        const adopted = await runner(request).adopt(adopter);
        expect(adopted ? 'adoptable' : 'gone').toBe(expected);
        if (adopted) expect(adopted).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0, started: true } });
    });
});

/*
 * Issue #824 D11, the kubernetes half: the group's pod tells why it cannot start through its
 * containers' waiting reasons and messages, and the wait for its supervisor answers the proven
 * cause — read the same way docker reads its daemon's words.
 */
describe('how a refused group start ends, on kubernetes (the startup conformance table, #824 D11)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
    const SESSION_OF = { id: SESSION, resume: false };
    const pulled = (detail: string) =>
        `rpc error: code = Unknown desc = failed to pull and unpack image "registry.example/claude-executor:latest": ${detail}`;
    const waitingPod = (reason: string, message?: string) => ({
        metadata: { name: podName },
        status: {
            phase: 'Pending',
            containerStatuses: [{ name: 'supervisor', state: { waiting: message ? { reason, message } : { reason } } }],
        },
    });
    /** The kubelet's own reason and words for each refusal, on the group pod's supervisor container. */
    const refusals: Record<
        Exclude<StartupRow, typeof MISMATCH_ROW | typeof SILENT_ROW>,
        ReturnType<typeof waitingPod>
    > = {
        'the platform never brought the group up': waitingPod('ContainerCreating'),
        'a registry that timed out': waitingPod(
            'ErrImagePull',
            pulled(
                'failed to do request: Head "https://registry.example/v2/claude-executor/manifests/latest": dial tcp 10.0.0.1:443: i/o timeout'
            )
        ),
        'a registry rate limit': waitingPod(
            'ErrImagePull',
            pulled('unexpected status code: 429 Too Many Requests - Server message: toomanyrequests: rate limit')
        ),
        'a TLS handshake that timed out': waitingPod(
            'ErrImagePull',
            pulled('failed to do request: Head "https://registry.example/v2/": net/http: TLS handshake timeout')
        ),
        'a missing image': waitingPod(
            'ErrImagePull',
            'rpc error: code = NotFound desc = failed to pull and unpack image "registry.example/claude-executor:latest": failed to resolve reference "registry.example/claude-executor:latest": registry.example/claude-executor:latest: not found'
        ),
        'an invalid image reference': waitingPod(
            'InvalidImageName',
            'Failed to apply default image tag "Registry.Example//claude": couldn\'t parse image reference'
        ),
        'an unauthorized pull': waitingPod(
            'ErrImagePull',
            pulled('failed to authorize: failed to fetch anonymous token: unexpected status: 401 Unauthorized')
        ),
        'an untrusted registry certificate': waitingPod(
            'ErrImagePull',
            pulled('tls: failed to verify certificate: x509: certificate signed by unknown authority')
        ),
        'a container configuration the platform refuses': waitingPod(
            'CreateContainerConfigError',
            'secret "factory-env-x" not found'
        ),
        'a refusal whose words prove no cause': waitingPod(
            'ErrImagePull',
            'rpc error: code = Unknown desc = something the kubelet has never said before'
        ),
    };
    /** The group pod's lists answer `pods` in turn (the last one repeats); every other call as the fake does. */
    const podsInTurn = (pods: unknown[]) => {
        const base = fakeRequest();
        let reads = 0;
        const request: K8sRequest = async (method, path, body) => {
            if (
                method === 'GET' &&
                path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
                decodeURIComponent(path).includes('job-name=')
            ) {
                const pod = pods[Math.min(reads, pods.length - 1)];
                reads += 1;
                return { status: 200, body: JSON.stringify({ items: pod === undefined ? [] : [pod] }) };
            }
            return base.request(method, path, body);
        };
        return { request, reads: () => reads };
    };
    const runningPod = {
        metadata: { name: podName },
        status: { phase: 'Running', containerStatuses: [{ name: 'supervisor', state: { running: {} } }] },
    };
    /** The sync of a group whose supervisor never answers: what it threw, or null. */
    const refusedSync = (request: K8sRequest): Promise<unknown> => {
        const steps = fakeSteps();
        steps.sink.contacted = () => false;
        return runner(request, {}, undefined, steps.sink)
            .syncCheckout(repoJob, undefined, SESSION_OF)
            .then(
                () => null,
                (e: unknown) => e
            );
    };

    const startups: Record<StartupRow, () => Promise<unknown>> = {
        ...(Object.fromEntries(
            Object.entries(refusals).map(([row, pod]) => [row, () => refusedSync(podsInTurn([pod]).request)])
        ) as Record<Exclude<StartupRow, typeof MISMATCH_ROW | typeof SILENT_ROW>, () => Promise<unknown>>),
        [SILENT_ROW]: () => refusedSync(podsInTurn([runningPod]).request),
        [MISMATCH_ROW]: async () => {
            const r = runner(fakeRequest().request, {}, undefined, fakeSteps().sink);
            await r.syncCheckout(repoJob, undefined, SESSION_OF);
            return r.run(repoJob, { id: OTHER_SESSION, resume: false }).then(
                () => null,
                (e: unknown) => e
            );
        },
    };

    it.each(STARTUP_ROWS)('%s: %s', async (row, expected) => {
        const thrown = await startups[row]();
        expect(thrown).not.toBeNull();
        expect(startupDecisionOf(thrown)).toBe(expected);
    });

    // A back-off names no cause of its own: the wait reads on until the pull's own failure says one.
    it('reads past a back-off that names no cause, to the pull failure that does', async () => {
        const backOff = waitingPod(
            'ImagePullBackOff',
            'Back-off pulling image "registry.example/claude-executor:latest"'
        );
        const pods = podsInTurn([backOff, backOff, refusals['a missing image']]);
        const thrown = await refusedSync(pods.request);
        expect(thrown).toBeInstanceOf(StartupRefused);
        expect(thrown).toMatchObject({ startupCause: 'image' });
        expect(pods.reads()).toBe(3);
    });

    // A supervisor that runs and never answers is no evidence the platform is still bringing the
    // group up: it is no transient refusal, and the sync is left to the lease as before.
    it('reads no transient cause from a supervisor that runs and never answers', async () => {
        const thrown = await refusedSync(podsInTurn([runningPod]).request);
        expect(thrown).toBeInstanceOf(Error);
        expect(startupDecisionOf(thrown)).toBe('unclassified');
        expect((thrown as Error).message).toMatch(/never came up/);
    });

    // A driver kill ends the wait at once (#828 D4): a killed attempt's group is no longer worth waiting for.
    it('stops waiting for a supervisor once the job was killed during the first pod read', async () => {
        const pods = podsInTurn([waitingPod('ContainerCreating')]);
        const steps = fakeSteps();
        steps.sink.contacted = () => false;
        let killed = false;
        let r: ReturnType<typeof runner> | undefined;
        const request: K8sRequest = async (method, path, body) => {
            const answer = await pods.request(method, path, body);
            if (!killed && method === 'GET' && decodeURIComponent(path).includes('job-name=')) {
                killed = true;
                await r!.kill(repoJob);
            }
            return answer;
        };
        r = runner(request, {}, undefined, steps.sink);
        const thrown = await r.syncCheckout(repoJob, undefined, SESSION_OF).then(
            () => null,
            (e: unknown) => e
        );
        expect((thrown as Error).message).toMatch(/killed while its task group came up/);
        expect(pods.reads()).toBeLessThan(5);
    });

    it('reports the kill, not the refusal, when the kill lands while the pod read is pending', async () => {
        const pods = podsInTurn([refusals['a container configuration the platform refuses']]);
        const steps = fakeSteps();
        steps.sink.contacted = () => false;
        let r: ReturnType<typeof runner> | undefined;
        const request: K8sRequest = async (method, path, body) => {
            if (method === 'GET' && decodeURIComponent(path).includes('job-name=')) await r!.kill(repoJob);
            return pods.request(method, path, body);
        };
        r = runner(request, {}, undefined, steps.sink);
        const thrown = await r.syncCheckout(repoJob, undefined, SESSION_OF).then(
            () => null,
            (e: unknown) => e
        );
        expect(thrown).not.toBeInstanceOf(StartupRefused);
        expect((thrown as Error).message).toMatch(/killed while its task group came up/);
    });

    // A pod list that cannot be read proves nothing either way: no transient cause from silence.
    it('reads no transient cause from pod lists that never answered', async () => {
        const base = fakeRequest();
        const request: K8sRequest = async (method, path, body) =>
            method === 'GET' &&
            path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
            decodeURIComponent(path).includes('job-name=')
                ? { status: 503, body: 'unavailable' }
                : base.request(method, path, body);
        expect(startupDecisionOf(await refusedSync(request))).toBe('unclassified');
    });

    // The bound is elapsed time, not a count of polls: slow reads end the wait as surely as quick ones.
    it('ends the wait for the supervisor on elapsed time', async () => {
        const pods = podsInTurn([refusals['the platform never brought the group up']]);
        let now = 1_000_000;
        // The clock runs once the supervisor wait begins: the fence before it has its own bound.
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
            if (pods.reads() > 0) now += 120_000;
            return now;
        });
        try {
            expect(startupDecisionOf(await refusedSync(pods.request))).toBe('interruption');
        } finally {
            clock.mockRestore();
        }
        expect(pods.reads()).toBeLessThan(20);
    });
});

describe('the holder binding a supervisor reads, on kubernetes (#829)', () => {
    const BINDING = {
        claimSeq: 4,
        url: 'http://driver.example:8080',
        token: 'tok-new-holder',
        agentToken: 'tok-new-agent',
        exportToken: 'tok-new-export',
        leaseToken: 'lease-new',
    };
    const SENTINEL = 'sentinel-body-text';
    const SECRETS = ['tok-new-holder', 'tok-new-agent', 'tok-new-export', 'lease-new', 'driver.example', SENTINEL];
    const podOf = (group: BoardJob) =>
        runnerJobSpec(
            loadDriverConfig({ EXECUTOR: 'kubernetes' }),
            { ...group, executorType: 'claude-code' },
            { id: SESSION, resume: false }
        ).spec.template.spec;
    const mountsOf = (pod: ReturnType<typeof podOf>, name: string) =>
        pod.containers.find((container) => container.name === name)?.volumeMounts ?? [];
    const patchPath = `/api/v1/namespaces/${namespace}/secrets/${secretName(job)}`;
    const rebinder = (request: K8sRequest) =>
        createKubernetesRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
            request,
            async () => {}
        );
    const ok = (body = ''): Promise<K8sResponse> => Promise.resolve({ status: 200, body });

    it('mounts an optional read-only Secret item in the supervisor alone, without a subPath', () => {
        const pod = podOf({ ...job, ...SUPERVISED });
        expect(pod.volumes).toContainEqual({
            name: SUPERVISOR_BINDING.volume,
            secret: {
                secretName: secretName(job),
                items: [{ key: SUPERVISOR_BINDING.file, path: SUPERVISOR_BINDING.file }],
                defaultMode: 0o444,
                optional: true,
            },
        });
        for (const container of pod.containers) {
            const bound = mountsOf(pod, container.name).filter((mount) => mount.name === SUPERVISOR_BINDING.volume);
            if (container.name === SUPERVISOR_CONTAINER) {
                expect(bound).toEqual([
                    { name: SUPERVISOR_BINDING.volume, mountPath: SUPERVISOR_BINDING.dir, readOnly: true },
                ]);
            } else {
                expect(bound, container.name).toEqual([]);
            }
        }
    });

    it('merge-patches only the binding key with data, bounded and with the signal', async () => {
        const seen: { method: string; path: string; body: unknown; options: unknown }[] = [];
        const signal = new AbortController().signal;
        await rebinder((method, path, body, options) => {
            seen.push({ method, path, body, options });
            return ok();
        }).rebind(job, BINDING, signal);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ method: 'PATCH', path: patchPath });
        expect(seen[0]!.body).toEqual({
            data: { [SUPERVISOR_BINDING.file]: Buffer.from(bindingBody(BINDING)).toString('base64') },
        });
        expect(JSON.parse(bindingBody(BINDING))).toEqual(BINDING);
        const options = seen[0]!.options as { timeoutMs: number; signal: AbortSignal; contentType?: string };
        expect(options.timeoutMs).toBeLessThanOrEqual(REBIND_DEADLINE_MS);
        expect(options.signal.aborted).toBe(false);
        expect(options.contentType).toBeUndefined();
    });

    it('sends no request for an aborted signal', async () => {
        const request = vi.fn(() => ok());
        const controller = new AbortController();
        controller.abort();
        await expect(rebinder(request).rebind(job, BINDING, controller.signal)).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
    });

    it('rejects on 403, 404, 409, 500, a throw and a timeout, never naming the token or the answer', async () => {
        const answers: (() => Promise<K8sResponse>)[] = [
            ...[403, 404, 409, 500].map(
                (status) => () => Promise.resolve({ status, body: `${SENTINEL} tok-new-holder driver.example` })
            ),
            () => Promise.reject(new Error('connect ECONNREFUSED tok-new-holder driver.example')),
            () => Promise.reject(new Error('the call timed out sentinel-body-text')),
        ];
        for (const answer of answers) {
            const error = await rebinder(() => answer())
                .rebind(job, BINDING, new AbortController().signal)
                .catch((caught: Error) => caught);
            expect(error).toBeInstanceOf(Error);
            for (const secret of SECRETS) expect(String((error as Error).message)).not.toContain(secret);
        }
    });

    it('discards a 2xx answer unread and resolves only after the patch answered', async () => {
        let answer!: (res: K8sResponse) => void;
        let done = false;
        const pending = rebinder(() => new Promise<K8sResponse>((resolve) => (answer = resolve)))
            .rebind(job, BINDING, new AbortController().signal)
            .then((value) => {
                done = true;
                return value;
            });
        await new Promise((resolve) => setImmediate(resolve));
        expect(done).toBe(false);
        answer({ status: 200, body: '{not json tok-new-holder' });
        expect(await pending).toBeUndefined();
    });

    it.each([
        ['a negative claim sequence', { ...BINDING, claimSeq: -1 }],
        ['no agent token', { ...BINDING, agentToken: '' }],
        ['an agent token with whitespace', { ...BINDING, agentToken: 'has space' }],
        ['no export token', { ...BINDING, exportToken: '' }],
        ['an export token with whitespace', { ...BINDING, exportToken: 'has space' }],
        ['no lease token', { ...BINDING, leaseToken: '' }],
        ['a lease token with whitespace', { ...BINDING, leaseToken: 'has space' }],
    ])('refuses an invalid binding (%s) before any request, naming no token', async (_what, binding) => {
        const request = vi.fn(() => ok());
        const error = await rebinder(request)
            .rebind(job, binding, new AbortController().signal)
            .catch((caught: Error) => caught);
        expect(error).toBeInstanceOf(Error);
        for (const secret of SECRETS) expect(String((error as Error).message)).not.toContain(secret);
        expect(request).not.toHaveBeenCalled();
    });
});
