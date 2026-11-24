/**
 * What a span may say about a URL. Paths and queries carry credentials (OAuth `?code=`, the attachment capability in
 * its PUT path) and repo names (`/api/repos/<id>/branches`), so neither leaves the board: a SERVER span
 * keeps the route pattern, a CLIENT span keeps `scheme://host`. docs/observability.md.
 */
import { SpanKind, trace } from '@opentelemetry/api';
import type { Context, Span } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace';
import type { FastifyInstance } from 'fastify';
import { UNMATCHED_ROUTE } from './log.js';

export const ATTR_URL_FULL = 'url.full';
export const ATTR_URL_PATH = 'url.path';
export const ATTR_URL_QUERY = 'url.query';
export const ATTR_HTTP_TARGET = 'http.target';
export const ATTR_HTTP_URL = 'http.url';
export const ATTR_HTTP_ROUTE = 'http.route';

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
        const { attributes, kind } = span as unknown as ReadableSpan & { attributes: Record<string, unknown> };
        const origin = originOf(attributes[ATTR_URL_FULL] ?? attributes[ATTR_HTTP_URL]);
        for (const name of URL_ATTRIBUTES) delete attributes[name];
        if (origin !== null) {
            span.setAttribute(ATTR_URL_FULL, origin);
            span.setAttribute(ATTR_HTTP_URL, origin);
        }
        // Until the `onRequest` hook names the route a server span names none: a request Fastify rejects before
        // that hook (a malformed percent-encoding) never carries its concrete path.
        if (kind === SpanKind.SERVER) {
            span.setAttribute(ATTR_URL_PATH, UNMATCHED_ROUTE);
            span.setAttribute(ATTR_HTTP_TARGET, UNMATCHED_ROUTE);
        }
    }
    onEnd(_span: ReadableSpan, _context?: Context): void {}
    forceFlush(): Promise<void> {
        return Promise.resolve();
    }
    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}

/**
 * Before every route: the active server span names the route pattern, never the concrete path — ids, repo names and
 * capability tokens ride in the path. An unmatched request is named `<unmatched>`.
 */
export function registerRouteSpanHook(app: FastifyInstance): void {
    app.addHook('onRequest', async (request) => {
        const route = request.is404 ? UNMATCHED_ROUTE : (request.routeOptions.url ?? UNMATCHED_ROUTE);
        trace
            .getActiveSpan()
            ?.setAttributes({ [ATTR_HTTP_ROUTE]: route, [ATTR_URL_PATH]: route, [ATTR_HTTP_TARGET]: route });
    });
}
