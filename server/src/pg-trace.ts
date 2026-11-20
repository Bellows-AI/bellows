/**
 * One client span per Postgres statement. `postgres` ships no instrumentation, so the span is cut where every
 * statement of every pool and transaction passes: `Query#handle`, which runs once, when the query executes. The span
 * carries the operation verb only — never the statement text or a parameter. docs/telemetry.md.
 */
import { metrics, SpanKind, SpanStatusCode, trace, type Histogram, type Meter } from '@opentelemetry/api';
import postgres from 'postgres';
import { DB_BUCKETS, METER_NAME } from './metrics.js';
import { secondsSince } from './timing.js';

const TRACER_NAME = 'bellows-board-postgres';
const SPAN_NAME_PREFIX = 'postgres';

interface TracedQuery {
    executed: boolean;
    strings: TemplateStringsArray | string;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    handle: () => Promise<void>;
}

const VERB = /^\s*(\w+)/;

/** The leading SQL keyword of a tagged template or an `unsafe` string, upper-cased; `QUERY` when there is none. */
export function operationOf(strings: TemplateStringsArray | string): string {
    const text = typeof strings === 'string' ? strings : (strings[0] ?? '');
    return VERB.exec(text)?.[1]?.toUpperCase() ?? 'QUERY';
}

/** `db.client.operation.duration`: one point per statement, labelled by verb alone. */
export function dbOperationDuration(meter: Meter): Histogram {
    return meter.createHistogram('db.client.operation.duration', {
        unit: 's',
        description: 'Board Postgres statement duration, by verb.',
        advice: { explicitBucketBoundaries: DB_BUCKETS },
    });
}

let installed = false;
let duration: Histogram | undefined;

export function installPostgresTracing(meter: Meter = metrics.getMeter(METER_NAME)): void {
    // Rebound on every call: a shared test fork may have installed against another meter first.
    duration = dbOperationDuration(meter);
    if (installed) return;
    installed = true;
    // An unexecuted query is a plain Promise subclass instance: building one opens no connection.
    const proto = Object.getPrototypeOf(postgres({ max: 0 })``) as TracedQuery;
    const handle = proto.handle;
    proto.handle = function (this: TracedQuery) {
        if (this.executed) return handle.call(this);
        const operation = operationOf(this.strings);
        const span = trace.getTracer(TRACER_NAME).startSpan(`${SPAN_NAME_PREFIX} ${operation}`, {
            kind: SpanKind.CLIENT,
            attributes: { 'db.system.name': 'postgresql', 'db.operation.name': operation },
        });
        const start = performance.now();
        let ended = false;
        const end = (failed: boolean) => {
            if (ended) return;
            ended = true;
            duration?.record(secondsSince(start), { 'db.system.name': 'postgresql', 'db.operation.name': operation });
            if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
        };
        // A cursor reassigns `resolve` and `reject` before every `next()`, so the wrapping rides accessors.
        const wrapped = { resolve: this.resolve, reject: this.reject };
        Object.defineProperty(this, 'resolve', {
            configurable: true,
            get: () => (value: unknown) => {
                end(false);
                wrapped.resolve(value);
            },
            set: (fn: TracedQuery['resolve']) => {
                wrapped.resolve = fn;
            },
        });
        Object.defineProperty(this, 'reject', {
            configurable: true,
            get: () => (reason: unknown) => {
                end(true);
                wrapped.reject(reason);
            },
            set: (fn: TracedQuery['reject']) => {
                wrapped.reject = fn;
            },
        });
        return handle.call(this);
    };
}
