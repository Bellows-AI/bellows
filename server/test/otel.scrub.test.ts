import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { context, diag, logs, metrics, trace } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { startOtel, type Otel } from '../src/otel.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import { root } from '../src/log.js';
import { staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';

const SPAN_KIND_SERVER = 2;
const CAPABILITY = 'cap_x';
const SECRETS = ['tok_x', 'o-x', 'n-x', CAPABILITY];

interface OtlpSpan {
    kind: number;
    name: string;
    attributes: { key: string; value: Record<string, string | number> }[];
}

const bodyOf = (request: IncomingMessage) =>
    new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });

const listen = (server: Server) =>
    new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
    );

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
    let board: Awaited<ReturnType<typeof buildApp>>;
    let boardUrl: string;
    let githubUrl: string;
    let githubPort: string;

    beforeAll(async () => {
        const collectorPort = await listen(collector);
        githubPort = String(await listen(github));
        githubUrl = `http://127.0.0.1:${githubPort}`;
        Object.assign(process.env, {
            OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collectorPort}`,
            OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
            OTEL_METRICS_EXPORTER: 'none',
        });
        otel = startOtel(process.env)!;
        // The http instrumentation patches `http` on its first require after it is enabled.
        createRequire(import.meta.url)('http');
        const config = testConfig();
        board = await buildApp({
            config,
            orgs: staticRegistry({
                config,
                telemetry: stubTelemetryClient(),
                repos: staticRepoSource([{ owner: 'o-x', name: 'n-x' }]),
            }),
            loggerInstance: root,
        });
        boardUrl = await board.listen({ port: 0, host: '127.0.0.1' });
    });

    afterAll(async () => {
        await board.close();
        collector.close();
        github.close();
        for (const api of [trace, logs, metrics, context, diag]) api.disable();
    });

    it('exports server spans with the route pattern, client spans with scheme://host, and no secret anywhere', async () => {
        await fetch(`${boardUrl}/api/repos/o-x/n-x/branches?t=tok_x`);
        await fetch(`${boardUrl}/api/attachments/uploads/${CAPABILITY}`, { method: 'PUT', body: 'x' });
        await fetch(`${boardUrl}/api/repos/o-x/%ZZ/branches`);
        await fetch(`${githubUrl}/repos/o-x/n-x/pulls?x=1`);
        await otel.shutdown();

        const spans = (exported['/v1/traces'] ?? []).flatMap((body) =>
            (JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] }).resourceSpans.flatMap(
                (r) => r.scopeSpans.flatMap((s) => s.spans)
            )
        );
        const attr = (span: OtlpSpan, key: string) =>
            String(Object.values(span.attributes.find((a) => a.key === key)?.value ?? {})[0] ?? '') || undefined;
        // The stand-in GitHub is a bare node server in this process, so its own server span has no route to name.
        const board = spans.filter((s) => !(s.kind === SPAN_KIND_SERVER && attr(s, 'server.port') === githubPort));
        const everything = JSON.stringify(board) + (exported['/v1/logs'] ?? []).join('');
        for (const secret of SECRETS) expect(everything).not.toContain(secret);

        const server = spans.find(
            (s) => s.kind === SPAN_KIND_SERVER && attr(s, 'http.route') === '/api/repos/:owner/:name/branches'
        );
        expect(server).toBeDefined();
        expect(attr(server!, 'url.path')).toBe('/api/repos/:owner/:name/branches');
        expect(attr(server!, 'http.target')).toBe('/api/repos/:owner/:name/branches');
        expect(attr(server!, 'url.query')).toBeUndefined();
        const rejected = spans.filter(
            (s) => s.kind === SPAN_KIND_SERVER && attr(s, 'http.response.status_code') === '400'
        );
        expect(rejected.length).toBeGreaterThan(0);
        for (const span of rejected) expect(attr(span, 'url.path')).toBe('<unmatched>');
        const client = spans.find((s) => attr(s, 'url.full') === githubUrl);
        expect(client).toBeDefined();
        expect(attr(client!, 'url.path')).toBeUndefined();
        expect(attr(client!, 'url.query')).toBeUndefined();
    });
});
