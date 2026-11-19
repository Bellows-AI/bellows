import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { context, diag, logs, metrics, trace } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startOtel, type Otel } from '../src/otel.js';

interface OtlpSpan {
    kind: number;
    attributes: { key: string; value: Record<string, string | number> }[];
}

const bodyOf = (request: IncomingMessage) =>
    new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });

describe('URL scrubbing over a real SDK and loopback HTTP', () => {
    const exported: Record<string, string[]> = {};
    const collector = createServer((request, response) => {
        void bodyOf(request).then((body) => {
            exported[request.url ?? ''] = [...(exported[request.url ?? ''] ?? []), body];
            response.setHeader('content-type', 'application/json').end('{}');
        });
    });
    const github = createServer((_request, response) => response.end('[]'));
    let otel: Otel;
    let githubUrl: string;

    beforeAll(async () => {
        await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
        await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve));
        githubUrl = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
        Object.assign(process.env, {
            OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${(collector.address() as AddressInfo).port}`,
            OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
            OTEL_METRICS_EXPORTER: 'none',
        });
        otel = startOtel(process.env)!;
    });

    afterAll(() => {
        collector.close();
        github.close();
        for (const api of [trace, logs, metrics, context, diag]) api.disable();
    });

    it('exports client spans with scheme://host only: no path, no query, no secret', async () => {
        await fetch(`${githubUrl}/repos/o-x/n-x/pulls?token=tok_x`);
        await otel.shutdown();
        const spans = (exported['/v1/traces'] ?? []).flatMap((body) =>
            (JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] }).resourceSpans.flatMap(
                (r) => r.scopeSpans.flatMap((s) => s.spans)
            )
        );
        const attr = (span: OtlpSpan, key: string) =>
            String(Object.values(span.attributes.find((a) => a.key === key)?.value ?? {})[0] ?? '') || undefined;
        const client = spans.find((s) => attr(s, 'url.full') === githubUrl);
        expect(client).toBeDefined();
        expect(attr(client!, 'http.url')).toBe(githubUrl);
        for (const key of ['url.path', 'url.query', 'http.target']) expect(attr(client!, key)).toBeUndefined();
        for (const secret of ['tok_x', 'o-x', 'n-x']) expect(JSON.stringify(spans)).not.toContain(secret);
    });
});
