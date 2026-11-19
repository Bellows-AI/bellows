/**
 * The driver's OTEL SDK, a copy in shape of `server/src/otel.ts` (the driver imports nothing from other packages):
 * traces for outgoing HTTP (undici, which the board client's `fetch` rides), the Meter `driver-metrics.ts` reports
 * into and the logger provider `log.ts` emits to. Exporters come from the standard `OTEL_*` environment; with no OTLP
 * endpoint configured the SDK is not started and every instrument is a no-op. `otel-register.ts` starts it before any
 * instrumented module loads. docs/telemetry.md.
 */
import { diag, DiagLogLevel } from '@opentelemetry/api';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { AggregationType } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { diagLogger } from './log.js';

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
 * What a client span may say about where it went: `scheme://host` and nothing else. A driver call to the board or
 * to GitHub carries a job id or a repository path, which no span attribute may name.
 */
export function scrubbedUrlAttributes(request: { origin?: string | URL }): Record<string, string> {
    const origin = String(request.origin ?? '');
    return {
        'url.full': origin,
        'http.url': origin,
        'url.path': '/',
        'http.target': '/',
        'url.query': '',
    };
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
        instrumentations: [new UndiciInstrumentation({ startSpanHook: scrubbedUrlAttributes })],
        views: INSTRUMENTATION_SCOPES.map((meterName) => ({
            instrumentName: '*',
            meterName,
            aggregation: { type: AggregationType.DROP },
        })),
    });
    sdk.start();
    return { shutdown: () => sdk.shutdown() };
}
