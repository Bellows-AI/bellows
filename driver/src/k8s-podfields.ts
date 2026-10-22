import { AGENT_LAUNCH_CAPS } from './claim.js';
import { cpuQuantityToCores, type DriverConfig, memoryQuantityToBytes } from './config.js';
import type { BoardJob } from './board.js';
import { type Mailbox, mailboxesOf, SUPERVISOR_BINDING } from './supervisor-contract.js';
import { TASK_MOUNT, TASK_VOLUME, taskPodVolume } from './task-volume.js';
import { telemetryConfig, telemetryConfigK8s, type TelemetryConfigVolume } from './telemetry-config.js';

/**
 * The pod-spec field builders the driver renders from its own configuration — the resource
 * requests/limits (issue #360), the runner group's scheduling knobs (issue #361) and the
 * voluntary-disruption opt-out (issue #362). One file because each is "config in, one optional
 * pod-spec field out", every one absent when unconfigured so an untouched cluster sees the spec
 * it always saw, and both spec files (`k8s-podspec.ts`, `k8s-auxspec.ts`) spread them. See
 * docs/kubernetes.md for the module map.
 */

/** One side of the `resources` block: cpu and/or memory, kubernetes quantity strings verbatim. */
export interface ResourceList {
    cpu?: string;
    memory?: string;
}

/** The `resources` block itself: requests and/or limits, each side present only when configured. */
export interface PodResources {
    requests?: ResourceList;
    limits?: ResourceList;
}

/**
 * The configured resource requests and limits (RUNNER_CPU_REQUEST / RUNNER_MEMORY_REQUEST /
 * RUNNER_CPU_LIMIT / RUNNER_MEMORY_LIMIT) on a pod spec. Absent entirely when none are
 * configured, so the BestEffort pod a cluster saw before this existed is unchanged. Requests and
 * limits are independent slots: requests make the pod Burstable and are what Karpenter and the
 * Cluster Autoscaler size for; limits render only when set, because a memory limit on an agent
 * run turns a big build into an OOM kill mid-work — the requests-only posture the dashboard pod
 * keeps deliberately. The values travel verbatim; the config validated their shape at boot.
 * The block is the runner's everywhere but the gate Job, which passes `config.gateResources`.
 */
export function resourcesField(config: DriverConfig, block = config.runnerResources): { resources?: PodResources } {
    const { cpuRequest, cpuLimit, memoryRequest, memoryLimit } = block;
    const requests: ResourceList = {
        ...(cpuRequest ? { cpu: cpuRequest } : {}),
        ...(memoryRequest ? { memory: memoryRequest } : {}),
    };
    const limits: ResourceList = {
        ...(cpuLimit ? { cpu: cpuLimit } : {}),
        ...(memoryLimit ? { memory: memoryLimit } : {}),
    };
    const resources: PodResources = {
        ...(Object.keys(requests).length > 0 ? { requests } : {}),
        ...(Object.keys(limits).length > 0 ? { limits } : {}),
    };
    return Object.keys(resources).length > 0 ? { resources } : {};
}

/** What the gate container asks for while the agent runs (issue #773): the measured idle loop, no more. */
const GATE_IDLE_REQUESTS = { cpu: '100m', memory: '128Mi' } as const;

/** The smaller of two quantities, by the parser `toNumber`; the first when the second is absent. */
const smaller = (a: string, b: string | null, toNumber: (q: string) => string): string =>
    b !== null && Number(toNumber(b)) < Number(toNumber(a)) ? b : a;

/**
 * The gate container's requests at one phase (issue #773): `idle` while the agent runs — the idle
 * loop's figures, never above what the gate is configured to request or limited to — and `verify`,
 * the configured gate requests (GATE_*, over RUNNER_*) for the setup and the gates. A slot with no
 * configured request keeps its idle figure at verify: a resize cannot take a request away.
 */
export function gateRequests(config: DriverConfig, phase: 'idle' | 'verify'): { cpu: string; memory: string } {
    const { cpuRequest, cpuLimit, memoryRequest, memoryLimit } = config.gateResources;
    const idle = {
        cpu: smaller(GATE_IDLE_REQUESTS.cpu, cpuRequest ?? cpuLimit, cpuQuantityToCores),
        memory: smaller(GATE_IDLE_REQUESTS.memory, memoryRequest ?? memoryLimit, memoryQuantityToBytes),
    };
    if (phase === 'idle') return idle;
    return { cpu: cpuRequest ?? idle.cpu, memory: memoryRequest ?? idle.memory };
}

/**
 * The gate container's resources at its creation: the idle requests, and the gate limits from the
 * start — only requests are ever resized, so no memory limit is ever lowered under a running suite.
 */
export function gateResourcesField(config: DriverConfig): { resources: PodResources } {
    const limits = resourcesField(config, config.gateResources).resources?.limits;
    return { resources: { requests: gateRequests(config, 'idle'), ...(limits ? { limits } : {}) } };
}

/** What the reviewer container asks for while no review runs (issue #774): a sleeping loop, no more. */
const REVIEWER_IDLE_REQUESTS = { cpu: '50m', memory: '64Mi' } as const;

/**
 * The reviewer container's requests at one phase (issue #774): `idle` while no review runs, `run`
 * the runner's own requests (RUNNER_*) for the review — a reviewer is an agent. A slot with no
 * configured request keeps its idle figure at run: a resize cannot take a request away.
 */
export function reviewerRequests(config: DriverConfig, phase: 'idle' | 'run'): { cpu: string; memory: string } {
    const { cpuRequest, cpuLimit, memoryRequest, memoryLimit } = config.runnerResources;
    const idle = {
        cpu: smaller(REVIEWER_IDLE_REQUESTS.cpu, cpuRequest ?? cpuLimit, cpuQuantityToCores),
        memory: smaller(REVIEWER_IDLE_REQUESTS.memory, memoryRequest ?? memoryLimit, memoryQuantityToBytes),
    };
    if (phase === 'idle') return idle;
    return { cpu: cpuRequest ?? idle.cpu, memory: memoryRequest ?? idle.memory };
}

/** The reviewer container's resources at its creation: the idle requests, the runner's limits from the start. */
export function reviewerResourcesField(config: DriverConfig): { resources: PodResources } {
    const limits = resourcesField(config).resources?.limits;
    return { resources: { requests: reviewerRequests(config, 'idle'), ...(limits ? { limits } : {}) } };
}

/**
 * The runner group's scheduling knobs (RUNNER_NODE_SELECTOR / RUNNER_TOLERATIONS / RUNNER_AFFINITY,
 * issue #361) on a pod spec: the tainted node group agent-written code lands on and nothing else
 * schedules onto. Absent field by field when unset, so the spec an untainted cluster sees is
 * unchanged. Docker has no twin — the daemon decides placement, there is nothing to forward.
 */
export interface SchedulingField {
    nodeSelector?: Record<string, string>;
    tolerations?: Record<string, unknown>[];
    affinity?: Record<string, unknown>;
}

export function schedulingField(config: DriverConfig): SchedulingField {
    const field: SchedulingField = {};
    if (config.runnerNodeSelector) field.nodeSelector = config.runnerNodeSelector;
    if (config.runnerTolerations) field.tolerations = config.runnerTolerations;
    if (config.runnerAffinity) field.affinity = config.runnerAffinity;
    return field;
}

/**
 * The voluntary-disruption opt-out (issue #362), as pod metadata: both keys, because Karpenter
 * consolidation reads `karpenter.sh/do-not-disrupt` while the cluster-autoscaler's scale-down
 * reads `cluster-autoscaler.kubernetes.io/safe-to-evict`, and to an operator they are one switch,
 * not a vendor choice. Neither survives an explicit `kubectl drain` — a drain evicts through the
 * disruption API, which consults only PodDisruptionBudgets — and this annotation is not offered
 * for the chart's own pods, whose answer is pdb.yaml. Absent entirely when RUNNER_DO_NOT_DISRUPT
 * is off, so the spec an operator who has not opted in sees is unchanged — an undisruptable pod
 * pins its node for as long as the run lasts, which is the operator's decision to make, not the
 * driver's.
 */
export const DO_NOT_DISRUPT_ANNOTATIONS: Record<string, string> = {
    'karpenter.sh/do-not-disrupt': 'true',
    'cluster-autoscaler.kubernetes.io/safe-to-evict': 'false',
};

export function doNotDisruptField(config: DriverConfig): { annotations?: Record<string, string> } {
    return config.runnerDoNotDisrupt ? { annotations: { ...DO_NOT_DISRUPT_ANNOTATIONS } } : {};
}

/**
 * The pod-level half of the executor hardening (issue #382): the runtime's own seccomp profile.
 * Pod level and not container level on purpose — seccomp applies to every container the pod ever
 * grows, so naming it once is what keeps a future sidecar from being born unfiltered.
 * `RuntimeDefault` is the container runtime's profile, which blocks the syscalls a container has
 * no business making (keyctl, the kernel module calls, the older namespace escapes) without the
 * per-image tuning a `Localhost` profile would need from every executor image.
 *
 * Unlike every other builder in this file this one takes no config and is never absent. The pods
 * it lands on run code the driver did not write — the agent's commands, the repository's scripts,
 * a gate, a declared service's image — and a hardening an operator can switch off is a hardening
 * that is off when it matters. Callers SPREAD it into `securityContext`, never assign over one:
 * the gate's `runAsUser`/`runAsGroup` lives in the same field, and an assignment drops whichever
 * of the two was written first.
 */
export interface PodSecurityContext {
    runAsUser?: number;
    runAsGroup?: number;
    /** The group a fresh task volume's root is made writable for (issue #775). */
    fsGroup?: number;
    fsGroupChangePolicy?: 'OnRootMismatch';
    seccompProfile?: { type: 'RuntimeDefault' };
}

export function podHardeningField(): { seccompProfile: { type: 'RuntimeDefault' } } {
    return { seccompProfile: { type: 'RuntimeDefault' } };
}

/**
 * The container-level half (issue #382), and the half with teeth:
 *
 *   - `capabilities.drop: [ALL]` — a capability is a slice of root the kernel hands a process
 *     without asking anyone, and an agent run needs none of them: it reads, writes and compiles
 *     inside its own worktree. Dropping them all is what makes `CAP_NET_RAW` (ARP-spoofing a
 *     neighbour pod, which no NetworkPolicy sees) and `CAP_DAC_OVERRIDE` (reading past the file
 *     modes on the task volume) unavailable rather than merely unused.
 *   - `allowPrivilegeEscalation: false` — without it a setuid binary inside the image re-acquires
 *     what the drop removed, and the drop is decoration. The two are one control.
 *
 * `readOnlyRootFilesystem` is deliberately NOT here. An agent run writes its caches, its HOME and
 * its git worktree; a read-only root fails it on the first `npm install`. The workspace is the
 * writable surface by design — docs/security.md states it as a limit rather than leaving it to be
 * discovered.
 *
 * `drop` is rebuilt per call rather than shared: a single frozen array would be reachable from
 * every spec this process ever builds, and one caller mutating it would disarm all of them.
 */
export interface ContainerSecurityContext {
    allowPrivilegeEscalation: false;
    capabilities: { drop: string[]; add?: string[] };
    runAsNonRoot?: true;
    runAsUser?: number;
    runAsGroup?: number;
}

export function containerHardeningField(): { securityContext: ContainerSecurityContext } {
    return { securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } } };
}

/**
 * The agent container's hardening (issue #814): `containerHardeningField`, started as root with the
 * two capabilities its tool broker keeps to start each command as the tool uid. factory-launch
 * drops both, and root, before the CLI starts; the admission policy allows them on `agent` alone.
 */
export function agentLaunchHardeningField(): { securityContext: ContainerSecurityContext } {
    const { securityContext } = containerHardeningField();
    return {
        securityContext: {
            ...securityContext,
            capabilities: { ...securityContext.capabilities, add: [...AGENT_LAUNCH_CAPS] },
            runAsUser: 0,
            runAsGroup: 0,
        },
    };
}

/** A runner container's volume mount. */
export interface RunnerMount {
    name: string;
    mountPath: string;
    subPath?: string;
    readOnly?: boolean;
}

/**
 * A runner pod's volume: the task volume claim, the attempt Secret its telemetry config rides, or
 * one of the supervisor's mailboxes (an emptyDir — transient control, never finished work).
 */
export type RunnerVolume =
    | { name: string; persistentVolumeClaim: { claimName: string } }
    | { name: string; emptyDir: Record<string, never> | { medium: 'Memory'; sizeLimit: string } }
    | TelemetryConfigVolume
    | BindingVolume;

/** The supervisor's holder binding (#829): one optional item of the attempt Secret, absent until a rebind. */
export interface BindingVolume {
    name: string;
    secret: { secretName: string; items: { key: string; path: string }[]; defaultMode: number; optional: true };
}

const BINDING_MODE = 0o444;

export const bindingVolume = (secretName: string): BindingVolume => ({
    name: SUPERVISOR_BINDING.volume,
    secret: {
        secretName,
        items: [{ key: SUPERVISOR_BINDING.file, path: SUPERVISOR_BINDING.file }],
        defaultMode: BINDING_MODE,
        optional: true,
    },
});

/** The supervisor's read-only mount of it: the directory itself, no subPath, so the kubelet's updates reach it. */
export const bindingMount: RunnerMount = {
    name: SUPERVISOR_BINDING.volume,
    mountPath: SUPERVISOR_BINDING.dir,
    readOnly: true,
};

/**
 * The supervisor's four mailboxes as pod volumes, one emptyDir each (`supervisor-contract.ts`). One
 * volume per mailbox rather than subPaths of one: what a container mounts is then exactly the
 * mailboxes it names, and kubelet-created subPath directories (root-owned) cannot lock a non-root
 * container out of its own.
 */
export const mailboxVolumes = (reviewing: boolean): RunnerVolume[] =>
    mailboxesOf(reviewing).map((box) => ({ name: box.name, emptyDir: {} }));

/** One mailbox as a container mount — read-only where the contract says the container may only read it. */
export const mailboxMount = (box: Mailbox, access: 'ro' | 'rw'): RunnerMount => ({
    name: box.name,
    mountPath: box.path,
    ...(access === 'ro' ? { readOnly: true } : {}),
});

/**
 * The runner's volumes: the thread's task volume at its fixed mount (issue #775), and its telemetry
 * config read-only from the attempt Secret `secretName` (issue #452).
 */
export function runnerVolumesField(
    config: DriverConfig,
    job: BoardJob,
    secretName: string
): { mounts: RunnerMount[]; volumes: RunnerVolume[] } {
    const telemetry = telemetryConfigK8s(telemetryConfig(job.executorType, config.otelEndpoint), secretName);
    return {
        mounts: [{ name: TASK_VOLUME, mountPath: TASK_MOUNT }, telemetry.mount],
        volumes: [taskPodVolume(job), telemetry.volume],
    };
}
