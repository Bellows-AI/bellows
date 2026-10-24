import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { type DriverConfig, loadDriverConfig } from '../../src/config.js';
import {
    EXPORTER_CONTAINER,
    MAILBOXES,
    REVIEWER_CONTAINER,
    SUPERVISOR_CONTAINER,
} from '../../src/supervisor-contract.js';
import { gateLoopArgv, reviewLoopArgv } from '../../src/container-scripts.js';
import { ARTIFACT_LIMIT } from '../../src/runner.js';
import type { K8sRequest, K8sResponse } from '../../src/k8s/k8s-transport.js';
import { LOG_TAIL_LINES } from '../../src/k8s/k8s-transport.js';
import { jobsPath, runnerJobName, runnerJobSpec, secretName } from '../../src/k8s/k8s-podspec.js';
import {
    GATE_GID,
    GATE_UID,
    GITHUB_CACHE_DIR,
    REVIEWER_HOME,
    REVIEWER_TREE_DIR,
    REVIEWER_TREE_PATH,
    REVIEWER_UID,
    TOOL_UID,
} from '../../src/claim.js';
import { reviewerRequests } from '../../src/k8s/k8s-podfields.js';
import { TASK_MOUNT, TASK_VOLUME, taskInitScript } from '../../src/task-volume.js';
import {
    SUPERVISED,
    job,
    SESSION,
    gatedOf,
    namespace,
    podName,
    fakeRequest,
    routed,
    stepOk,
    defaultStepAnswer,
    fakeSteps,
    runner,
    isAgentLogRead,
    kubeletLog,
    numberedLines,
} from '../fixtures/k8s-suite.js';

/** A fake whose agent log reads `answer` gives, everything else as fakeRequest answers it. */
const withAgentLog = (answer: (path: string) => K8sResponse) =>
    routed((method, path) => (method === 'GET' && isAgentLogRead(path) ? answer(path) : undefined));

// ==============================================================================================
// Gates under kubernetes (issue #773): the declared image as a native sidecar of the attempt's
// pod, running the gate loop over the gate mailbox; a gate is a supervised step, never a Job.
// ==============================================================================================

const gatedConfig = loadDriverConfig({
    EXECUTOR: 'kubernetes',
    K8S_NAMESPACE: namespace,
    GATE_TIMEOUT_MS: '30000',
});

describe('the runner verdict log (#825)', () => {
    const run = (request: K8sRequest) => runner(request).run(job, { id: SESSION, resume: false });

    it('uploads a log past the 1,000-line tail whole, and complete', async () => {
        const whole = numberedLines(LOG_TAIL_LINES + 500);
        const { request, calls } = withAgentLog(kubeletLog(whole));

        const outcome = await run(request);

        expect(outcome.fullLog).toBe(whole);
        expect(outcome.logTruncated).toBe(false);
        const reads = calls.filter((call) => isAgentLogRead(call.path));
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every((call) => !call.path.includes('tailLines'))).toBe(true);
    });

    it('reports a log the transport cut as truncated, whatever bytes it kept', async () => {
        const { request } = withAgentLog(() => ({ status: 200, body: 'kept tail\n', truncated: true }));

        const outcome = await run(request);

        expect(outcome).toMatchObject({ fullLog: 'kept tail\n', logTruncated: true });
    });

    it('keeps a multibyte log under the cap byte-true, with no replacement character', async () => {
        const { request } = withAgentLog(() => ({ status: 200, body: '€'.repeat(ARTIFACT_LIMIT / 2) }));

        const outcome = await run(request);

        expect(outcome.logTruncated).toBe(true);
        expect(Buffer.byteLength(outcome.fullLog ?? '')).toBeLessThanOrEqual(ARTIFACT_LIMIT);
        expect(outcome.fullLog).not.toContain('�');
        expect(outcome.output).not.toContain('�');
    });

    it('calls a log of exactly ARTIFACT_LIMIT bytes complete, and one byte more truncated', async () => {
        for (const [size, truncated] of [
            [ARTIFACT_LIMIT, false],
            [ARTIFACT_LIMIT + 1, true],
        ] as const) {
            const { request } = withAgentLog(() => ({ status: 200, body: 'x'.repeat(size) }));

            const outcome = await run(request);

            expect(outcome.logTruncated).toBe(truncated);
            expect(Buffer.byteLength(outcome.fullLog ?? '')).toBe(ARTIFACT_LIMIT);
        }
    });

    it('reads the verdict log of the agent container alone, never the exporter or the supervisor beside it', async () => {
        const { request, calls } = fakeRequest();

        await run(request);

        const logs = calls.filter((call) =>
            call.path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log`)
        );
        expect(logs.some((call) => isAgentLogRead(call.path))).toBe(true);
        for (const other of [EXPORTER_CONTAINER, SUPERVISOR_CONTAINER]) {
            expect(logs.some((call) => call.path.includes(`container=${other}`))).toBe(false);
        }
    });
});

describe('the gate sidecar', () => {
    const podOf = (of: BoardJob, config: DriverConfig = gatedConfig) =>
        runnerJobSpec(config, { ...of, ...SUPERVISED }, { id: SESSION, resume: false }).spec.template.spec;
    const gateOf = (of: BoardJob, config: DriverConfig = gatedConfig) => {
        const gate = podOf(of, config).initContainers?.find((container) => container.name === 'gate');
        if (!gate) throw new Error('no gate sidecar');
        return gate;
    };
    const gated = gatedOf(job);

    it('runs the gate loop in the declared image as a native sidecar, up before the supervisor', () => {
        const gate = gateOf(gated);
        expect(gate.restartPolicy).toBe('Always');
        expect(gate.image).toBe('node:24');
        expect(gate.command).toEqual(gateLoopArgv());
        expect(podOf(gated).initContainers).toHaveLength(1);
    });

    // R2-2: the sync may delete and recreate the worktree, so each request names it; the sidecar
    // itself works in the mailbox.
    it('works in the gate mailbox: each request names its worktree', () => {
        expect(gateOf(gated).workingDir).toBe(MAILBOXES.gate.path);
    });

    it('mounts the task volume and the gate mailbox, and no other mailbox', () => {
        expect(gateOf(gated).volumeMounts).toEqual([
            { name: TASK_VOLUME, mountPath: TASK_MOUNT },
            { name: MAILBOXES.gate.name, mountPath: MAILBOXES.gate.path },
        ]);
        expect(podOf(gated).volumes).toContainEqual({ name: MAILBOXES.gate.name, emptyDir: {} });
    });

    // The claim env and the GitHub token ride each request: anyone who can `get pods` reads this spec.
    it('carries the gate env’s own literals and no Secret reference', () => {
        const gate = gateOf(gated);
        expect(gate.env).toEqual([
            { name: 'HOME', value: '/tmp' },
            { name: 'NPM_CONFIG_UPDATE_NOTIFIER', value: 'false' },
        ]);
        expect(JSON.stringify(gate)).not.toContain('secretKeyRef');
        expect(JSON.stringify(gateOf({ ...gated, env: { NPM_CONFIG_UPDATE_NOTIFIER: 'true' } }).env)).toBe(
            JSON.stringify([{ name: 'HOME', value: '/tmp' }])
        );
    });

    // Issue #734: the gate and the agent name the same cache path, inside the one member mount.
    it('points each declared cache name into the repo cache, the same path the agent gets', () => {
        const cacheJob: BoardJob = {
            ...gated,
            repo: 'acme/widgets',
            gates: { image: 'node:24', cache: ['NPM_CONFIG_CACHE'], gates: [{ name: 't', command: 't' }] },
        };
        const path = `${TASK_MOUNT}/.cache/acme/widgets/NPM_CONFIG_CACHE`;
        expect(gateOf(cacheJob).env).toContainEqual({ name: 'NPM_CONFIG_CACHE', value: path });
        const agent = podOf(cacheJob).containers.find((container) => container.name === 'agent')!;
        expect(agent.env).toContainEqual({ name: 'NPM_CONFIG_CACHE', value: path });
    });

    it('tells the supervisor its gate container is there, and gives the gate mailbox to it alone', () => {
        const pod = podOf(gated);
        const container = (name: string) => pod.containers.find((candidate) => candidate.name === name)!;
        expect(container('supervisor').env).toContainEqual({ name: 'SUPERVISOR_GATE', value: '1' });
        expect(container('supervisor').volumeMounts).toContainEqual({
            name: MAILBOXES.gate.name,
            mountPath: MAILBOXES.gate.path,
        });
        for (const name of ['agent', 'exporter']) {
            expect(JSON.stringify(container(name).volumeMounts), name).not.toContain(MAILBOXES.gate.name);
        }
    });

    it('specs no gate sidecar for a checkout that declares neither gates nor setup, or has no worktree', () => {
        const { repo: _repo, ...repoless } = gated;
        for (const of of [job, repoless, { ...gated, gates: { image: 'node:24', gates: [] } }]) {
            const pod = podOf(of);
            expect(pod.initContainers).toBeUndefined();
            const supervisor = pod.containers.find((candidate) => candidate.name === 'supervisor')!;
            expect(supervisor.env).not.toContainEqual({ name: 'SUPERVISOR_GATE', value: '1' });
        }
        expect(gateOf({ ...gated, gates: { image: 'node:24', setup: 'npm ci', gates: [] } }).name).toBe('gate');
    });

    // D11: the adopted run's group (made on demand, no agent) still runs its gates.
    it('specs the agentless group of an adopted run with the gate', () => {
        expect(gateOf({ ...gated, agent: false }).name).toBe('gate');
    });

    it('refuses a declared image that is not a plain image reference, before the spec exists', () => {
        expect(() => podOf({ ...gated, gates: { ...gated.gates!, image: '-flag-image' } })).toThrow(/image reference/);
    });
});

// ==============================================================================================
// The reviewer sidecar (issue #774): a claim that lists reviewer profiles gets one dormant
// reviewer container in the task pod, beside the supervisor, serving the review mailbox.
// ==============================================================================================

describe('the reviewer sidecar (issue #774)', () => {
    const reviewing: BoardJob = { ...gatedOf(job), ...SUPERVISED, reviewerProfiles: ['security'] };
    const podOf = (of: BoardJob, config: DriverConfig = gatedConfig) =>
        runnerJobSpec(config, of, { id: SESSION, resume: false }).spec.template.spec;
    const reviewerOf = (of: BoardJob = reviewing) => {
        const reviewer = podOf(of).initContainers?.find((container) => container.name === REVIEWER_CONTAINER);
        if (!reviewer) throw new Error('no reviewer sidecar');
        return reviewer;
    };

    it('a claim with reviewer profiles gets one dormant reviewer sidecar; none without', () => {
        const reviewer = reviewerOf();
        expect(reviewer.restartPolicy).toBe('Always');
        expect(reviewer.image).toBe(podOf(reviewing).containers.find((c) => c.name === 'agent')!.image);
        expect(reviewer.command).toEqual(reviewLoopArgv());
        expect(reviewer.workingDir).toBe(MAILBOXES.review.path);
        expect(podOf(reviewing).initContainers?.map((container) => container.name)).toEqual([
            'gate',
            'task-init',
            'reviewer',
        ]);
        const init = podOf(reviewing).initContainers?.find((container) => container.name === 'task-init');
        expect(init?.command).toEqual(['sh', '-c', taskInitScript, 'init', REVIEWER_TREE_PATH]);
        expect(init?.volumeMounts).toEqual([{ name: TASK_VOLUME, mountPath: TASK_MOUNT }]);
        for (const none of [undefined, []]) {
            const { reviewerProfiles: _profiles, ...rest } = reviewing;
            const pod = podOf(none ? { ...rest, reviewerProfiles: none } : rest);
            expect(pod.initContainers?.map((container) => container.name)).toEqual(['gate']);
            expect(JSON.stringify(pod)).not.toContain(MAILBOXES.review.name);
        }
    });

    it('the reviewer runs as REVIEWER_UID ≠ TOOL_UID, mounts only its read-only tree, its mailbox and its home', () => {
        const reviewer = reviewerOf();
        expect(REVIEWER_UID).not.toBe(TOOL_UID);
        expect(REVIEWER_UID).not.toBe(GATE_UID);
        expect(reviewer.securityContext).toMatchObject({ runAsUser: REVIEWER_UID, runAsGroup: GATE_GID });
        expect(reviewer.volumeMounts).toEqual([
            { name: TASK_VOLUME, mountPath: TASK_MOUNT, readOnly: true },
            { name: MAILBOXES.review.name, mountPath: MAILBOXES.review.path },
            { name: TASK_VOLUME, mountPath: REVIEWER_HOME, subPath: REVIEWER_TREE_DIR },
        ]);
        expect(podOf(reviewing).volumes).toContainEqual({ name: MAILBOXES.review.name, emptyDir: {} });
    });

    it('the agent mounts none of the reviewer’s mounts, and the exporter and gate neither', () => {
        const pod = podOf(reviewing);
        for (const name of ['agent', 'exporter']) {
            const mounts = JSON.stringify(pod.containers.find((container) => container.name === name)?.volumeMounts);
            expect(mounts, name).not.toContain(MAILBOXES.review.name);
            expect(mounts, name).not.toContain(REVIEWER_TREE_DIR);
        }
        const gate = pod.initContainers?.find((container) => container.name === 'gate');
        expect(JSON.stringify(gate?.volumeMounts)).not.toContain(MAILBOXES.review.name);
        const supervisor = pod.containers.find((container) => container.name === 'supervisor');
        expect(supervisor?.volumeMounts).toContainEqual({
            name: MAILBOXES.review.name,
            mountPath: MAILBOXES.review.path,
        });
    });

    it('the reviewer’s env and mounts carry no publish token and no credential helper, no attempt-Secret ref', () => {
        const reviewer = reviewerOf({ ...reviewing, env: { SOME_TOKEN: 'claim-secret' } });
        expect(JSON.stringify(reviewer)).not.toContain('secretKeyRef');
        expect(JSON.stringify(reviewer)).not.toContain(secretName(reviewing));
        expect(JSON.stringify(reviewer)).not.toContain('claim-secret');
        // The command is the loop's own text, which names these words in its comments: env and mounts only.
        const text = JSON.stringify({ env: reviewer.env, mounts: reviewer.volumeMounts });
        expect(text).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|PUBLISH|BELLOWS_|credential/i);
        expect(text).not.toContain(GITHUB_CACHE_DIR);
        expect(reviewer.env).toEqual([{ name: 'HOME', value: REVIEWER_HOME }]);
    });

    it('the reviewer reads the same model credentials as the agent from the credentials Secret, and no other Secret', () => {
        const config = loadDriverConfig({
            EXECUTOR: 'kubernetes',
            K8S_NAMESPACE: namespace,
            RUNNER_CREDENTIALS_SECRET: 'model-credentials',
            RUNNER_ENV: 'MODEL_KEY,OTHER_KEY',
        });
        const pod = podOf({ ...reviewing, env: { SOME_TOKEN: 'claim-secret' } }, config);
        const reviewer = pod.initContainers?.find((container) => container.name === REVIEWER_CONTAINER);
        const ref = (name: string) => ({
            name,
            valueFrom: { secretKeyRef: { name: 'model-credentials', key: name, optional: true } },
        });
        expect(reviewer?.env).toEqual([{ name: 'HOME', value: REVIEWER_HOME }, ref('MODEL_KEY'), ref('OTHER_KEY')]);
        const agentEnv = pod.containers.find((container) => container.name === 'agent')?.env ?? [];
        expect(agentEnv).toContainEqual(ref('MODEL_KEY'));
        expect(agentEnv).toContainEqual(ref('OTHER_KEY'));
        expect(JSON.stringify(reviewer)).not.toContain(secretName(reviewing));
        expect(JSON.stringify(reviewer)).not.toContain('envFrom');
    });

    it('sizes the reviewer idle-low at creation, with the runner’s limits', () => {
        const { resources } = reviewerOf();
        expect(resources?.requests).toEqual(reviewerRequests(gatedConfig, 'idle'));
        expect(reviewerRequests(gatedConfig, 'idle')).toEqual({ cpu: '50m', memory: '64Mi' });
    });

    /** fakeRequest, with every pod resize answered 200 and recorded. */
    const resizing = () => {
        const base = fakeRequest();
        const patches: { path: string; body: unknown; contentType: string | undefined }[] = [];
        const request: K8sRequest = (method, path, body, options) => {
            if (method === 'PATCH' && path.endsWith('/resize')) {
                patches.push({ path, body, contentType: options?.contentType });
                return Promise.resolve({ status: 200, body: '{}' });
            }
            return base.request(method, path, body);
        };
        return { request, patches };
    };

    it('resizes the reviewer alone, by a strategic merge patch naming its container', async () => {
        const api = resizing();
        const k8s = runner(api.request, { RUNNER_CPU_REQUEST: '2', RUNNER_MEMORY_REQUEST: '4Gi' });
        expect(await k8s.resizeReviewer(reviewing, 'run')).toBe(true);
        expect(api.patches).toEqual([
            {
                path: `/api/v1/namespaces/${namespace}/pods/${podName}/resize`,
                body: {
                    spec: {
                        initContainers: [{ name: 'reviewer', resources: { requests: { cpu: '2', memory: '4Gi' } } }],
                    },
                },
                contentType: 'application/strategic-merge-patch+json',
            },
        ]);
    });

    it('resizes no pod whose claim lists no reviewer', async () => {
        const api = resizing();
        const { reviewerProfiles: _profiles, ...plain } = reviewing;
        expect(await runner(api.request).resizeReviewer(plain, 'run')).toBe(false);
        expect(api.patches).toEqual([]);
    });
});

describe('the kubernetes runner and the gates', () => {
    const gated = { ...gatedOf(job), ...SUPERVISED };
    const gate = {
        command: 'npm test',
        cwd: `${TASK_MOUNT}/factory`,
        env: {},
        timeoutMs: 1000,
    };

    it('runs a gate as a step of the attempt’s own group, which it makes when none is up, and no Job or Secret of its own', async () => {
        const { request, calls } = fakeRequest();
        const steps = fakeSteps((step) => stepOk(step.kind === 'gate' ? 'passed' : ''));
        const k8s = runner(request, {}, undefined, steps.sink);

        expect(await k8s.runGate(gated, gate)).toEqual(stepOk('passed'));

        expect(steps.submitted.map((step) => step.kind)).toEqual(['gate']);
        expect(steps.submitted[0]).toMatchObject({ argv: ['npm test'], cwd: gate.cwd });
        const posts = calls.filter((call) => call.method === 'POST');
        const jobs = posts.filter((call) => call.path === jobsPath(namespace));
        expect(jobs.map((call) => (call.body as { metadata: { name: string } }).metadata.name)).toEqual([
            runnerJobName(gated),
        ]);
        const pod = (jobs[0]!.body as ReturnType<typeof runnerJobSpec>).spec.template.spec;
        expect(pod.initContainers?.map((container) => container.name)).toEqual(['gate']);
        const secrets = posts.filter((call) => call.path === `/api/v1/namespaces/${namespace}/secrets`);
        expect(secrets.map((call) => (call.body as { metadata: { name: string } }).metadata.name)).toEqual([
            secretName(gated),
        ]);
        expect(JSON.stringify(posts)).not.toContain('factory-gate-');
    });

    /** fakeRequest, with every pod resize answered `resize` and recorded with its patch type. */
    const resizing = (resize: K8sResponse = { status: 200, body: '{}' }) => {
        const base = fakeRequest();
        const patches: { path: string; body: unknown; contentType: string | undefined }[] = [];
        const order: string[] = [];
        const request: K8sRequest = (method, path, body, options) => {
            if (method === 'PATCH' && path.endsWith('/resize')) {
                patches.push({ path, body, contentType: options?.contentType });
                order.push('resize');
                return Promise.resolve(resize);
            }
            return base.request(method, path, body);
        };
        return { request, calls: base.calls, patches, order };
    };

    it('resizes the gate sidecar idle before it releases the agent', async () => {
        const api = resizing();
        const steps = fakeSteps((step) => {
            api.order.push(step.kind);
            return defaultStepAnswer(step);
        });
        await runner(api.request, {}, undefined, steps.sink).run(gated, { id: SESSION, resume: false });
        expect(api.order.slice(0, 2)).toEqual(['resize', 'go']);
        expect(api.patches[0]?.body).toEqual({
            spec: { initContainers: [{ name: 'gate', resources: { requests: { cpu: '100m', memory: '128Mi' } } }] },
        });
    });

    // R1-1: a merge patch would replace the whole init container list; the strategic merge patch
    // merges by container name, so only the gate's requests change.
    it('resizes for verify with a strategic merge patch naming the gate container alone', async () => {
        const api = resizing();
        const k8s = runner(api.request, { GATE_CPU_REQUEST: '2', GATE_MEMORY_REQUEST: '2Gi' });
        expect(await k8s.resizeGate(gated, 'verify')).toBe(true);
        expect(api.patches).toEqual([
            {
                path: `/api/v1/namespaces/${namespace}/pods/${podName}/resize`,
                body: {
                    spec: { initContainers: [{ name: 'gate', resources: { requests: { cpu: '2', memory: '2Gi' } } }] },
                },
                contentType: 'application/strategic-merge-patch+json',
            },
        ]);
    });

    it('answers a refused or impossible resize as not resized, never an error, and resizes no ungated pod', async () => {
        for (const status of [403, 422, 500]) {
            const api = resizing({ status, body: '{}' });
            expect(await runner(api.request).resizeGate(gated, 'verify'), String(status)).toBe(false);
        }
        const unlisted = routed((method, path) =>
            method === 'GET' && path.includes('/pods?') ? { status: 500, body: '' } : undefined
        );
        expect(await runner(unlisted.request).resizeGate(gated, 'verify')).toBe(false);
        expect(unlisted.calls.some((call) => call.method === 'PATCH')).toBe(false);
        const plain = resizing();
        expect(await runner(plain.request).resizeGate({ ...job, ...SUPERVISED }, 'idle')).toBe(false);
        expect(plain.calls).toEqual([]);
    });
});
