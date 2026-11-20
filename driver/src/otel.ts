/**
 * The driver's OTEL SDK, a copy in shape of `server/src/otel.ts` (the driver imports nothing from other packages):
 * traces for outgoing HTTP (undici, which the board client's `fetch` rides), the Meter `driver-metrics.ts` reports
 * into and the logger provider `log.ts` emits to. Exporters come from the standard `OTEL_*` environment; with no OTLP
 * endpoint configured the SDK is not started and every instrument is a no-op. `otel-register.ts` starts it before any
 * instrumented module loads. docs/telemetry.md.
 */
import { diag, DiagLogLevel, trace } from '@opentelemetry/api';
import type { ProxyTracerProvider } from '@opentelemetry/api';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { AggregationType } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { SpanProcessor } from '@opentelemetry/sdk-trace';
import { diagLogger } from './log.js';
import { DeferringSpanProcessor } from './otel-idle.js';
import { UrlScrubProcessor } from './otel-scrub.js';

export const SERVICE_NAME = 'bellows-driver';

const ENDPOINT_VARS = [
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
    'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
    'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
] as const;

/** The instrumentation's own metrics carry host and peer attributes outside the driver's closed vocabulary. */
const INSTRUMENTATION_SCOPES = ['@opentelemetry/instrumentation-undici'];

export const otelEnabled = (env: NodeJS.ProcessEnv): boolean =>
    env.OTEL_SDK_DISABLED !== 'true' && ENDPOINT_VARS.some((name) => (env[name] ?? '') !== '');

/**
 * `NodeSDK` builds the exporters' span processors from the environment only when it is given none, so the scrubber
 * and the idle-poll deferral cannot be passed in beside them: the provider's own list is rewritten in place to the
 * scrubber, then the deferral wrapping the exporters. A provider that no longer has that list fails the start rather
 * than export unscrubbed URLs.
 */
function installSpanProcessors(): void {
    const provider = (trace.getTracerProvider() as ProxyTracerProvider).getDelegate() as unknown as {
        _activeSpanProcessor?: { _spanProcessors?: SpanProcessor[] };
    };
    const processors = provider._activeSpanProcessor?._spanProcessors;
    if (!processors) throw new Error('the tracer provider no longer exposes its span processors: cannot scrub URLs');
    const exporters = [...processors];
    processors.splice(0, processors.length, new UrlScrubProcessor(), new DeferringSpanProcessor(exporters));
}

export interface Otel {
    /** Flushes what is buffered and stops the exporters. */
    shutdown(): Promise<void>;
}

/** Starts the SDK, or returns null when no OTLP endpoint is configured. */
export function startOtel(env: NodeJS.ProcessEnv = process.env): Otel | null {
    if (!otelEnabled(env)) return null;
    diag.setLogger(diagLogger(), DiagLogLevel.WARN);
    const sdk = new NodeSDK({
        serviceName: env.OTEL_SERVICE_NAME ?? SERVICE_NAME,
        instrumentations: [new UndiciInstrumentation()],
        views: INSTRUMENTATION_SCOPES.map((meterName) => ({
            instrumentName: '*',
            meterName,
            aggregation: { type: AggregationType.DROP },
        })),
    });
    sdk.start();
    installSpanProcessors();
    return { shutdown: () => sdk.shutdown() };
}
