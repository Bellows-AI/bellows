import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const { SERVICE_NAME, otelEnabled, startOtel } = await import('../src/otel.js');

const started = vi.spyOn(NodeSDK.prototype, 'start').mockImplementation(() => undefined);

afterEach(() => {
    started.mockClear();
});
afterAll(() => started.mockRestore());

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
        expect(started).not.toHaveBeenCalled();
    });

    it('fails the start rather than export unscrubbed URLs when the tracer provider hides its processors', () => {
        const provider = vi.spyOn(trace, 'getTracerProvider').mockReturnValue({
            getDelegate: () => ({}),
            getTracer: () => ({}),
        } as never);
        expect(() => startOtel({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318' })).toThrow(/cannot scrub URLs/);
        expect(started).toHaveBeenCalledTimes(1);
        provider.mockRestore();
    });
});
