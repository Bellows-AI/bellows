import type { Board, BoardJob } from '../../src/board/board.js';
import { type DriverConfig, loadDriverConfig } from '../../src/config.js';
import {
    AGENT_CONTAINER,
    EXPORTER_CONTAINER,
    SUPERVISOR_CONTAINER,
    type StepRequest,
    type StepResult,
    type SupervisorReport,
} from '../../src/supervisor-contract.js';
import type { StepSink } from '../../src/step-control.js';
import type { K8sRequest, K8sResponse } from '../../src/k8s/k8s-transport.js';
import { runnerJobName, readerJobSpec, runnerJobSpec } from '../../src/k8s/k8s-podspec.js';
import { createKubernetesRunner } from '../../src/k8s/k8s-runner.js';
import { k8sApiserver } from './k8s-apiserver.js';

export const USER = '44444444-4444-4444-8444-444444444444';

/** A fixed, valid Factory execution context — the shape master-prompt.test.ts pins; only its
 *  presence matters to this file's own tests, none of which assert its exact text. */
export const MASTER_PROMPT =
    'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone';

/** The control pair a run with a control endpoint carries for its supervisor, and the exporter's own token. */
export const SUPERVISED: Pick<BoardJob, 'supervisorEnv'> = {
    supervisorEnv: {
        SUPERVISOR_CONTROL_URL: 'http://driver:7000',
        SUPERVISOR_CONTROL_TOKEN: 'tok-supervisor',
        SUPERVISOR_AGENT_TOKEN: 'tok-agent',
        SUPERVISOR_EXPORT_TOKEN: 'tok-export',
    },
};

/** The step channel every attempt here is reached through: the control token the fake sink is keyed by. */
export const CONTROL_TOKEN = SUPERVISED.supervisorEnv!.SUPERVISOR_CONTROL_TOKEN!;

export const job: BoardJob = {
    ...SUPERVISED,
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
    masterPrompt: MASTER_PROMPT,
    resumeSessionId: null,
    followUp: false,
    ownSession: false,
    continuesInterrupted: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
    rootCommand: 'fix the failing build',
};

export const SESSION = '33333333-3333-4333-8333-333333333333';

export const opencodeJob: BoardJob = { ...job, executorType: 'opencode' };

export const spec = (env: NodeJS.ProcessEnv = {}) =>
    runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes', ...env }), job, { id: SESSION, resume: false });

/*
 * Every container the driver specs, by name: the runner's pod and its sidecars. The one other pod is
 * the reader Job of an ended group's close-time readouts (`readerJobSpec`, `k8s-reader.test.ts`); the
 * source-scan test below pins that no other Job spec exists.
 * Each entry is a thunk, built inside the it bodies — the file's `namespace` is declared below, and
 * nothing here may build eagerly. The admission policy is the backstop that refuses any other pod
 * at the apiserver either way.
 */
export const POD_NAMES = [
    'the runner',
    'the gate sidecar',
    'the task supervisor',
    'the transcript exporter',
    'the service sidecar',
    'the reader',
] as const;

export type PodName = (typeof POD_NAMES)[number];

export type JobSpecOf = ReturnType<typeof runnerJobSpec>;

export interface PodView {
    /** The Job object. */
    job: JobSpecOf;
    /** The POD's metadata: the Job's pod template. */
    meta: JobSpecOf['spec']['template']['metadata'];
    /** The pod spec, read only through the fields every pod shares. */
    pod: {
        restartPolicy: string;
        automountServiceAccountToken: boolean;
        securityContext?: { seccompProfile?: { type: string } };
        imagePullSecrets?: { name: string }[];
        nodeSelector?: unknown;
        tolerations?: unknown;
        affinity?: unknown;
        containers: {
            resources?: unknown;
            securityContext?: {
                capabilities?: { drop?: string[] };
                allowPrivilegeEscalation?: boolean;
                readOnlyRootFilesystem?: boolean;
            };
            volumeMounts?: { name: string; subPath?: string }[];
        }[];
    };
}

export const jobView = (spec: JobSpecOf): PodView => ({
    job: spec,
    meta: spec.spec.template.metadata,
    pod: spec.spec.template.spec,
});

/**
 * One container of a claude-code run's pod, seen through the fields every pod shares: the same Job
 * and pod, with only the named container left in `containers` — so each per-container pin below
 * reads `containers[0]` for the supervisor and the exporter as it does for the agent.
 */
export const containerView = (config: DriverConfig, of: BoardJob, name: string): PodView => {
    const spec = runnerJobSpec(
        config,
        { ...of, executorType: 'claude-code', ...SUPERVISED },
        { id: SESSION, resume: false }
    );
    const view = jobView(spec);
    const container = spec.spec.template.spec.containers.find((candidate) => candidate.name === name);
    if (!container) throw new Error(`the run's pod has no ${name} container`);
    return { ...view, pod: { ...view.pod, containers: [container] } };
};

/** The suite's job, with a checkout that declares a gate: its pod holds the gate sidecar (issue #773). */
export const gatedOf = (of: BoardJob): BoardJob => ({
    ...of,
    repo: 'Bellows-AI/factory',
    gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
});

/** The gated run's pod, seen through its gate sidecar alone — as `containerView` sees one main container. */
export const gateView = (config: DriverConfig, of: BoardJob): PodView => {
    const spec = runnerJobSpec(
        config,
        { ...gatedOf(of), executorType: 'claude-code', ...SUPERVISED },
        {
            id: SESSION,
            resume: false,
        }
    );
    const view = jobView(spec);
    const gate = spec.spec.template.spec.initContainers?.find((candidate) => candidate.name === 'gate');
    if (!gate) throw new Error("the gated run's pod has no gate sidecar");
    return { ...view, pod: { ...view.pod, containers: [gate] } };
};

/** A run's pod with one declared service, seen through its sidecar alone (issue #773). */
export const serviceSidecarView = (config: DriverConfig, of: BoardJob): PodView => {
    const spec = runnerJobSpec(
        { ...config, servicesEnabled: true },
        { ...of, ...SUPERVISED, services: [{ name: 'cache', image: 'redis', environment: [] }] },
        { id: SESSION, resume: false }
    );
    const view = jobView(spec);
    const sidecar = spec.spec.template.spec.initContainers?.find((candidate) => candidate.name === 'svc-cache');
    if (!sidecar) throw new Error("the run's pod has no service sidecar");
    return { ...view, pod: { ...view.pod, containers: [sidecar] } };
};

export const everyPodSpec = (env: NodeJS.ProcessEnv = {}, of: BoardJob = job): Record<PodName, () => PodView> => {
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, ...env });
    return {
        'the runner': () => jobView(runnerJobSpec(config, of, { id: SESSION, resume: false })),
        'the gate sidecar': () => gateView(config, of),
        'the task supervisor': () => containerView(config, of, SUPERVISOR_CONTAINER),
        'the transcript exporter': () => containerView(config, of, EXPORTER_CONTAINER),
        'the service sidecar': () => serviceSidecarView(config, of),
        'the reader': () =>
            jobView(
                readerJobSpec(config, of, 'factory-read-0', {
                    argv: ['node'],
                    env: {},
                    timeoutMs: 1_000,
                }) as unknown as JobSpecOf
            ),
    };
};

/*
 * The runner is tested against an injected request function — the same discipline board.test.ts
 * applies to fetch, and the reason this suite spawns nothing and needs no cluster. The fake is a
 * router over (method, path): everything it is not told about throws, so a test that passes is one
 * whose every call was accounted for.
 */
export const namespace = 'factory';

export const podName = `${runnerJobName(job)}-xxxxx`;

export const { FAKE, claimServer, fakeRequest, routed } = k8sApiserver({ namespace, podName });

export const stepOk = (stdout = ''): StepResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

/** What the supervisor answers a step by default: the sync's verdict, otherwise a quiet success. */
export const defaultStepAnswer = (step: StepRequest): StepResult =>
    stepOk(step.kind === 'sync' ? '{"ok":true,"reason":null}\n' : '');

/**
 * The supervised-step channel of an attempt (issue #771): records every step submitted, answers each
 * through `answer`, and reports only when the test says so — so a run's end is the Job's, as it is
 * for any test that scripts the Job status, unless a test calls `report`.
 */
export function fakeSteps(answer: (step: StepRequest) => StepResult | Promise<StepResult> = defaultStepAnswer) {
    const submitted: StepRequest[] = [];
    const tokens = new Set<string>();
    const signals: (AbortSignal | undefined)[] = [];
    let report!: (r: SupervisorReport) => void;
    const reported = new Promise<SupervisorReport>((resolve) => {
        report = resolve;
    });
    const sink: StepSink = {
        submit: async (token, step, signal) => {
            tokens.add(token);
            signals.push(signal);
            if (signal?.aborted) throw new Error('the step was cancelled');
            submitted.push(step);
            return answer(step);
        },
        awaitReport: () => reported,
        agentEnded: () => undefined,
        contacted: () => true,
        release: () => undefined,
        attach: () => undefined,
        cancel: () => undefined,
    };
    return { sink, submitted, tokens, signals, report };
}

/** createKubernetesRunner with a step channel wired in unless the test brings its own: no attempt runs without one. */
export const supervisedRunner = (
    config: DriverConfig,
    request: K8sRequest,
    sleep: (ms: number) => Promise<void> = async () => {},
    wiring: Parameters<typeof createKubernetesRunner>[3] = {}
) => createKubernetesRunner(config, request, sleep, { steps: fakeSteps().sink, ...wiring });

export const runner = (
    request: K8sRequest,
    env: Record<string, string> = {},
    leases?: Board['leases'],
    steps: StepSink = fakeSteps().sink
) =>
    supervisedRunner(
        loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0', ...env }),
        request,
        async () => {},
        { ...(leases ? { leases } : {}), steps }
    );

/** The board's lease lookup, answering that `held` holds the job's live lease. */
export const boardLease =
    (held: BoardJob, leaseToken: string | null = held.leaseToken): Board['leases'] =>
    async (ids) =>
        ids.includes(held.id) ? [{ id: held.id, status: 'running', leaseToken }] : [];

/** A lease token distinct from the fixture job's, for the attempt that reclaimed a job. */
export const NEW_TOKEN = '99999999-9999-4999-8999-999999999999';

/** Another attempt's lease: a claim's holder is always a lease token. */
export const OTHER_HOLDER = '77777777-7777-4777-8777-777777777777';

/** The run start both close-time readouts bound their turn counts to. */
export const START = '2026-08-20T06:00:00.000Z';

export const configmapsPath = `/api/v1/namespaces/${namespace}/configmaps`;

/** The checkout claim's path: one ConfigMap per JOB id, shared by every attempt (issue #32). */
export const claimPathFor = (id: string): string => `${configmapsPath}/factory-job-${id}-claim`;

/** The runner pod's agent log read — the verdict's, and the live tail's. */
export const isAgentLogRead = (path: string): boolean =>
    path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log`) &&
    path.includes(`container=${AGENT_CONTAINER}`);

/** The kubelet's answer to a pod log read: the whole log, or its last `tailLines` lines when asked for. */
export const kubeletLog =
    (log: string) =>
    (path: string): K8sResponse => {
        const tail = new URL(path, 'http://apiserver').searchParams.get('tailLines');
        return {
            status: 200,
            body:
                tail === null
                    ? log
                    : log
                          .split(/(?<=\n)/)
                          .slice(-Number(tail))
                          .join(''),
        };
    };

export const numberedLines = (count: number): string => Array.from({ length: count }, (_, i) => `line ${i}\n`).join('');
