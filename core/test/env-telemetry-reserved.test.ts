import { describe, expect, it } from 'vitest';
import { isReservedEnvName } from '../src/env.js';

// The runner's telemetry export credential rides OTEL_EXPORTER_OTLP_HEADERS, set by the driver: a
// member value under any of the OTLP spec's header variables would replace or add to it.
describe('the telemetry export headers are reserved', () => {
    it.each([
        'OTEL_EXPORTER_OTLP_HEADERS',
        'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
        'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
        'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
    ])('%s', (name) => {
        expect(isReservedEnvName(name)).toBe(true);
    });
});
