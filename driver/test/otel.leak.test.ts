import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { trace } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import { startOtel } from '../src/otel.js';

const ENV = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1', OTEL_METRICS_EXPORTER: 'none' };

/** `isolate: false` shares one process-global `diagnostics_channel` between files, so a failed start must leave nothing subscribed. */
describe('the OTEL bootstrap when the start fails', () => {
    it('leaves no undici instrumentation behind to break a later fetch', async () => {
        const server = createServer((_request, response) => response.end('ok'));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const start = vi.spyOn(NodeSDK.prototype, 'start').mockImplementation(() => undefined);
        const provider = vi.spyOn(trace, 'getTracerProvider').mockReturnValue({
            getDelegate: () => ({}),
            getTracer: () => ({}),
        } as never);
        try {
            expect(() => startOtel(ENV)).toThrow(/cannot scrub URLs/);
            provider.mockRestore();
            start.mockRestore();
            const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            await expect((await fetch(url)).text()).resolves.toBe('ok');
        } finally {
            server.close();
        }
    });
});
