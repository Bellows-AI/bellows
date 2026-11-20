/**
 * The board's OTEL instruments, reported through the global Meter (`server/src/otel.ts` starts the SDK; unstarted, the
 * instruments are no-ops). Every attribute value comes from a closed vocabulary — a route pattern, a status code, an
 * outcome, an admission scope — never an org, repo, job, lease or user id, so the series stay bounded and a backend
 * cannot name a tenant. `server/test/metrics.attributes.test.ts` pins each instrument's attribute names.
 * docs/telemetry.md.
 */

import { metrics, type Attributes, type Histogram, type Meter } from '@opentelemetry/api';
import type { AdmissionBudgets, AdmissionOccupancy, ClaimObserver } from './db/jobs/job-store-admission.js';
import { BOARD_SCOPE, inBoardSpan } from './board-span.js';
import { secondsSince } from './timing.js';

export type { AdmissionOccupancy } from './db/jobs/job-store-admission.js';

export type McpToolOutcome = 'ok' | 'refused' | 'inconclusive';
export type ClaimPollOutcome = 'claimed' | 'idle' | 'error';
type PassOutcome = 'ok' | 'error';

/** The Meter's instrumentation scope. */
export const METER_NAME = BOARD_SCOPE;

const ATTR_PASS_OUTCOME = 'bellows.pass.outcome';

const SECONDS = 's';

/** Histogram bounds written as one readable string: `buckets('0.1 0.5 1')`. */
const buckets = (spec: string): number[] => spec.split(' ').map(Number);

const HTTP_BUCKETS = buckets('0.005 0.01 0.025 0.05 0.1 0.25 0.5 1 2.5 5 10 30');
export const DB_BUCKETS = buckets('0.001 0.005 0.01 0.025 0.05 0.1 0.25 0.5 1 2.5 5 15');
/** A queued row can wait for a free slot for hours; the buckets reach past a shift. */
const WAIT_BUCKETS = buckets('0.1 0.5 1 5 15 30 60 300 900 1800 3600 14400 86400');
const PASS_BUCKETS = buckets('0.01 0.05 0.1 0.5 1 2.5 5 15 30 60');

const DEFAULT_READ_DEADLINE_MS = 2000;
const ADMISSION_SOURCE = 'admission';

export interface ServerMetrics {
    /** One finished request: `route` is the matched pattern or `<unmatched>`. */
    request(method: string, route: string, statusCode: number, seconds: number): void;
    claimPoll(outcome: ClaimPollOutcome): void;
    /** One finished MCP tool call: the registered tool name and how it ended; never an argument or a caller. */
    mcpTool(tool: string, outcome: McpToolOutcome, seconds: number): void;
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
    /** The collection-time read's deadline, connection wait included. */
    readDeadlineMs?: number;
    /** The Meter to report into; defaults to the global one the SDK installs. */
    meter?: Meter;
}

/** `read` raced against a deadline that also aborts its signal, so a read stuck on a connection is let go. */
async function readWithin<T>(read: (signal: AbortSignal) => Promise<T>, deadlineMs: number): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`the read outlived its ${deadlineMs} ms deadline`));
        }, deadlineMs);
    });
    try {
        return await Promise.race([read(controller.signal), expired]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Runs `fn` and records its duration exactly once, in `finally`, then returns or rethrows. `attributes` is a function
 * of the outcome.
 */
async function timed<T>(
    histogram: Histogram,
    attributes: (outcome: PassOutcome) => Attributes,
    fn: () => Promise<T>
): Promise<T> {
    const start = performance.now();
    let outcome: PassOutcome = 'error';
    try {
        const value = await fn();
        outcome = 'ok';
        return value;
    } finally {
        histogram.record(secondsSince(start), attributes(outcome));
    }
}

/**
 * Every replica reports the admission gauges, so a dashboard aggregates them with `max`. The limits need no read, so
 * they survive a failed occupancy read; the occupancy samples do not, and the failure is counted.
 */
function observeAdmission(meter: Meter, deps: ServerMetricsDeps, failures: (source: string) => void): void {
    const limit = meter.createObservableGauge('bellows.admission.limit', {
        description: 'Configured admission limit per scope.',
    });
    const running = meter.createObservableGauge('bellows.admission.running', {
        description: 'Rows running now across every org.',
    });
    const runningMax = meter.createObservableGauge('bellows.admission.running.max', {
        description: 'Rows running now in the busiest org and the busiest repo.',
    });
    limit.addCallback((result) => {
        for (const scope of ['global', 'org', 'repo'] as const) {
            const value = deps.admission[scope];
            if (value !== undefined) result.observe(value, { scope });
        }
    });
    // One read feeds both occupancy gauges.
    meter.addBatchObservableCallback(
        async (result) => {
            let value: AdmissionOccupancy;
            try {
                value = await readWithin(deps.occupancy, deps.readDeadlineMs ?? DEFAULT_READ_DEADLINE_MS);
            } catch {
                failures(ADMISSION_SOURCE);
                return;
            }
            result.observe(running, value.global, { scope: 'global' });
            result.observe(runningMax, value.orgMax, { scope: 'org' });
            result.observe(runningMax, value.repoMax, { scope: 'repo' });
        },
        [running, runningMax]
    );
}

export function createServerMetrics(deps: ServerMetricsDeps): ServerMetrics {
    const meter = deps.meter ?? metrics.getMeter(METER_NAME);
    const histogram = (name: string, description: string, boundaries: number[]) =>
        meter.createHistogram(name, { description, unit: SECONDS, advice: { explicitBucketBoundaries: boundaries } });
    const http = histogram('http.server.request.duration', 'Board HTTP request duration.', HTTP_BUCKETS);
    const polls = meter.createCounter('bellows.claim.polls', { description: 'Claim polls by outcome.' });
    const refusals = meter.createCounter('bellows.claim.refusals', {
        description: 'Claim candidates an admission budget refused, by the scope that was full.',
    });
    const wait = histogram(
        'bellows.claim.wait',
        'Queued to claimed: a new row, or the takeover of a lost attempt.',
        WAIT_BUCKETS
    );
    const lockWait = histogram(
        'bellows.claim.lock_wait',
        'The claim acquisition taking its row lock and trying its thread-root advisory lock, round trips included.',
        DB_BUCKETS
    );
    const acquire = histogram('bellows.claim.acquire', 'The whole claim acquisition transaction.', DB_BUCKETS);
    const sweep = histogram(
        'bellows.claim.sweep',
        'The settle passes a claim runs before it looks for a candidate.',
        DB_BUCKETS
    );
    const interruptions = meter.createCounter('bellows.job.interruptions', {
        description: 'Interruptions recorded on an attempt, by cause and whether the attempt was refunded.',
    });
    const settled = meter.createCounter('bellows.job.settled', {
        description: 'Attempts settled by a verdict or a dead retirement, by outcome and failure kind or rule.',
    });
    const passes = histogram('bellows.background.pass.duration', 'One pass of a board background loop.', PASS_BUCKETS);
    const mcpCalls = histogram(
        'bellows.mcp.tool.duration',
        'MCP tool calls by registered tool and outcome (ok, refused, inconclusive).',
        HTTP_BUCKETS
    );
    const readFailures = meter.createCounter('bellows.metrics.read.failures', {
        description: 'Collection-time reads that failed; their samples are omitted, never reported as zero.',
    });
    observeAdmission(meter, deps, (source) => readFailures.add(1, { source }));
    return {
        request: (method, route, code, seconds) =>
            http.record(seconds, {
                'http.request.method': method,
                'http.route': route,
                'http.response.status_code': code,
            }),
        claimPoll: (outcome) => polls.add(1, { outcome }),
        mcpTool: (tool, outcome, seconds) => mcpCalls.record(seconds, { tool, outcome }),
        claim: {
            refusal: (scope) => refusals.add(1, { scope }),
            wait: (kind, seconds) => wait.record(seconds, { kind }),
            lockWait: (seconds) => lockWait.record(seconds),
            acquire: (seconds) => acquire.record(seconds),
            sweep: (seconds) => sweep.record(seconds),
            interrupted: (cause, refunded) => interruptions.add(1, { cause, refunded }),
            settled: (outcome, cause) => settled.add(1, { outcome, cause }),
        },
        // Each pass is its own trace root, whatever span its loop was started under.
        timedPass: (loop, fn) =>
            inBoardSpan(
                'background.pass',
                (span) =>
                    timed(
                        passes,
                        (outcome) => {
                            span.setAttribute(ATTR_PASS_OUTCOME, outcome);
                            return { loop, outcome };
                        },
                        fn
                    ),
                { root: true, attributes: { loop } }
            ),
    };
}
