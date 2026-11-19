import { context, SeverityNumber, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogRoot, diagLogger } from '../src/log.js';

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
