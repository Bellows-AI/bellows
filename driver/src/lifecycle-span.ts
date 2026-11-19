/**
 * The driver's own spans: a claim poll, and one lifecycle step of an attempt. A claim span opens before the board
 * request, so the undici client span is its child and the board joins its trace by `traceparent`; it carries
 * `bellows.poll`, so an idle answer (`bellows.poll.idle`, set where the 204 is read) drops the whole trace in
 * `otel-idle.ts`. A step span is its own trace root: no span covers a task. Neither records an error's message,
 * which can name a repository. docs/observability.md.
 */
import { type Attributes, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import type { DriverConfig } from './config.js';
import { METER_NAME } from './driver-metrics.js';
import { ATTR_POLL, ATTR_POLL_IDLE } from './otel-idle.js';

export const ATTR_JOB_ID = 'bellows.job.id';
export const ATTR_CLAIM_SEQ = 'bellows.claim.seq';
export const ATTR_EXECUTOR = 'bellows.executor';

export type ClaimSpanName = 'claim' | 'reclaim.claim';

/** Where the board answered 204: the active claim span's whole trace is dropped at its end. */
export const markIdlePoll = (): void => {
    trace.getActiveSpan()?.setAttribute(ATTR_POLL_IDLE, true);
};

/** Where a claim answer failed validation: an unconfirmed read is kept, as an ERROR, never treated as idle. */
export const markUnconfirmedPoll = (): void => {
    trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR });
};

const tracer = () => trace.getTracer(METER_NAME);

/** Runs `fn` in `span`: ERROR (no message) on a throw, rethrown; ended exactly once. */
async function inSpan<T>(span: Span, fn: () => Promise<T>, done?: (value: T) => void): Promise<T> {
    try {
        const value = await fn();
        done?.(value);
        return value;
    } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw e;
    } finally {
        span.end();
    }
}

const isClaimedJob = (value: unknown): value is { id: string; claimSeq: number } =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { claimSeq?: unknown }).claimSeq === 'number';

/**
 * One claim poll: wraps only the board call, so whatever the caller does with the answer runs outside the span. A
 * claimed job names its id and this claim's sequence.
 */
export function withClaimSpan<T>(
    name: ClaimSpanName,
    executor: DriverConfig['executor'],
    poll: () => Promise<T>
): Promise<T> {
    return tracer().startActiveSpan(name, { attributes: { [ATTR_POLL]: true, [ATTR_EXECUTOR]: executor } }, (span) =>
        inSpan(span, poll, (value) => {
            if (isClaimedJob(value)) span.setAttributes({ [ATTR_JOB_ID]: value.id, [ATTR_CLAIM_SEQ]: value.claimSeq });
        })
    );
}

/** One lifecycle step, its own trace root; `fn` and any signal it reads pass through untouched. */
export function withLifecycleSpan<T>(kind: string, attributes: Attributes, fn: () => Promise<T>): Promise<T> {
    return tracer().startActiveSpan(kind, { root: true, attributes }, (span) => inSpan(span, fn));
}
