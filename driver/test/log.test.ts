import { context, SeverityNumber, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogRoot, describeError, diagLogger } from '../src/log.js';

const spans = new InMemorySpanExporter();
const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] });
const records = new InMemoryLogRecordExporter();
const loggerProvider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: records })] });

beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(tracerProvider);
});
afterAll(() => {
    trace.disable();
    context.disable();
});

function capture() {
    const lines: string[] = [];
    const root = createLogRoot({
        stdout: { write: (line) => lines.push(line) },
        logger: () => loggerProvider.getLogger('test'),
    });
    return { root, lines, record: (i = 0) => JSON.parse(lines[i]!) as Record<string, unknown> };
}

describe('the driver logger', () => {
    it('writes a pino record: numeric level, time, msg and component, no trace ids outside a span', () => {
        const { root, record } = capture();
        root.child({ component: 'reaper' }).info({ job: 'j-1' }, 'swept');
        expect(record()).toMatchObject({ level: 30, msg: 'swept', component: 'reaper', job: 'j-1' });
        expect(typeof record().time).toBe('number');
        expect(record()).not.toHaveProperty('trace_id');
        expect(record()).not.toHaveProperty('span_id');
    });

    it('carries the active span’s trace_id and span_id', () => {
        const { root, record } = capture();
        const span = trace.getTracer('test').startSpan('work');
        context.with(trace.setSpan(context.active(), span), () => root.child({ component: 'loop' }).warn('inside'));
        span.end();
        expect(record()).toMatchObject({
            trace_id: span.spanContext().traceId,
            span_id: span.spanContext().spanId,
        });
    });

    it.each([
        ['trace', 10, SeverityNumber.TRACE, 'TRACE'],
        ['debug', 20, SeverityNumber.DEBUG, 'DEBUG'],
        ['info', 30, SeverityNumber.INFO, 'INFO'],
        ['warn', 40, SeverityNumber.WARN, 'WARN'],
        ['error', 50, SeverityNumber.ERROR, 'ERROR'],
        ['fatal', 60, SeverityNumber.FATAL, 'FATAL'],
    ] as const)('ships a %s record on OTLP with its mapped severity', (method, level, severity, text) => {
        records.reset();
        const { root } = capture();
        root.level = 'trace';
        root.child({ component: 'drain' })[method]({ count: 2 }, 'hello');
        const [out] = records.getFinishedLogRecords();
        expect(out!.severityNumber).toBe(severity);
        expect(out!.severityText).toBe(text);
        expect(out!.body).toBe('hello');
        expect(out!.attributes).toEqual({ component: 'drain', count: 2 });
        expect(level).toBeGreaterThan(0);
    });

    it('swallows an OTLP-side failure: the stdout line is still written', () => {
        const lines: string[] = [];
        const root = createLogRoot({
            stdout: { write: (line) => lines.push(line) },
            logger: () => {
                throw new Error('provider down');
            },
        });
        expect(() => root.info('still here')).not.toThrow();
        expect(lines).toHaveLength(1);
    });
});

describe('what a record may hold', () => {
    /** Everything either destination received, as one string to search. */
    const everything = (lines: string[]) =>
        lines.join('') +
        JSON.stringify(records.getFinishedLogRecords().map((r) => ({ body: r.body, attributes: r.attributes })));

    it('blanks credentials before both stdout and OTLP', () => {
        records.reset();
        const { root, lines } = capture();
        root.info(
            {
                req: { headers: { authorization: 'Bearer secret_a', cookie: 'sid=secret_b' } },
                auth: { token: 'secret_c', password: 'secret_d' },
            },
            'request'
        );
        const text = everything(lines);
        for (const secret of ['secret_a', 'secret_b', 'secret_c', 'secret_d']) expect(text).not.toContain(secret);
        expect(text).toContain('[Redacted]');
    });

    it('describes an error by class only: never its message, stack or cause, in either destination', () => {
        records.reset();
        const { root, lines, record } = capture();
        const failure = Object.assign(new Error('failed for owner/private-repo branch feature/private'), {
            kind: 'transport',
            status: 503,
        });
        root.error({ err: failure }, 'publish failed');
        root.error(failure);
        root.error({ err: failure });
        const text = everything(lines);
        for (const leak of ['private-repo', 'feature/private', 'owner/']) expect(text).not.toContain(leak);
        expect(record(0)).toMatchObject({ err: { type: 'Error', kind: 'transport', status: 503 } });
        expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(['publish failed', 'error', 'error']);
    });

    it('describes an error as one token string for the seams that take a line', () => {
        expect(describeError(Object.assign(new Error('owner/private-repo'), { code: 'ENOENT' }))).toBe('Error ENOENT');
        expect(describeError('owner/private-repo')).toBe('NonError');
    });
});

describe('the SDK diagnostics', () => {
    it('go to stdout only, at most once a minute', () => {
        const lines: string[] = [];
        let now = 1_000_000;
        const diag = diagLogger({ write: (line) => lines.push(line) }, () => now);
        diag.error('export failed');
        diag.error('export failed again');
        now += 61_000;
        diag.warn('still failing');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]!)).toMatchObject({ level: 50, component: 'otel', msg: 'export failed' });
    });
});
