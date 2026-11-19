/**
 * The board's own spans: the claim transaction's steps and one pass of a background loop, plus the marks a claim
 * route leaves on its server span. An idle claim (`bellows.poll.idle`, set before the 204) drops its whole trace in
 * `otel-idle.ts`; a claimed one names the job and this claim's sequence. A span never records an error's message,
 * which can name a repository. docs/observability.md.
 */
import { type Attributes, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { ATTR_POLL_IDLE } from './otel-idle.js';

/** The instrumentation scope of the board's own spans and instruments. */
export const BOARD_SCOPE = 'bellows-board';

export const ATTR_JOB_ID = 'bellows.job.id';
export const ATTR_CLAIM_SEQ = 'bellows.claim.seq';

const tracer = () => trace.getTracer(BOARD_SCOPE);

/** Where a claim route answers 204: the active server span's whole trace is dropped at its end. */
export const markIdlePoll = (): void => {
    trace.getActiveSpan()?.setAttribute(ATTR_POLL_IDLE, true);
};

/** Where a claim route answers a job: the active server span names it and this claim's sequence. */
export const markClaimed = (job: { id: string; claimSeq: number }): void => {
    trace.getActiveSpan()?.setAttributes({ [ATTR_JOB_ID]: job.id, [ATTR_CLAIM_SEQ]: job.claimSeq });
};

/**
 * Runs `fn` in an active span, so the `postgres` spans it issues nest under it: ERROR (no message) on a throw,
 * rethrown; ended exactly once. `root` starts a trace of its own.
 */
export function inBoardSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options: { attributes?: Attributes; root?: boolean } = {}
): Promise<T> {
    return tracer().startActiveSpan(name, options, async (span) => {
        try {
            return await fn(span);
        } catch (e) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw e;
        } finally {
            span.end();
        }
    });
}
