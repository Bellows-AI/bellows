import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ constructed: 0 }));
vi.mock('@opentelemetry/sdk-node', () => ({
    NodeSDK: class {
        constructor() {
            sdk.constructed += 1;
        }
        start() {}
        shutdown() {
            return Promise.resolve();
        }
    },
}));

const { SERVICE_NAME, otelEnabled, startOtel } = await import('../src/otel.js');

afterEach(() => {
    sdk.constructed = 0;
});

describe('the driver OTEL bootstrap', () => {
    it('names the driver service', () => {
        expect(SERVICE_NAME).toBe('bellows-driver');
    });

    it.each([{}, { OTEL_EXPORTER_OTLP_ENDPOINT: '' }, { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '' }])(
        'is off with no endpoint: %j',
        (env) => {
            expect(otelEnabled(env)).toBe(false);
        }
    );

    it.each([
        'OTEL_EXPORTER_OTLP_ENDPOINT',
        'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
        'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
        'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    ])('is on with %s', (name) => {
        expect(otelEnabled({ [name]: 'http://otel:4318' })).toBe(true);
    });

    it('is off when disabled, whatever the endpoint', () => {
        expect(otelEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318', OTEL_SDK_DISABLED: 'true' })).toBe(false);
    });

    it('starts nothing and constructs no exporter without an endpoint', () => {
        expect(startOtel({})).toBeNull();
        expect(sdk.constructed).toBe(0);
    });

    it('fails the start rather than export unscrubbed URLs when the tracer provider hides its processors', () => {
        trace.disable();
        expect(() => startOtel({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318' })).toThrow(/cannot scrub URLs/);
        expect(sdk.constructed).toBe(1);
    });
});
