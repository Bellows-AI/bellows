/**
 * The board's OTEL SDK: traces for incoming HTTP, outgoing HTTP (undici, which `fetch` rides) and Postgres, the
 * Meter `server/src/metrics.ts` reports into, and the LoggerProvider `log.ts` writes to. Exporters come from the standard `OTEL_*` environment; with no OTLP
 * endpoint configured the SDK is not started and every instrument is a no-op. `otel-register.ts` starts it before any
 * instrumented module loads. docs/telemetry.md, docs/observability.md.
 */
import { diag, DiagLogLevel, trace } from '@opentelemetry/api';
import type { ProxyTracerProvider } from '@opentelemetry/api';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { AggregationType } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { SpanProcessor } from '@opentelemetry/sdk-trace';
import pino from 'pino';
import { UrlScrubProcessor } from './otel-scrub.js';
import { installPostgresTracing } from './pg-trace.js';

export const SERVICE_NAME = 'bellows-board';

const ENDPOINT_VARS = [
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
    'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
    'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
] as const;

const DIAG_INTERVAL_MS = 60_000;

/** The instrumentations' own metrics carry host and peer attributes outside the board's closed vocabulary. */
const INSTRUMENTATION_SCOPES = ['@opentelemetry/instrumentation-http', '@opentelemetry/instrumentation-undici'];

export const otelEnabled = (env: NodeJS.ProcessEnv): boolean =>
    env.OTEL_SDK_DISABLED !== 'true' && ENDPOINT_VARS.some((name) => (env[name] ?? '') !== '');

/**
 * The SDK's own warnings and errors (an unreachable collector, a dropped batch) go to stdout only — never through the
 * LoggerProvider, which would export the export failure — and at most one line a minute: a dead collector must not
 * become a log flood.
 */
function stdoutDiagLogger() {
    const out = pino({ base: { component: 'otel' } }, pino.destination(1));
    let last = Number.NEGATIVE_INFINITY;
    const write = (level: 'warn' | 'error') => (message: string) => {
        const now = Date.now();
        if (now - last < DIAG_INTERVAL_MS) return;
        last = now;
        out[level](message);
    };
    const quiet = () => {};
    return { error: write('error'), warn: write('warn'), info: quiet, debug: quiet, verbose: quiet };
}

/**
 * `NodeSDK` builds the exporters' span processors from the environment only when it is given none, so the scrubber
 * cannot be passed in beside them: it joins the provider's own list instead, ahead of the exporters. A provider that
 * no longer has that list fails the start rather than export unscrubbed URLs.
 */
function installUrlScrubber(): void {
    const provider = (trace.getTracerProvider() as ProxyTracerProvider).getDelegate() as unknown as {
        _activeSpanProcessor?: { _spanProcessors?: SpanProcessor[] };
    };
    const processors = provider._activeSpanProcessor?._spanProcessors;
    if (!processors) throw new Error('the tracer provider no longer exposes its span processors: cannot scrub URLs');
    processors.unshift(new UrlScrubProcessor());
}

export interface Otel {
    /** Flushes what is buffered and stops the exporters. */
    shutdown(): Promise<void>;
}

/** Starts the SDK, or returns null when no OTLP endpoint is configured. */
export function startOtel(env: NodeJS.ProcessEnv = process.env): Otel | null {
    if (!otelEnabled(env)) return null;
    diag.setLogger(stdoutDiagLogger(), DiagLogLevel.WARN);
    const sdk = new NodeSDK({
        serviceName: env.OTEL_SERVICE_NAME ?? SERVICE_NAME,
        instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
        views: INSTRUMENTATION_SCOPES.map((meterName) => ({
            instrumentName: '*',
            meterName,
            aggregation: { type: AggregationType.DROP },
        })),
    });
    sdk.start();
    installUrlScrubber();
    installPostgresTracing();
    return { shutdown: () => sdk.shutdown() };
}
