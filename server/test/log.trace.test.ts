import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureLogs } from './helpers-log.js';

const INFO_SEVERITY = 9;
const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: new InMemorySpanExporter() })],
});
const contextManager = new AsyncLocalStorageContextManager().enable();

beforeAll(() => {
    context.disable();
    context.setGlobalContextManager(contextManager);
});
afterAll(() => context.disable());

describe('log trace correlation', () => {
    it('a record written inside a span carries its ids, on stdout and over OTLP', () => {
        const capture = captureLogs();
        const tracer = provider.getTracer('test');
        const ids = tracer.startActiveSpan('work', (span) => {
            capture.logger.child({ component: 'x' }).info('m');
            span.end();
            return span.spanContext();
        });
        const [record] = capture.records();
        expect(record).toMatchObject({
            level: 30,
            msg: 'm',
            component: 'x',
            trace_id: ids.traceId,
            span_id: ids.spanId,
        });
        const [sent] = capture.emitted();
        expect(sent).toMatchObject({ severityNumber: INFO_SEVERITY, severityText: 'INFO', body: 'm' });
        expect(sent?.attributes).toMatchObject({ component: 'x', trace_id: ids.traceId, span_id: ids.spanId });
        capture.stop();
    });

    it('a record outside a span has neither key', () => {
        const capture = captureLogs();
        expect(trace.getActiveSpan()).toBeUndefined();
        capture.logger.info('m');
        const [record] = capture.records();
        expect(record).not.toHaveProperty('trace_id');
        expect(record).not.toHaveProperty('span_id');
        capture.stop();
    });
});
