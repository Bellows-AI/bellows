/**
 * The driver's instruments, on the OTEL Meter: what it spends on the board, the cluster API, the
 * docker daemon, its supervised steps and its orphan reaper, on either executor. Every attribute value is
 * from a closed vocabulary (an endpoint pattern, a verb, a resource kind, a docker command, an
 * outcome) — never a job, lease, pod, org or repo id. Each cluster API call and docker command is also a
 * CLIENT span carrying only that vocabulary. docs/telemetry.md.
 */
import { type Meter, metrics, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import type { GateResources } from './gate-result.js';
import type { ExecDocker } from './docker/docker-runner-support.js';
import type { K8sMethod, K8sRequest } from './k8s/k8s-transport.js';
import type { ReaperObserver } from './reaper.js';
import type { StepOutcome } from './step-control.js';
import type { StepKind } from './supervisor-contract.js';
import { secondsSince } from './timing.js';

export const METER_NAME = 'bellows-driver';

export type Client = 'runner' | 'reaper';

/** How a gate run ended, as its duration is labelled: its verdict, or killed at its deadline. */
export type GateOutcome = 'passed' | 'failed' | 'timeout';

/** A job claim poll: a job, a 204, a claim that failed validation, or a call that threw. */
export type ClaimPollOutcome = 'claimed' | 'idle' | 'malformed' | 'error';

export interface DriverMetrics {
    /** The board client's `fetch`, observing each call by endpoint pattern and status class. */
    fetch: typeof globalThis.fetch;
    k8s(request: K8sRequest, client: Client): K8sRequest;
    docker(exec: ExecDocker, client: Client): ExecDocker;
    /** A claim the board delivered that failed validation; the label is the first offending field. */
    malformedClaim(fields: readonly string[]): void;
    /** One job claim poll by its outcome; an idle poll is counted here and never traced. */
    claimPoll(outcome: ClaimPollOutcome): void;
    /** Reports the claim slots at each collection; `read` is in-memory and cannot fail. */
    observeSlots(read: () => { busy: number; open: number }): void;
    step(kind: StepKind, outcome: StepOutcome, seconds: number): void;
    /**
     * One gate run: its duration by `outcome`, and when the gate loop sampled the guest, the CPU split, the
     * cgroup's throttling, peak load and lowest free memory. The gate name is the one label that is repository
     * config, not a closed vocabulary: a few per repository, and no id.
     */
    gate(gate: string, outcome: GateOutcome, seconds: number, resources?: GateResources): void;
    reaper: ReaperObserver;
}

const OTHER = 'other';
const MS_PER_SECOND = 1000;
const HTTP_CLASS_DIVISOR = 100;
/** Histogram bounds written as one readable string: `buckets('0.1 0.5 1')`. */
const buckets = (spec: string): number[] => spec.split(' ').map(Number);
const HTTP_BUCKETS = buckets('0.005 0.01 0.025 0.05 0.1 0.25 0.5 1 2.5 5 10 30 60');
const STEP_BUCKETS = buckets('0.1 0.5 1 5 15 30 60 300 900 1800 3600 7200');
const DOCKER_BUCKETS = buckets('0.01 0.05 0.1 0.25 0.5 1 2.5 5 10 30 60 300 900 3600');
const SWEEP_BUCKETS = buckets('0.01 0.05 0.1 0.5 1 5 15 60 300');

/**
 * The endpoints the driver calls on the board, relative to the board base: a segment `:id` is any one
 * segment (a job, lease or reclaim id). Only a match is a label value; everything else is `other`.
 */
const JOB_ACTIONS = [
    'heartbeat',
    'session',
    'suspend',
    'interrupt',
    'complete',
    'conclusion',
    'phase-checkpoint',
    'phase-checkpoints',
    'output',
    'gates',
    'question',
    'review',
    'review-read',
    'checkpoint',
    'checkpoint/chunk',
    'transcripts',
    'transcripts/chunk',
    'gate-log',
    'artifact/chunk',
    'artifact/manifest',
    'credentials/github',
    'done',
];
const ENDPOINTS: readonly (readonly string[])[] = [
    '/api/jobs/claim',
    '/api/jobs/leases',
    '/api/reclaims/claim',
    '/api/reclaims/holds',
    '/api/reclaims/:id/ack',
    '/api/reclaims/:id/renew',
    '/api/sessions/branch',
    ...JOB_ACTIONS.map((action) => `/api/jobs/:id/${action}`),
].map((pattern) => pattern.split('/'));

/**
 * `<board base>/api/jobs/<id>/heartbeat?x=1` as `/api/jobs/:id/heartbeat`: the base path (a board behind a
 * prefix) is removed first, and a URL outside the allowlist is `other`, so neither an id of any shape
 * nor the deployment's own path ever reaches a label.
 */
export function endpointOf(url: string, boardUrl: string): string {
    let segments: string[];
    try {
        const base = new URL(boardUrl).pathname.replace(/\/+$/, '');
        const path = new URL(url).pathname;
        if (path !== base && !path.startsWith(`${base}/`)) return OTHER;
        segments = path.slice(base.length).split('/');
    } catch {
        return OTHER;
    }
    const hit = ENDPOINTS.find(
        (pattern) =>
            pattern.length === segments.length &&
            pattern.every((part, i) => (part === ':id' ? segments[i] !== '' : part === segments[i]))
    );
    return hit ? hit.join('/') : OTHER;
}

/** Path segments before `namespaces` (`apis/<group>/<version>`, `api/<version>`) and up to the resource. */
const GROUPED_PREFIX = 3;
const CORE_PREFIX = 2;
const NAMESPACED = 2;
const VERBS = { GET: 'get', POST: 'create', PUT: 'update', PATCH: 'patch', DELETE: 'delete' } as const;
const RESOURCES = new Set([
    'pods',
    'pods/log',
    'batch/jobs',
    'persistentvolumeclaims',
    'secrets',
    'configmaps',
    'metrics.k8s.io/pods',
]);

/**
 * The verb and resource kind of one API call, from the path's structure: namespaced core
 * (`/api/v1/namespaces/<ns>/<resource>[/<name>[/<sub>]]`) or grouped (`/apis/<group>/<version>/…`).
 * A path that does not parse, or names a resource outside the list, is `other`.
 */
export function k8sCallOf(method: K8sMethod, path: string): { verb: string; resource: string } {
    const segments = path.split('?')[0]!.split('/').filter(Boolean);
    const grouped = segments[0] === 'apis';
    const rest = segments.slice(grouped ? GROUPED_PREFIX : CORE_PREFIX);
    const wellFormed = (grouped || segments[0] === 'api') && rest[0] === 'namespaces' && rest.length > NAMESPACED;
    const [resource, name, sub] = wellFormed ? rest.slice(NAMESPACED) : [];
    const kind =
        resource === undefined ? OTHER : `${grouped ? `${segments[1]}/` : ''}${resource}${sub ? `/${sub}` : ''}`;
    let verb: string = VERBS[method];
    if (method === 'GET' && wellFormed && name === undefined) verb = 'list';
    if (method === 'DELETE' && wellFormed && name === undefined) verb = 'deletecollection';
    return { verb, resource: RESOURCES.has(kind) ? kind : OTHER };
}

const DOCKER_COMMANDS = new Set([
    'run',
    'create',
    'start',
    'stop',
    'kill',
    'rm',
    'ps',
    'inspect',
    'exec',
    'logs',
    'cp',
    'wait',
    'pull',
    'volume',
    'network',
    'container',
    'image',
]);

export const dockerCommandOf = (args: readonly string[]): string =>
    args[0] !== undefined && DOCKER_COMMANDS.has(args[0]) ? args[0] : OTHER;

/** `error` is a call that threw: no status came back. */
export const statusClassOf = (status: number | null): string =>
    status === null ? 'error' : `${Math.floor(status / HTTP_CLASS_DIVISOR)}xx`;

/** Runs `call`, reporting its status (null if it threw) once, then returns or rethrows. */
async function observed<T>(
    call: () => Promise<T>,
    status: (value: T) => number,
    report: (status: number | null, seconds: number) => void
): Promise<T> {
    const start = performance.now();
    let code: number | null = null;
    try {
        const value = await call();
        code = status(value);
        return value;
    } finally {
        report(code, secondsSince(start));
    }
}

function instruments(meter: Meter) {
    const seconds = (name: string, description: string, boundaries: number[]) =>
        meter.createHistogram(name, { description, unit: 's', advice: { explicitBucketBoundaries: boundaries } });
    return {
        board: seconds('bellows.driver.board.request.duration', 'Driver requests to the board.', HTTP_BUCKETS),
        k8s: seconds('bellows.driver.k8s.request.duration', 'Driver requests to the cluster API.', HTTP_BUCKETS),
        docker: meter.createCounter('bellows.driver.docker.commands', {
            description: 'Docker CLI commands the driver ran.',
        }),
        dockerDuration: seconds(
            'bellows.driver.docker.command.duration',
            'Docker CLI commands from start to exit, by command and outcome.',
            DOCKER_BUCKETS
        ),
        step: seconds(
            'bellows.driver.step.duration',
            'Supervised steps from submission to answer; sync is the per-thread checkout cost.',
            STEP_BUCKETS
        ),
        gate: seconds('bellows.driver.gate.duration', 'One gate run, by gate and outcome.', STEP_BUCKETS),
        gateCpu: meter.createHistogram('bellows.driver.gate.cpu.share', {
            description: 'The guest’s CPU time over one gate run by mode, in percent of the window.',
            advice: { explicitBucketBoundaries: buckets('1 5 10 20 30 40 50 60 70 80 90 100') },
        }),
        gateThrottled: seconds(
            'bellows.driver.gate.throttled.duration',
            'Time the gate cgroup was CPU-throttled over one gate run.',
            STEP_BUCKETS
        ),
        gateLoad: meter.createHistogram('bellows.driver.gate.load.max', {
            description: 'The highest 1-minute load average sampled during one gate run.',
            advice: { explicitBucketBoundaries: buckets('0.5 1 2 4 8 16 32') },
        }),
        gateMemory: meter.createHistogram('bellows.driver.gate.memory.available.min', {
            description: 'The least free memory sampled during one gate run, in MiB.',
            advice: { explicitBucketBoundaries: buckets('64 128 256 512 1024 2048 4096 8192 16384') },
        }),
        sweep: seconds(
            'bellows.driver.reaper.sweep.duration',
            'One orphan reaper sweep; aborted means a lookup or listing was not proven.',
            SWEEP_BUCKETS
        ),
        scanned: meter.createCounter('bellows.driver.reaper.scanned', { description: 'Objects the reaper scanned.' }),
        malformedClaim: meter.createCounter('bellows.driver.claims.malformed', {
            description: 'Claims the board delivered that failed validation and were left to their lease.',
        }),
        claimPolls: meter.createCounter('bellows.driver.claim.polls', {
            description: 'Job claim polls by outcome; idle polls are counted, never traced.',
        }),
        volumeExport: meter.createCounter('bellows.driver.reaper.volume_export', {
            description:
                'Reaper re-exports of a not-whole thread before its volume is deleted; lost is a volume deleted after its last attempt failed.',
        }),
    };
}

export function createDriverMetrics(deps: {
    boardUrl: string;
    fetch?: typeof globalThis.fetch;
    meter?: Meter;
}): DriverMetrics {
    const meter = deps.meter ?? metrics.getMeter(METER_NAME);
    const m = instruments(meter);
    const tracer = trace.getTracer(METER_NAME);
    const underlying = deps.fetch ?? globalThis.fetch;
    return {
        fetch: (input, init) =>
            observed(
                () => underlying(input, init),
                (response) => response.status,
                (status, elapsed) =>
                    m.board.record(elapsed, {
                        endpoint: endpointOf(
                            typeof input === 'string' || input instanceof URL ? String(input) : input.url,
                            deps.boardUrl
                        ),
                        status_class: statusClassOf(status),
                    })
            ),
        k8s: (request, client) => (method, path, body, options) => {
            const call = k8sCallOf(method, path);
            return tracer.startActiveSpan(
                `k8s ${call.verb} ${call.resource}`,
                { kind: SpanKind.CLIENT, attributes: { 'k8s.verb': call.verb, 'k8s.resource': call.resource } },
                async (span) => {
                    try {
                        return await observed(
                            () => request(method, path, body, options),
                            (response) => {
                                span.setAttribute('http.response.status_code', response.status);
                                return response.status;
                            },
                            (status, elapsed) =>
                                m.k8s.record(elapsed, { client, ...call, status_class: statusClassOf(status) })
                        );
                    } catch (e) {
                        span.setStatus({ code: SpanStatusCode.ERROR });
                        throw e;
                    } finally {
                        span.end();
                    }
                }
            );
        },
        docker: (exec, client) => async (args, options) => {
            const command = dockerCommandOf(args);
            const start = performance.now();
            let outcome: 'ok' | 'error' = 'error';
            return tracer.startActiveSpan(
                `docker ${command}`,
                { kind: SpanKind.CLIENT, attributes: { 'docker.command': command } },
                async (span) => {
                    try {
                        const result = await exec(args, options);
                        outcome = 'ok';
                        m.docker.add(1, { client, command, outcome: 'ok' });
                        return result;
                    } catch (e) {
                        m.docker.add(1, { client, command, outcome: 'error' });
                        span.setStatus({ code: SpanStatusCode.ERROR });
                        throw e;
                    } finally {
                        m.dockerDuration.record(secondsSince(start), { client, command, outcome });
                        span.end();
                    }
                }
            );
        },
        observeSlots: (read) => {
            meter
                .createObservableGauge('bellows.driver.slots', {
                    description:
                        'Job claim slots: busy holds an attempt; open is what the claim loop would claim into now, 0 while full or draining.',
                })
                .addCallback((result) => {
                    const { busy, open } = read();
                    result.observe(busy, { state: 'busy' });
                    result.observe(open, { state: 'open' });
                });
        },
        malformedClaim: (fields) => m.malformedClaim.add(1, { field: fields[0] ?? OTHER }),
        claimPoll: (outcome) => m.claimPolls.add(1, { outcome }),
        step: (kind, outcome, elapsed) => m.step.record(elapsed, { kind, outcome }),
        gate: (gate, outcome, elapsed, resources) => {
            m.gate.record(elapsed, { gate, outcome });
            if (!resources) return;
            for (const [mode, share] of Object.entries(resources.cpu ?? {})) m.gateCpu.record(share, { gate, mode });
            m.gateThrottled.record(resources.throttledMs / MS_PER_SECOND, { gate });
            m.gateLoad.record(resources.load.max, { gate });
            m.gateMemory.record(resources.memAvailableMb.min, { gate });
        },
        reaper: {
            sweep: (outcome, elapsed) => m.sweep.record(elapsed, { outcome }),
            scanned: (what, count) => m.scanned.add(count, { what }),
            volumeExport: (result) => m.volumeExport.add(1, { result }),
        },
    };
}
