/**
 * What a span may say about a URL: a CLIENT span keeps `scheme://host` and nothing else. The driver's calls carry job
 * ids and repository paths (the board's `credentials/github`, GitHub publish), and a query may carry a credential.
 * A copy of the client half of `server/src/otel-scrub.ts` (the driver has no server spans). docs/observability.md.
 */
import type { Span } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace';

export const ATTR_URL_FULL = 'url.full';
export const ATTR_URL_PATH = 'url.path';
export const ATTR_URL_QUERY = 'url.query';
export const ATTR_HTTP_TARGET = 'http.target';
export const ATTR_HTTP_URL = 'http.url';

const URL_ATTRIBUTES = [ATTR_URL_FULL, ATTR_URL_PATH, ATTR_URL_QUERY, ATTR_HTTP_TARGET, ATTR_HTTP_URL];

const originOf = (value: unknown): string | null => {
    try {
        const { protocol, host } = new URL(String(value));
        return `${protocol}//${host}`;
    } catch {
        return null;
    }
};

/** Rewrites the URL attributes of a span as it starts, before any exporter can read them. */
export class UrlScrubProcessor implements SpanProcessor {
    onStart(span: Span): void {
        const { attributes } = span as unknown as ReadableSpan & { attributes: Record<string, unknown> };
        const origin = originOf(attributes[ATTR_URL_FULL] ?? attributes[ATTR_HTTP_URL]);
        for (const name of URL_ATTRIBUTES) delete attributes[name];
        if (origin !== null) {
            span.setAttribute(ATTR_URL_FULL, origin);
            span.setAttribute(ATTR_HTTP_URL, origin);
        }
    }
    onEnd(): void {}
    forceFlush(): Promise<void> {
        return Promise.resolve();
    }
    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}
