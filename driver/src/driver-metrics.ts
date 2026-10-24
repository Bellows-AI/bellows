/**
 * The driver's Prometheus series (issue #831): what it spends on the board, the cluster API, the
 * docker daemon, its supervised steps and its orphan reaper, on either executor. Every label value is
 * from a closed vocabulary (an endpoint pattern, a verb, a resource kind, a docker command, an
 * outcome) — never a job, lease, pod, org or repo id. docs/telemetry.md.
 */

import type { ExecDocker } from './docker/docker-runner-support.js';
import type { K8sMethod, K8sRequest } from './k8s/k8s-transport.js';
import { buckets, createRegistry, secondsSince, type Registry } from './prometheus.js';
import type { ReaperObserver } from './reaper.js';
import type { StepOutcome } from './step-control.js';
import type { StepKind } from './supervisor-contract.js';

export type Client = 'runner' | 'reaper';

export interface DriverMetrics {
    render(): Promise<string>;
    /** The board client's `fetch`, observing each call by endpoint pattern and status class. */
    fetch: typeof globalThis.fetch;
    k8s(request: K8sRequest, client: Client): K8sRequest;
    docker(exec: ExecDocker, client: Client): ExecDocker;
    step(kind: StepKind, outcome: StepOutcome, seconds: number): void;
    reaper: ReaperObserver;
}

const OTHER = 'other';
const HTTP_CLASS_DIVISOR = 100;
const HTTP_BUCKETS = buckets('0.005 0.01 0.025 0.05 0.1 0.25 0.5 1 2.5 5 10 30 60');
const STEP_BUCKETS = buckets('0.1 0.5 1 5 15 30 60 300 900 1800 3600 7200');
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

function instruments(registry: Registry) {
    return {
        board: registry.histogram(
            'factory_driver_board_request_duration_seconds',
            'Driver requests to the board.',
            ['endpoint', 'status_class'],
            HTTP_BUCKETS
        ),
        k8s: registry.histogram(
            'factory_driver_k8s_request_duration_seconds',
            'Driver requests to the cluster API.',
            ['client', 'verb', 'resource', 'status_class'],
            HTTP_BUCKETS
        ),
        docker: registry.counter('factory_driver_docker_commands_total', 'Docker CLI commands the driver ran.', [
            'client',
            'command',
            'outcome',
        ]),
        step: registry.histogram(
            'factory_driver_step_seconds',
            'Supervised steps from submission to answer; sync is the per-thread checkout cost.',
            ['kind', 'outcome'],
            STEP_BUCKETS
        ),
        sweep: registry.histogram(
            'factory_driver_reaper_sweep_seconds',
            'One orphan reaper sweep; aborted means a lookup or listing was not proven.',
            ['outcome'],
            SWEEP_BUCKETS
        ),
        scanned: registry.counter('factory_driver_reaper_scanned_total', 'Objects the reaper scanned.', ['what']),
    };
}

export function createDriverMetrics(deps: { boardUrl: string; fetch?: typeof globalThis.fetch }): DriverMetrics {
    const registry = createRegistry();
    const m = instruments(registry);
    const underlying = deps.fetch ?? globalThis.fetch;
    return {
        render: () => registry.render(),
        fetch: (input, init) =>
            observed(
                () => underlying(input, init),
                (response) => response.status,
                (status, seconds) =>
                    m.board.observe(seconds, {
                        endpoint: endpointOf(
                            typeof input === 'string' || input instanceof URL ? String(input) : input.url,
                            deps.boardUrl
                        ),
                        status_class: statusClassOf(status),
                    })
            ),
        k8s: (request, client) => (method, path, body, options) =>
            observed(
                () => request(method, path, body, options),
                (response) => response.status,
                (status, seconds) =>
                    m.k8s.observe(seconds, { client, ...k8sCallOf(method, path), status_class: statusClassOf(status) })
            ),
        docker: (exec, client) => async (args, options) => {
            const command = dockerCommandOf(args);
            try {
                const result = await exec(args, options);
                m.docker.inc({ client, command, outcome: 'ok' });
                return result;
            } catch (e) {
                m.docker.inc({ client, command, outcome: 'error' });
                throw e;
            }
        },
        step: (kind, outcome, seconds) => m.step.observe(seconds, { kind, outcome }),
        reaper: {
            sweep: (outcome, seconds) => m.sweep.observe(seconds, { outcome }),
            scanned: (what, count) => m.scanned.inc({ what }, count),
        },
    };
}
