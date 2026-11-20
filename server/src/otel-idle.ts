/**
 * Drops the traces of idle claim polls. A poll is counted, never traced, but whether it found work is known only when
 * its request ends, after its child spans (undici, `postgres`) already ended. So a trace whose local root is a SERVER
 * span, or carries `bellows.poll` at start, is held until that root ends: an idle root (`bellows.poll.idle`) drops the
 * whole trace, any other forwards it. Every other trace passes straight through. Bounded, never blocking; a flush or
 * shutdown forwards what is held. `server/src/otel-idle.ts` and `driver/src/otel-idle.ts` are identical copies (the
 * driver imports nothing from the server). docs/observability.md.
 */
import { SpanKind } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace';

export const ATTR_POLL = 'bellows.poll';
export const ATTR_POLL_IDLE = 'bellows.poll.idle';

const MAX_SPANS_PER_TRACE = 256;
const MAX_OPEN_TRACES = 1024;
const MAX_TOMBSTONES = 1024;

interface Deferred {
    /** The trace's open local roots: a driver poll and the board request it reached can share one process. */
    roots: Set<string>;
    spans: ReadableSpan[];
}

const isLocalRoot = (span: ReadableSpan): boolean =>
    span.parentSpanContext === undefined || span.parentSpanContext.isRemote === true;

export class DeferringSpanProcessor implements SpanProcessor {
    private readonly open = new Map<string, Deferred>();
    private readonly dropped = new Set<string>();

    constructor(private readonly inner: SpanProcessor[]) {}

    onStart(span: Span, parentContext: Context): void {
        for (const processor of this.inner) processor.onStart(span, parentContext);
        if (!isLocalRoot(span)) return;
        if (span.kind !== SpanKind.SERVER && span.attributes[ATTR_POLL] !== true) return;
        const { traceId, spanId } = span.spanContext();
        const deferred = this.open.get(traceId);
        if (deferred) deferred.roots.add(spanId);
        else if (this.open.size < MAX_OPEN_TRACES) this.open.set(traceId, { roots: new Set([spanId]), spans: [] });
    }

    onEnding(span: Span): void {
        for (const processor of this.inner) processor.onEnding?.(span);
    }

    onEnd(span: ReadableSpan): void {
        const { traceId, spanId } = span.spanContext();
        if (this.dropped.has(traceId)) return;
        const deferred = this.open.get(traceId);
        if (!deferred) {
            this.forward([span]);
            return;
        }
        if (!deferred.roots.has(spanId)) {
            deferred.spans.push(span);
            if (deferred.spans.length > MAX_SPANS_PER_TRACE) this.release(traceId, deferred);
            return;
        }
        if (span.attributes[ATTR_POLL_IDLE] === true) {
            this.open.delete(traceId);
            this.tombstone(traceId);
            return;
        }
        deferred.roots.delete(spanId);
        deferred.spans.push(span);
        if (deferred.roots.size === 0) this.release(traceId, deferred);
    }

    async forceFlush(): Promise<void> {
        this.releaseAll();
        await Promise.all(this.inner.map((processor) => processor.forceFlush()));
    }

    async shutdown(): Promise<void> {
        this.releaseAll();
        await Promise.all(this.inner.map((processor) => processor.shutdown()));
    }

    private forward(spans: ReadableSpan[]): void {
        for (const span of spans) for (const processor of this.inner) processor.onEnd(span);
    }

    /** Forwards what the trace held; the rest of it passes straight through. */
    private release(traceId: string, deferred: Deferred): void {
        this.open.delete(traceId);
        this.forward(deferred.spans);
    }

    private releaseAll(): void {
        for (const [traceId, deferred] of [...this.open]) this.release(traceId, deferred);
    }

    /** Remembers a dropped trace so a child ending after its root is dropped too. */
    private tombstone(traceId: string): void {
        this.dropped.add(traceId);
        if (this.dropped.size <= MAX_TOMBSTONES) return;
        const oldest = this.dropped.values().next().value;
        if (oldest !== undefined) this.dropped.delete(oldest);
    }
}
