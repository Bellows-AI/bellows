/**
 * The board's Prometheus series (issue #831). Every label value comes from a closed vocabulary — a
 * route pattern, a status class, an outcome, an admission scope — never an org, repo, job, lease or
 * user id, so the series stay bounded and a scrape with the shared worker credential cannot name a
 * tenant. docs/telemetry.md.
 */

import type { AdmissionBudgets, AdmissionOccupancy, ClaimObserver } from './db/jobs/job-store-admission.js';
import { buckets, createRegistry, timed, type GaugeFamily, type Registry } from './prometheus.js';

export type { AdmissionOccupancy } from './db/jobs/job-store-admission.js';

export type ClaimPollOutcome = 'claimed' | 'idle' | 'error';

const HTTP_BUCKETS = buckets('0.005 0.01 0.025 0.05 0.1 0.25 0.5 1 2.5 5 10 30');
const DB_BUCKETS = buckets('0.001 0.005 0.01 0.025 0.05 0.1 0.25 0.5 1 2.5 5 15');
/** A queued row can wait for a free slot for hours; the buckets reach past a shift. */
const WAIT_BUCKETS = buckets('0.1 0.5 1 5 15 30 60 300 900 1800 3600 14400 86400');
const PASS_BUCKETS = buckets('0.01 0.05 0.1 0.5 1 2.5 5 15 30 60');

export interface ServerMetrics {
    render(): Promise<string>;
    /** One finished request: `route` is the matched pattern or `<unmatched>`. */
    request(method: string, route: string, statusCode: number, seconds: number): void;
    claimPoll(outcome: ClaimPollOutcome): void;
    claim: ClaimObserver;
    /**
     * Runs one pass of a board background loop and observes it: `timedPass('batch_reconcile', () => …)`.
     * A new loop is wrapped the same way, in one line, where it starts.
     */
    timedPass<T>(loop: string, fn: () => Promise<T>): Promise<T>;
}

export interface ServerMetricsDeps {
    /** The configured budgets, exported as limits. */
    admission: AdmissionBudgets;
    /** One bounded read of what runs now; a rejection omits the occupancy samples. */
    occupancy: (signal: AbortSignal) => Promise<AdmissionOccupancy>;
    /** The whole scrape-time read's deadline, connection wait included; defaults to the registry's. */
    readDeadlineMs?: number;
}

const STATUS_CLASS_DIVISOR = 100;
const statusClass = (code: number): string => `${Math.floor(code / STATUS_CLASS_DIVISOR)}xx`;

const limitFamily = (admission: AdmissionBudgets): GaugeFamily => ({
    name: 'factory_admission_limit',
    help: 'Configured admission limit per scope.',
    samples: (['global', 'org', 'repo'] as const).flatMap((scope) =>
        admission[scope] === undefined ? [] : [{ labels: { scope }, value: admission[scope] }]
    ),
});

const occupancyFamilies = (read: AdmissionOccupancy): GaugeFamily[] => [
    {
        name: 'factory_admission_running',
        help: 'Rows running now across every org.',
        samples: [{ labels: { scope: 'global' }, value: read.global }],
    },
    {
        name: 'factory_admission_running_max',
        help: 'Rows running now in the busiest org and the busiest repo.',
        samples: [
            { labels: { scope: 'org' }, value: read.orgMax },
            { labels: { scope: 'repo' }, value: read.repoMax },
        ],
    },
];

/** The limits need no read, so they survive a failed occupancy read; the occupancy samples do not. */
function registerAdmission(registry: Registry, deps: ServerMetricsDeps): void {
    registry.collect('admission_limits', async () => [limitFamily(deps.admission)]);
    registry.collect('admission', async (signal) => occupancyFamilies(await deps.occupancy(signal)));
}

export function createServerMetrics(deps: ServerMetricsDeps): ServerMetrics {
    const registry = createRegistry({
        failures: 'factory_metrics_read_failures_total',
        ...(deps.readDeadlineMs === undefined ? {} : { readDeadlineMs: deps.readDeadlineMs }),
    });
    const http = registry.histogram(
        'factory_http_request_duration_seconds',
        'Board HTTP request duration; the rate of a route is its _count.',
        ['method', 'route', 'status_class'],
        HTTP_BUCKETS
    );
    const polls = registry.counter('factory_claim_polls_total', 'Claim polls by outcome.', ['outcome']);
    const refusals = registry.counter(
        'factory_claim_refusals_total',
        'Claim candidates an admission budget refused, by the scope that was full.',
        ['scope']
    );
    const wait = registry.histogram(
        'factory_claim_wait_seconds',
        'Queued to claimed: a new row, or the takeover of a lost attempt.',
        ['kind'],
        WAIT_BUCKETS
    );
    const lockWait = registry.histogram(
        'factory_claim_lock_wait_seconds',
        'The claim acquisition taking its row lock and thread-root advisory lock, round trips included.',
        [],
        DB_BUCKETS
    );
    const acquire = registry.histogram(
        'factory_claim_acquire_seconds',
        'The whole claim acquisition transaction.',
        [],
        DB_BUCKETS
    );
    const sweep = registry.histogram(
        'factory_claim_sweep_seconds',
        'The settle passes a claim runs before it looks for a candidate.',
        [],
        DB_BUCKETS
    );
    const passes = registry.histogram(
        'factory_background_pass_seconds',
        'One pass of a board background loop.',
        ['loop', 'outcome'],
        PASS_BUCKETS
    );
    registerAdmission(registry, deps);
    return {
        render: () => registry.render(),
        request: (method, route, code, seconds) =>
            http.observe(seconds, { method, route, status_class: statusClass(code) }),
        claimPoll: (outcome) => polls.inc({ outcome }),
        claim: {
            refusal: (scope) => refusals.inc({ scope }),
            wait: (kind, seconds) => wait.observe(seconds, { kind }),
            lockWait: (seconds) => lockWait.observe(seconds),
            acquire: (seconds) => acquire.observe(seconds),
            sweep: (seconds) => sweep.observe(seconds),
        },
        timedPass: (loop, fn) => timed(passes, (outcome) => ({ loop, outcome }), fn),
    };
}
