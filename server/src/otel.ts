/**
 * The board's OTEL SDK: traces for incoming HTTP, outgoing HTTP (undici, which `fetch` rides) and Postgres, and the
 * Meter `server/src/metrics.ts` reports into. Exporters come from the standard `OTEL_*` environment; with no OTLP
 * endpoint configured the SDK is not started and every instrument is a no-op. `otel-register.ts` starts it before any
 * instrumented module loads. docs/telemetry.md.
 */
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { AggregationType } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { installPostgresTracing } from './pg-trace.js';

export const SERVICE_NAME = 'bellows-board';

const ENDPOINT_VARS = [
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
    'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
] as const;

/** The instrumentations' own metrics carry host and peer attributes outside the board's closed vocabulary. */
const INSTRUMENTATION_SCOPES = ['@opentelemetry/instrumentation-http', '@opentelemetry/instrumentation-undici'];

export const otelEnabled = (env: NodeJS.ProcessEnv): boolean =>
    env.OTEL_SDK_DISABLED !== 'true' && ENDPOINT_VARS.some((name) => (env[name] ?? '') !== '');

export interface Otel {
    /** Flushes what is buffered and stops the exporters. */
    shutdown(): Promise<void>;
}

/** Starts the SDK, or returns null when no OTLP endpoint is configured. */
export function startOtel(env: NodeJS.ProcessEnv = process.env): Otel | null {
    if (!otelEnabled(env)) return null;
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
    installPostgresTracing();
    return { shutdown: () => sdk.shutdown() };
}
