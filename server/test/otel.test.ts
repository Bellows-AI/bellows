import { describe, expect, it } from 'vitest';
import { otelEnabled, startOtel } from '../src/otel.js';

describe('otelEnabled', () => {
    it.each([
        'OTEL_EXPORTER_OTLP_ENDPOINT',
        'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
        'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
        'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    ])('is on when %s names a collector', (name) => {
        expect(otelEnabled({ [name]: 'http://collector:4318' })).toBe(true);
    });

    it('is off with no endpoint, or an empty one', () => {
        expect(otelEnabled({})).toBe(false);
        expect(otelEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: '' })).toBe(false);
    });

    it('is off when the SDK is disabled, endpoint or not', () => {
        expect(otelEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318', OTEL_SDK_DISABLED: 'true' })).toBe(
            false
        );
    });
});

describe('startOtel', () => {
    it('starts nothing without an endpoint', () => {
        expect(startOtel({})).toBeNull();
    });
});
