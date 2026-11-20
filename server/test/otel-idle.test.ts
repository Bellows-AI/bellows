import { context, ROOT_CONTEXT, SpanKind, trace, TraceFlags } from '@opentelemetry/api';
import type { Context, Span, Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeferringSpanProcessor as DriverDeferring } from '../../driver/src/otel-idle.js';
import { DeferringSpanProcessor as ServerDeferring } from '../src/otel-idle.js';

const SPANS_PER_TRACE = 256;
const OPEN_TRACES = 1024;

/** Keeps every exported name, since the in-memory exporter forgets its spans on shutdown. */
class RecordingExporter extends InMemorySpanExporter {
    readonly seen: string[] = [];
    override export(spans: ReadableSpan[], done: Parameters<InMemorySpanExporter['export']>[1]): void {
        this.seen.push(...spans.map((span) => span.name));
        super.export(spans, done);
    }
}

const contextManager = new AsyncLocalStorageContextManager().enable();
beforeAll(() => {
    context.disable();
    context.setGlobalContextManager(contextManager);
});
afterAll(() => context.disable());

/** The driver imports nothing from the server, so its processor is a copy; both run the same table. */
describe.each([
    ['server', ServerDeferring],
    ['driver', DriverDeferring],
])('the %s deferring span processor', (_name, Deferring) => {
    const setup = () => {
        const exporter = new RecordingExporter();
        const processor = new Deferring([new SimpleSpanProcessor({ exporter })]);
        const provider = new TracerProvider({ spanProcessors: [processor] });
        const tracer: Tracer = provider.getTracer('test');
        const names = () => [...exporter.seen];
        return { provider, tracer, names };
    };
    const server = (tracer: Tracer, name: string, parent: Context = ROOT_CONTEXT): Span =>
        tracer.startSpan(name, { kind: SpanKind.SERVER }, parent);
    const child = (tracer: Tracer, parent: Span, name: string): Span =>
        tracer.startSpan(name, {}, trace.setSpan(ROOT_CONTEXT, parent));

    it('drops an idle server-rooted trace, children and a late child included', () => {
        const { tracer, names } = setup();
        const late = tracer.startActiveSpan('poll', { kind: SpanKind.SERVER }, (root) => {
            tracer.startActiveSpan('postgres select', (span) => span.end());
            const pending = tracer.startSpan('postgres update');
            root.setAttribute('bellows.poll.idle', true);
            root.end();
            return pending;
        });
        late.end();
        expect(names()).toEqual([]);
    });

    it('exports every span of a trace whose root is not idle, root last', () => {
        const { tracer, names } = setup();
        const root = server(tracer, 'claim');
        child(tracer, root, 'a').end();
        child(tracer, root, 'b').end();
        expect(names()).toEqual([]);
        root.end();
        expect(names()).toEqual(['a', 'b', 'claim']);
    });

    it('treats a span with a remote parent as a local root', () => {
        const { tracer, names } = setup();
        const remote = trace.setSpanContext(ROOT_CONTEXT, {
            traceId: '0af7651916cd43dd8448eb211c80319c',
            spanId: 'b7ad6b7169203331',
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
        });
        const root = server(tracer, 'poll', remote);
        child(tracer, root, 'a').end();
        root.setAttribute('bellows.poll.idle', true);
        root.end();
        expect(names()).toEqual([]);
    });

    it('defers a non-server root that carries bellows.poll at start', () => {
        const { tracer, names } = setup();
        const root = tracer.startSpan('claim', { attributes: { 'bellows.poll': true } });
        child(tracer, root, 'undici').end();
        expect(names()).toEqual([]);
        root.setAttribute('bellows.poll.idle', true);
        root.end();
        expect(names()).toEqual([]);
    });

    it('passes a non-server, non-poll root straight through', () => {
        const { tracer, names } = setup();
        const root = tracer.startSpan('provision');
        child(tracer, root, 'k8s').end();
        expect(names()).toEqual(['k8s']);
        root.setAttribute('bellows.poll.idle', true);
        root.end();
        expect(names()).toEqual(['k8s', 'provision']);
    });

    it('forwards an open trace past its span bound and passes the rest through', () => {
        const { tracer, names } = setup();
        const root = server(tracer, 'busy');
        for (let i = 0; i < SPANS_PER_TRACE; i++) child(tracer, root, 'c').end();
        expect(names()).toHaveLength(0);
        child(tracer, root, 'c').end();
        expect(names()).toHaveLength(SPANS_PER_TRACE + 1);
        child(tracer, root, 'c').end();
        expect(names()).toHaveLength(SPANS_PER_TRACE + 2);
        root.setAttribute('bellows.poll.idle', true);
        root.end();
        expect(names()).toHaveLength(SPANS_PER_TRACE + 3);
    });

    it('forwards a trace opened past the open-trace bound', () => {
        const { tracer, names } = setup();
        const roots = Array.from({ length: OPEN_TRACES }, () => server(tracer, 'open'));
        const extra = server(tracer, 'extra');
        child(tracer, roots[0] as Span, 'held').end();
        child(tracer, extra, 'passed').end();
        expect(names()).toEqual(['passed']);
    });

    it.each(['forceFlush', 'shutdown'] as const)('%s forwards the spans an open trace buffered', async (method) => {
        const { provider, tracer, names } = setup();
        const root = server(tracer, 'open');
        child(tracer, root, 'a').end();
        expect(names()).toEqual([]);
        await provider[method]();
        expect(names()).toEqual(['a']);
    });
});
