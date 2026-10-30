import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { SUPERVISOR_CONTAINER, type StepRequest } from '../../src/supervisor-contract.js';
import { StepChannelClosed } from '../../src/step-control.js';
import { lookupHelper } from '../../src/helpers.js';
import { REVIEW_REPLY_PROBE_ID } from '../../src/review/review-helpers.js';
import { receiptedAnswer, receiptOrder } from '../fixtures/helper-receipt-steps.js';
import type { HelperPlan } from '../../src/helpers.js';
import { jobsPath, runnerJobName, type runnerJobSpec } from '../../src/k8s/k8s-podspec.js';
import { TASK_MOUNT } from '../../src/task-volume.js';
import {
    CONTROL_TOKEN,
    job,
    POD_NAMES,
    everyPodSpec,
    namespace,
    fakeRequest,
    stepOk,
    fakeSteps,
    runner,
} from '../fixtures/k8s-suite.js';

describe('the block-helper transport (issue #207)', () => {
    const NOOP_DESCRIPTOR = lookupHelper('noop')!;
    const NOOP_VERDICT = JSON.stringify({ schema: 'helper-noop/v1', version: 1, ok: true, output: { echoed: true } });
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/bellows', env: { GITHUB_TOKEN: 'claim-token' } };
    const WT = `${TASK_MOUNT}/bellows`;
    const plan = (over: Partial<HelperPlan> = {}): HelperPlan => ({
        helperId: 'noop',
        phase: 'pre',
        input: { a: 1 },
        githubWriting: false,
        ...over,
    });
    const secretsPathFor = `/api/v1/namespaces/${namespace}/secrets`;
    const helperStepsOf = (steps: { submitted: StepRequest[] }) =>
        steps.submitted.filter((step) => step.kind === 'helper');
    const answering = () => fakeSteps((step) => (step.kind === 'helper' ? stepOk(NOOP_VERDICT) : stepOk()));

    // Since #771 a helper is a step of the attempt's supervisor: the content-passed script, the
    // literal bounded input and the task worktree are the step's, not a Job spec's.
    it('submits one helper step: content-passed script, literal bounded input, task worktree', async () => {
        const steps = answering();
        await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper(repoJob, plan());
        const [step] = helperStepsOf(steps);
        expect(step).toMatchObject({
            kind: 'helper',
            argv: ['node', '-e', NOOP_DESCRIPTOR.scriptBody],
            cwd: WT,
            env: { HELPER_INPUT: JSON.stringify({ a: 1 }) },
        });
        expect(steps.tokens).toEqual(new Set([CONTROL_TOKEN]));

        // A command-only job (no repo): no working directory, the member root's own mount.
        const bare = answering();
        await runner(fakeRequest().request, {}, undefined, bare.sink).runHelper(job, plan());
        expect(helperStepsOf(bare)[0]!.cwd).toBeUndefined();
    });

    it('gives a read-only helper no claim env, and a github-writing one the fresh token over the claim env', async () => {
        const readOnly = answering();
        await runner(fakeRequest().request, {}, undefined, readOnly.sink).runHelper(repoJob, plan());
        expect(helperStepsOf(readOnly)[0]!.env).toEqual({ HELPER_INPUT: JSON.stringify({ a: 1 }) });

        const writing = answering();
        await runner(fakeRequest().request, {}, undefined, writing.sink).runHelper(
            repoJob,
            plan({ githubWriting: true }),
            { token: 'fresh-install-token' }
        );
        expect(helperStepsOf(writing)[0]!.env).toMatchObject({ GITHUB_TOKEN: 'fresh-install-token' });
        expect(JSON.stringify(helperStepsOf(writing)[0]!.env)).not.toContain('claim-token');
    });

    // Issue #826: a receipted helper given its effect runs bracketed by its receipt on the task
    // volume, and a lost supervisor is the attempt's loss, never a failed helper.
    it('brackets a receipted helper with its receipt in the task worktree, and throws a lost supervisor', async () => {
        const steps = fakeSteps(receiptedAnswer);
        // The receipt's MAC key: a driver without a board token keeps no receipt.
        await runner(fakeRequest().request, { JOB_BOARD_TOKEN: 'board-key' }, undefined, steps.sink).runHelper(
            repoJob,
            plan({ helperId: REVIEW_REPLY_PROBE_ID, githubWriting: true }),
            { token: 'fresh-install-token', effectId: 'effect-1' }
        );
        expect(receiptOrder(steps.submitted)).toEqual(['read', 'started', 'helper', 'done']);
        expect(steps.submitted[0]!.env).toMatchObject({ LEDGER: `${WT}/.factory/helpers.json`, OP: 'effect-1' });

        const lost = fakeSteps(async () => {
            throw new StepChannelClosed('the helper');
        });
        await expect(
            runner(fakeRequest().request, {}, undefined, lost.sink).runHelper(repoJob, plan())
        ).rejects.toBeInstanceOf(StepChannelClosed);
    });

    it('fails an unknown helper id before any step is submitted', async () => {
        const steps = answering();
        const result = await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper(
            job,
            plan({ helperId: 'not-a-real-helper' })
        );
        expect(result).toEqual({
            ok: false,
            reason: 'unknown_helper',
            message: expect.stringContaining('not-a-real-helper'),
        });
        expect(helperStepsOf(steps)).toEqual([]);
    });

    // A group the cluster refuses is a failed helper in the apiserver's own words — never a throw.
    it('fails a helper whose runner Job the cluster refuses, submitting no step', async () => {
        const steps = answering();
        const { request } = fakeRequest({ create: { status: 403, body: 'jobs is forbidden' } });
        const result = await runner(request, {}, undefined, steps.sink).runHelper(repoJob, plan());

        expect(result).toEqual({
            ok: false,
            reason: 'runner_error',
            message: expect.stringContaining('jobs is forbidden'),
        });
        expect(steps.submitted).toEqual([]);
    });

    it('runs the noop helper end to end as a step, creating no Job or Secret of its own', async () => {
        const steps = answering();
        const { request, calls } = fakeRequest();
        const result = await runner(request, {}, undefined, steps.sink).runHelper(job, plan());
        expect(result).toEqual({ ok: true, output: { echoed: true } });
        // The attempt had no group (an adopted run): one supervisor-only group, and nothing per helper.
        const created = calls.filter((c) => c.method === 'POST' && c.path === jobsPath(namespace));
        expect(created.map((c) => (c.body as { metadata: { name: string } }).metadata.name)).toEqual([
            runnerJobName(job),
        ]);
        expect(
            (created[0]!.body as ReturnType<typeof runnerJobSpec>).spec.template.spec.containers.map((c) => c.name)
        ).toEqual([SUPERVISOR_CONTAINER]);
        expect(calls.filter((c) => c.method === 'POST' && c.path === secretsPathFor)).toHaveLength(1);
    });

    it('ends a cancelled helper without submitting it when the stand-down signal is already aborted (issue #488)', async () => {
        const steps = answering();
        const result = await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper(
            repoJob,
            plan({ githubWriting: true }),
            { token: 'fresh-install-token', signal: AbortSignal.abort() }
        );
        expect(result).toEqual({ ok: false, reason: 'runner_error', message: expect.stringContaining('cancelled') });
        expect(helperStepsOf(steps)).toEqual([]);
    });

    it('never puts the fresh token in a Job, a Secret or any request body — only in the step', async () => {
        const steps = answering();
        const { request, calls } = fakeRequest();
        await runner(request, {}, undefined, steps.sink).runHelper(repoJob, plan({ githubWriting: true }), {
            token: 'super-secret-token',
        });
        expect(JSON.stringify(calls.map((c) => c.body))).not.toContain('super-secret-token');
        expect(helperStepsOf(steps)[0]!.env.GITHUB_TOKEN).toBe('super-secret-token');
    });

    it('mints a fresh step identity on every call, even for the identical plan run twice in a row', async () => {
        const steps = answering();
        const r = runner(fakeRequest().request, {}, undefined, steps.sink);
        await r.runHelper(job, plan());
        await r.runHelper(job, plan());
        const ids = helperStepsOf(steps).map((step) => step.id);
        expect(ids).toHaveLength(2);
        expect(ids[0]).not.toBe(ids[1]);
    });

    it('reports a named timeout failure when the supervisor ends the step at its bound', async () => {
        const steps = fakeSteps(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
        const result = await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper(job, plan());
        expect(result).toEqual({ ok: false, reason: 'timeout', message: expect.any(String) });
    });

    it('reports runner_error for an ordinary non-zero exit, distinct from a timeout', async () => {
        const steps = fakeSteps(() => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false }));
        const result = await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper(job, plan());
        expect(result).toEqual({ ok: false, reason: 'runner_error', message: expect.stringContaining('boom') });
    });

    it('reports runner_error for a step channel that fails, never letting it escape as an exception', async () => {
        const steps = fakeSteps(() => {
            throw new Error('the step channel connection reset');
        });
        const result = await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper(job, plan());
        expect(result).toEqual({
            ok: false,
            reason: 'runner_error',
            message: expect.stringContaining('connection reset'),
        });
    });
});

// A private registry is the normal case in a cluster, and every pod this driver specs pulls on its
// own: the runner, each aux Job (sync shown — they all share `auxJobSpec`) and each service pod.
describe('RUNNER_IMAGE_PULL_SECRETS', () => {
    it.each(POD_NAMES)('names every configured secret on %s', (name) => {
        const { pod } = everyPodSpec({ RUNNER_IMAGE_PULL_SECRETS: 'regcred, mirror ,' })[name]();
        expect(pod.imagePullSecrets).toEqual([{ name: 'regcred' }, { name: 'mirror' }]);
    });

    it.each(POD_NAMES)('leaves the field off %s entirely when none are configured', (name) => {
        expect(everyPodSpec()[name]().pod).not.toHaveProperty('imagePullSecrets');
    });
});

// Issue #361: the chart's scheduling knobs reach the chart's own pods only; these are the runner
// group's — the tainted node group agent-written code is meant to land on and nothing else. Every
// pod the driver specs carries them: the runner, each aux Job and each service pod, exactly as
// RUNNER_IMAGE_PULL_SECRETS above does.
describe('RUNNER NODE SELECTOR / TOLERATIONS / AFFINITY', () => {
    const scheduled = {
        RUNNER_NODE_SELECTOR: '{"dedicated":"factory-runners"}',
        RUNNER_TOLERATIONS: '[{"key":"dedicated","operator":"Equal","value":"factory-runners","effect":"NoSchedule"}]',
        RUNNER_AFFINITY:
            '{"podAntiAffinity":{"preferredDuringSchedulingIgnoredDuringExecution":[{"weight":1,"podAffinityTerm":{"topologyKey":"topology.kubernetes.io/zone","labelSelector":{"matchLabels":{"app.kubernetes.io/name":"factory"}}}}]}}',
    };

    it.each(POD_NAMES)('schedules %s onto the configured node group', (name) => {
        const { pod } = everyPodSpec(scheduled)[name]();
        expect(pod.nodeSelector).toEqual({ dedicated: 'factory-runners' });
        expect(pod.tolerations).toEqual([
            { key: 'dedicated', operator: 'Equal', value: 'factory-runners', effect: 'NoSchedule' },
        ]);
        expect(pod.affinity).toMatchObject({ podAntiAffinity: expect.anything() });
    });

    it.each(POD_NAMES)('leaves the fields off %s entirely when none are configured', (name) => {
        const { pod } = everyPodSpec()[name]();
        expect(pod).not.toHaveProperty('nodeSelector');
        expect(pod).not.toHaveProperty('tolerations');
        expect(pod).not.toHaveProperty('affinity');
    });
});

// The chart's runner NetworkPolicy selects by release, so every pod the driver specs must carry
// the release label — not only the runner Job object, which is what bulk cleanup reads.
describe('K8S_RELEASE on pod templates', () => {
    it.each(POD_NAMES)('labels %s with the release', (name) => {
        expect(everyPodSpec({ K8S_RELEASE: 'dev' })[name]().meta.labels).toMatchObject({
            'app.kubernetes.io/instance': 'dev',
        });
    });
});

// Karpenter consolidation or a cluster-autoscaler scale-down voluntarily evicts a running runner
// pod mid-job (issue #362): nothing is corrupted — the lease expires, the board re-offers — but
// the work is redone, silently, visible only as a higher `attempts`. RUNNER_DO_NOT_DISRUPT is the
// opt-out from that voluntary disruption, and both annotation keys travel together: Karpenter
// reads the first, the cluster-autoscaler the second, and they are one switch. It is not a shield
// against everything: a Spot interruption or an external drain (a managed-nodegroup upgrade,
// kubectl drain) reclaims the pod regardless. Every pod the driver specs carries the annotations —
// a declared service's eviction ruins the attempt exactly like the runner's does.
describe('RUNNER_DO_NOT_DISRUPT on pod templates', () => {
    const ANNOTATIONS = {
        'karpenter.sh/do-not-disrupt': 'true',
        'cluster-autoscaler.kubernetes.io/safe-to-evict': 'false',
    };

    // The annotations name the POD: Job specs carry them on the pod template (Karpenter reads
    // pods, not Job objects).
    it.each(POD_NAMES)('annotates %s', (name) => {
        expect(everyPodSpec({ RUNNER_DO_NOT_DISRUPT: '1' })[name]().meta.annotations).toEqual(ANNOTATIONS);
    });

    // Annotating the Job object itself would be cargo cult — Karpenter reads pods. (The runner Job
    // carries its adoption marks, issue #792, and nothing of the disruption opt-out.)
    it.each(POD_NAMES)('leaves the Job object of %s without the disruption annotations', (name) => {
        const { job: jobObject } = everyPodSpec({ RUNNER_DO_NOT_DISRUPT: '1' })[name]();
        const annotations = (jobObject as { metadata: { annotations?: Record<string, string> } }).metadata.annotations;
        for (const key of Object.keys(ANNOTATIONS)) expect(annotations?.[key]).toBeUndefined();
    });

    it.each(POD_NAMES)('leaves the annotations off %s entirely when the switch is unset', (name) => {
        expect(everyPodSpec()[name]().meta).not.toHaveProperty('annotations');
    });
});
