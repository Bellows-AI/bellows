/**
 * One client span per Postgres statement. `postgres` ships no instrumentation, so the span is cut where every
 * statement of every pool and transaction passes: `Query#handle`, which runs once, when the query executes. The span
 * carries the operation verb only — never the statement text or a parameter. docs/telemetry.md.
 */
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import postgres from 'postgres';

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

let installed = false;

export function installPostgresTracing(): void {
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
        const { resolve, reject } = this;
        this.resolve = (value) => {
            span.end();
            resolve(value);
        };
        this.reject = (reason) => {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
            reject(reason);
        };
        return handle.call(this);
    };
}
