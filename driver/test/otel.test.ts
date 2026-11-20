import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

    it('leaves no undici instrumentation behind when the start fails', async () => {
        const provider = vi.spyOn(trace, 'getTracerProvider').mockReturnValue({
            getDelegate: () => ({}),
            getTracer: () => ({}),
        } as never);
        expect(() => startOtel({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318' })).toThrow(/cannot scrub URLs/);
        provider.mockRestore();
        const thrown: unknown[] = [];
        const record = (error: unknown) => thrown.push(error);
        process.on('uncaughtException', record);
        const server = createServer((_req, res) => res.end('ok')).listen(0, '127.0.0.1');
        try {
            await new Promise((resolve) => server.once('listening', resolve));
            const { port } = server.address() as AddressInfo;
            const res = await fetch(`http://127.0.0.1:${port}/`);
            expect(await res.text()).toBe('ok');
        } finally {
            server.close();
            process.off('uncaughtException', record);
        }
        expect(thrown).toEqual([]);
    });
});
