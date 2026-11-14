import type { BoardJob } from './board/board.js';
import { cpuQuantityToCores, memoryQuantityToBytes } from './quantities.js';

/**
 * Runner classes: where agent code lands and what it is sized at, one named set per class
 * (RUNNER_CLASSES), so two node pools or RuntimeClasses coexist on one driver. A claim names its
 * class (`runnerClass`), or none for the driver's default (RUNNER_DEFAULT_CLASS). Neutral: both
 * executors read it, kubernetes for every field, docker for the resources alone (`loadRunnerClasses`
 * refuses the rest at boot there). See docs/kubernetes.md.
 */

/** The four resource slots, each null when unset. */
export interface RunnerResources {
    cpuRequest: string | null;
    cpuLimit: string | null;
    memoryRequest: string | null;
    memoryLimit: string | null;
}

/** One declared class, validated at boot; every scheduling field is null when the class sets none. */
export interface RunnerClass {
    name: string;
    /** The RuntimeClass its pods run under (`gvisor` on GKE Sandbox); null runs the node's default. */
    runtimeClassName: string | null;
    nodeSelector: Record<string, string> | null;
    tolerations: Record<string, unknown>[] | null;
    affinity: Record<string, unknown> | null;
    /** Every pod but the gate: the runner, its services and every aux Job. */
    runnerResources: RunnerResources;
    /** The gate's; each unset slot is the class's runner slot. */
    gateResources: RunnerResources;
    /** Whether the class's groups get a docker daemon. */
    docker: boolean;
}

/** The configured classes and the one a claim naming none runs in. */
export interface RunnerClasses {
    runnerClasses: Readonly<Record<string, RunnerClass>>;
    defaultRunnerClass: string;
}

/** The name of the class a driver with no RUNNER_CLASSES runs every claim in: no fields at all. */
export const IMPLICIT_RUNNER_CLASS = 'default';

/**
 * The class a claim runs in: the one it names, or the default when it names none. Null for a name
 * this driver does not declare — never the default in its place, so a claim meant for an isolated
 * class is never run outside it.
 */
export function classOf(config: RunnerClasses, job: Pick<BoardJob, 'runnerClass'>): RunnerClass | null {
    const name = job.runnerClass ?? config.defaultRunnerClass;
    return Object.hasOwn(config.runnerClasses, name) ? (config.runnerClasses[name] ?? null) : null;
}

/** The default class: what a pod outside any claim's class (the volume export Job) runs in. */
export function defaultClassOf(config: RunnerClasses): RunnerClass {
    const declared = config.runnerClasses[config.defaultRunnerClass];
    if (!declared) throw new Error(`the default runner class "${config.defaultRunnerClass}" is not declared`);
    return declared;
}

/** Why a claim cannot launch on this driver for its class, or null when its class is declared. */
export function runnerClassRefusal(config: RunnerClasses, job: Pick<BoardJob, 'runnerClass'>): string | null {
    return classOf(config, job) ? null : `the runner class "${job.runnerClass}" is not declared on this driver`;
}

/** The claim's class, for a spec about to be built: an undeclared one is refused, never defaulted. */
export function jobClassOf(config: RunnerClasses, job: Pick<BoardJob, 'runnerClass'>): RunnerClass {
    const declared = classOf(config, job);
    if (!declared) throw new Error(runnerClassRefusal(config, job) ?? 'no runner class');
    return declared;
}

/** A trimmed value, or null when unset or blank. */
const optionalText = (raw: string | undefined): string | null => (raw ?? '').trim() || null;

/** How much of a rejected value rides the refusal message — a preview, not the whole value. */
const ERROR_PREVIEW_CHARS = 64;

const preview = (value: unknown): string => (JSON.stringify(value) ?? String(value)).slice(0, ERROR_PREVIEW_CHARS);

/**
 * One resource slot: validated at boot, stored verbatim — the apiserver owns the semantics. A YAML
 * number (`cpu: 2`) is a quantity too; any other kind is a refusal.
 */
function runnerResource(raw: unknown, label: string, kind: 'cpu' | 'memory'): string | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string' && !(typeof raw === 'number' && Number.isFinite(raw))) {
        throw new Error(`${label} must be a kubernetes ${kind} quantity, got ${preview(raw)}`);
    }
    const value = optionalText(String(raw));
    if (value === null) return null;
    try {
        if (kind === 'cpu') cpuQuantityToCores(value);
        else memoryQuantityToBytes(value);
    } catch {
        throw new Error(
            `${label} must be a kubernetes ${kind} quantity (e.g. ${kind === 'cpu' ? '"500m"' : '"1Gi"'}), got "${value}"`
        );
    }
    return value;
}

/**
 * Kubernetes refuses a pod whose request exceeds its limit — at job-create, attempt-burning — and
 * docker refuses `--memory-reservation` above `--memory` at run time. One class's resources feed
 * the runner, auxiliary and service specs on both executors, so the pair is refused here, at
 * startup, naming both values. Equal values are valid (a Guaranteed-shaped pod, on kubernetes).
 */
function assertRequestWithinLimit(
    request: string | null,
    limit: string | null,
    labels: [string, string],
    convert: (quantity: string) => string
): void {
    if (request === null || limit === null) return;
    if (Number(convert(request)) > Number(convert(limit))) {
        throw new Error(`${labels[0]} (${request}) exceeds ${labels[1]} (${limit})`);
    }
}

/**
 * A JSON-encoded value (the chart forwards RUNNER_CLASSES with `toJson`), or null when unset.
 * Malformed JSON or the wrong kind is fatal here, never at job-create: the API server would refuse
 * a bad pod spec per attempt, and this loader exists to move failures to startup — the same posture
 * as the EXECUTOR and pull-policy enums. Below the shapes checked here stays the API server's job:
 * no speculative validation of a shape kubernetes owns.
 */
function parsedJsonValue(raw: string | undefined, label: string): unknown {
    const value = (raw ?? '').trim();
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        throw new Error(`${label} must be JSON, got "${value.slice(0, ERROR_PREVIEW_CHARS)}"`);
    }
}

/** An object field, or null when absent or empty: an empty one renders nothing, as an unset one does. */
function jsonObject(value: unknown, label: string): Record<string, unknown> | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be a JSON object, got ${preview(value)}`);
    }
    return Object.keys(value).length > 0 ? (value as Record<string, unknown>) : null;
}

function jsonArray(value: unknown, label: string): Record<string, unknown>[] | null {
    if (value === undefined || value === null) return null;
    // A list of OBJECTS (tolerations) — an array of scalars renders a pod spec the API server can
    // only refuse per attempt, so the element kind is checked too. Deeper than that stays
    // kubernetes's job.
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'object' && entry !== null)) {
        throw new Error(`${label} must be a JSON array of objects, got ${preview(value)}`);
    }
    return value.length > 0 ? (value as Record<string, unknown>[]) : null;
}

/** The longest DNS-1123 subdomain, which a RuntimeClass name is. */
const DNS_SUBDOMAIN_MAX = 253;
/** The longest DNS-1123 label, which a class name is: it is a label value and a CEL key. */
const DNS_LABEL_MAX = 63;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** A RuntimeClass name: a DNS-1123 subdomain, so a typo is a refusal at boot, never a burned attempt. */
function runtimeClassName(value: unknown, label: string): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new Error(`${label} must be a RuntimeClass name, got ${preview(value)}`);
    const name = value.trim();
    if (name === '') return null;
    if (name.length > DNS_SUBDOMAIN_MAX || !name.split('.').every((part) => DNS_LABEL.test(part))) {
        throw new Error(
            `${label} must be a RuntimeClass name (a DNS-1123 subdomain), got "${name.slice(0, ERROR_PREVIEW_CHARS)}"`
        );
    }
    return name;
}

/** A nodeSelector: kubernetes demands string values, and a YAML number (`--set foo.bar=3`) is a refusal at boot, never a burned attempt. */
function jsonNodeSelector(value: unknown, label: string): Record<string, string> | null {
    const selector = jsonObject(value, label);
    if (selector && !Object.values(selector).every((entry) => typeof entry === 'string')) {
        throw new Error(`${label} must be a JSON object of string values, got ${preview(value)}`);
    }
    return selector as Record<string, string> | null;
}

/** Refuses a key outside `known`: a misspelled field would otherwise be silently dropped. */
function assertKnownKeys(value: Record<string, unknown>, known: readonly string[], label: string): void {
    const unknown = Object.keys(value).find((key) => !known.includes(key));
    if (unknown !== undefined) {
        throw new Error(
            `${label} has an unknown key "${unknown.slice(0, ERROR_PREVIEW_CHARS)}" (known: ${known.join(', ')})`
        );
    }
}

/** A class's resources with the name of the value each slot came from, for the pair checks. */
interface LoadedResources {
    resources: RunnerResources;
    labels: Record<keyof RunnerResources, string>;
}

/** The two sides of a `resources` block and the slots each fills. */
const RESOURCE_SIDES = [
    ['requests', 'cpuRequest', 'memoryRequest'],
    ['limits', 'cpuLimit', 'memoryLimit'],
] as const;

/**
 * One class's `resources` (or `gateResources` over them): the chart's own shape, `{ requests: {
 * cpu, memory }, limits: { cpu, memory } }`, each slot shape-validated by runnerResource, then the
 * request/limit pairs validated against each other — shape is per-slot, but request>limit is only
 * visible across the two. With a `fallback`, an unset slot takes the fallback's value and the pair
 * check names the value that set it.
 */
function loadResources(value: unknown, label: string, fallback?: LoadedResources): LoadedResources {
    const block = jsonObject(value, label) ?? {};
    assertKnownKeys(block, ['requests', 'limits'], label);
    const resources = {} as RunnerResources;
    const labels = {} as Record<keyof RunnerResources, string>;
    for (const [side, cpuSlot, memorySlot] of RESOURCE_SIDES) {
        const sideLabel = `${label}.${side}`;
        const list = jsonObject(block[side], sideLabel) ?? {};
        assertKnownKeys(list, ['cpu', 'memory'], sideLabel);
        for (const [slot, kind] of [
            [cpuSlot, 'cpu'],
            [memorySlot, 'memory'],
        ] as const) {
            const own = runnerResource(list[kind], `${sideLabel}.${kind}`, kind);
            const inherited = own === null && fallback !== undefined;
            resources[slot] = inherited ? fallback.resources[slot] : own;
            labels[slot] = inherited ? fallback.labels[slot] : `${sideLabel}.${kind}`;
        }
    }
    assertRequestWithinLimit(
        resources.cpuRequest,
        resources.cpuLimit,
        [labels.cpuRequest, labels.cpuLimit],
        cpuQuantityToCores
    );
    assertRequestWithinLimit(
        resources.memoryRequest,
        resources.memoryLimit,
        [labels.memoryRequest, labels.memoryLimit],
        memoryQuantityToBytes
    );
    return { resources, labels };
}

/** The keys a class declares; any other is a refusal. */
const CLASS_KEYS = [
    'runtimeClassName',
    'nodeSelector',
    'tolerations',
    'affinity',
    'resources',
    'gateResources',
    'docker',
] as const;

/** One declared class, validated whole at boot: a bad field never reaches a pod spec. */
function runnerClassOf(name: string, value: unknown): RunnerClass {
    if (name.length > DNS_LABEL_MAX || !DNS_LABEL.test(name)) {
        throw new Error(
            `RUNNER_CLASSES declares a class "${name.slice(0, ERROR_PREVIEW_CHARS)}" whose name is not a DNS-1123 label`
        );
    }
    const label = `RUNNER_CLASSES.${name}`;
    const fields = jsonObject(value, label) ?? {};
    assertKnownKeys(fields, CLASS_KEYS, label);
    if (fields.docker !== undefined && fields.docker !== null && typeof fields.docker !== 'boolean') {
        throw new Error(`${label}.docker must be true or false, got ${preview(fields.docker)}`);
    }
    const runner = loadResources(fields.resources, `${label}.resources`);
    return {
        name,
        runtimeClassName: runtimeClassName(fields.runtimeClassName, `${label}.runtimeClassName`),
        nodeSelector: jsonNodeSelector(fields.nodeSelector, `${label}.nodeSelector`),
        tolerations: jsonArray(fields.tolerations, `${label}.tolerations`),
        affinity: jsonObject(fields.affinity, `${label}.affinity`),
        runnerResources: runner.resources,
        gateResources: loadResources(fields.gateResources, `${label}.gateResources`, runner).resources,
        docker: fields.docker === true,
    };
}

/**
 * The variables the classes replaced. Each one set at all is a refusal at boot: read silently as
 * nothing, a node selector or a RuntimeClass an operator still sets would land agent code where
 * it was never meant to run.
 */
const REMOVED_CLASS_VARIABLES = [
    'RUNNER_RUNTIME_CLASS',
    'RUNNER_NODE_SELECTOR',
    'RUNNER_TOLERATIONS',
    'RUNNER_AFFINITY',
    ...['RUNNER', 'GATE'].flatMap((prefix) =>
        ['CPU_REQUEST', 'CPU_LIMIT', 'MEMORY_REQUEST', 'MEMORY_LIMIT'].map((slot) => `${prefix}_${slot}`)
    ),
];

/** The class fields the docker executor has no twin for: the daemon decides placement and runtime. */
const KUBERNETES_ONLY_CLASS_FIELDS = ['runtimeClassName', 'nodeSelector', 'tolerations', 'affinity'] as const;

/**
 * The runner classes (RUNNER_CLASSES) and the default (RUNNER_DEFAULT_CLASS), validated whole. Unset,
 * one implicit class `default` with no fields. Under docker a class carries resources alone: one
 * that sets scheduling, a RuntimeClass or `docker: true` is refused here, naming the stated limit.
 */
export function loadRunnerClasses(env: NodeJS.ProcessEnv, executor: 'docker' | 'kubernetes'): RunnerClasses {
    const removed = REMOVED_CLASS_VARIABLES.filter((name) => env[name] !== undefined);
    if (removed.length > 0) {
        throw new Error(
            `${removed.join(', ')} ${removed.length === 1 ? 'is' : 'are'} no longer read: declare a runner class in RUNNER_CLASSES instead`
        );
    }
    const parsed = parsedJsonValue(env.RUNNER_CLASSES, 'RUNNER_CLASSES') ?? { [IMPLICIT_RUNNER_CLASS]: {} };
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`RUNNER_CLASSES must be a JSON object of classes by name, got ${preview(parsed)}`);
    }
    const runnerClasses = Object.fromEntries(
        Object.entries(parsed).map(([name, value]) => [name, runnerClassOf(name, value)])
    );
    const defaultRunnerClass = optionalText(env.RUNNER_DEFAULT_CLASS) ?? IMPLICIT_RUNNER_CLASS;
    if (!Object.hasOwn(runnerClasses, defaultRunnerClass)) {
        throw new Error(
            `RUNNER_DEFAULT_CLASS "${defaultRunnerClass.slice(0, ERROR_PREVIEW_CHARS)}" is not a class RUNNER_CLASSES declares (${Object.keys(runnerClasses).join(', ') || 'none'})`
        );
    }
    if (executor === 'docker') Object.values(runnerClasses).forEach(assertDockerClass);
    return { runnerClasses, defaultRunnerClass };
}

/** Under docker a class carries resources alone: scheduling, a RuntimeClass or a daemon is refused, naming the stated limit. */
function assertDockerClass(declared: RunnerClass): void {
    const set: string[] = KUBERNETES_ONLY_CLASS_FIELDS.filter((field) => declared[field] !== null);
    if (declared.docker) set.push('docker');
    if (set.length > 0) {
        throw new Error(
            `RUNNER_CLASSES.${declared.name} sets ${set.join(', ')}, which the docker executor cannot honor: under EXECUTOR=docker a runner class carries resources only (docs/kubernetes-limits.md)`
        );
    }
}
