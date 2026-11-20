import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { diag, logs, metrics, trace } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startOtel } from '../src/otel.js';
import { closeOnSignal } from '../src/shutdown.js';

describe('a close failure on the shutdown path', () => {
    const exported: string[] = [];
    const collector = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            if (request.url === '/v1/logs') exported.push(Buffer.concat(chunks).toString());
            response.setHeader('content-type', 'application/json').end('{}');
        });
    });

    beforeAll(async () => {
        await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
        Object.assign(process.env, {
            OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${(collector.address() as AddressInfo).port}`,
            OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
            OTEL_METRICS_EXPORTER: 'none',
        });
    });

    afterAll(() => {
        collector.close();
        for (const api of [trace, logs, metrics, diag]) api.disable();
    });

    it('is logged before the SDK shuts down, so the record is exported', async () => {
        const otel = startOtel(process.env)!;
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
        const before = process.listeners('SIGTERM').length;
        const flushed = new Promise<void>((resolve) => {
            exit.mockImplementation(((code?: number) => {
                expect(code).toBe(1);
                resolve();
            }) as never);
        });
        closeOnSignal(
            () => Promise.reject(new Error('pool close failed')),
            () => otel.shutdown()
        );
        process.emit('SIGTERM');
        await flushed;

        const records = exported.join('');
        expect(records).toContain('close failed');
        expect(records).not.toContain('pool close failed');
        for (const signal of ['SIGTERM', 'SIGINT'] as const) {
            process.removeListener(signal, process.listeners(signal).at(-1)!);
        }
        expect(process.listeners('SIGTERM').length).toBe(before);
        exit.mockRestore();
    });
});
