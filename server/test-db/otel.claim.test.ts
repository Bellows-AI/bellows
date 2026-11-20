import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, diag, logs, metrics, type ProxyTracerProvider, trace } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createAuthStore } from '../src/auth/store.js';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import { createOrgOfJob, createOrgOfLease, createOrgOfReclaim } from '../src/db/jobs/job-store-org-resolvers.js';
import { createServerMetrics, type ServerMetrics } from '../src/metrics.js';
import { createOrgRegistry } from '../src/orgs.js';
import { startOtel } from '../src/otel.js';
import { countOf, metricsHarness, type MetricsHarness } from '../test/helpers-metrics.js';
import { githubAuth, testConfig, TEST_DRIVER_CREDENTIAL, testDriverCredentials } from '../test/helpers-config.js';
import { testSecretStore } from './env-secrets-harness.js';
import { craftJob, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The board's claim spans over the real SDK, app and store on a migrated `_test` database: a claim that acquires a
 * row joins the incoming `traceparent` and exports its sweep, acquisition and lock wait with the `postgres` spans
 * under them; an idle claim — job or reclaim — exports nothing and is counted; a background pass is its own root.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });
const LEASE_S = 300;
const SPAN_KIND_SERVER = 2;
const STATUS_ERROR = 2;

interface OtlpSpan {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    kind: number;
    name: string;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    status?: { code?: number };
    attributes: { key: string; value: Record<string, string | number | boolean> }[];
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

const traceBodies: string[] = [];
const collector = createServer((request, response) => {
    void bodyOf(request).then((body) => {
        if (request.url === '/v1/traces') traceBodies.push(body);
        response.setHeader('content-type', 'application/json').end('{}');
    });
});

/** Every span exported so far, after the SDK forwarded what it buffers (a response's server span ends after it). */
async function exportedSpans(): Promise<OtlpSpan[]> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const provider = (trace.getTracerProvider() as ProxyTracerProvider).getDelegate() as unknown as {
        forceFlush(): Promise<void>;
    };
    await provider.forceFlush();
    return traceBodies.flatMap((body) =>
        (JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] }).resourceSpans.flatMap((r) =>
            r.scopeSpans.flatMap((s) => s.spans)
        )
    );
}

const attr = (span: OtlpSpan, key: string) => Object.values(span.attributes.find((a) => a.key === key)?.value ?? {})[0];

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

/**
 * A claim POST under a fresh remote caller context. The undici instrumentation adds its own `traceparent` (a second
 * hand-written one would make the header invalid), so the request's client span is the caller's child and the board's
 * server span is that client span's child. Returns the answer and every span exported in that trace: in one process the
 * caller client span is held, and dropped, with an idle board trace.
 */
async function claimOver(path: string) {
    const traceId = hex(16);
    const callerSpanId = hex(8);
    const caller = trace.setSpanContext(context.active(), {
        traceId,
        spanId: callerSpanId,
        traceFlags: 1,
        isRemote: true,
    });
    const response = await context.with(caller, () =>
        fetch(`${boardUrl}${path}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${TEST_DRIVER_CREDENTIAL}`, 'content-type': 'application/json' },
            body: JSON.stringify({ worker: 'otel-claimer', leaseSeconds: LEASE_S }),
        })
    );
    const body = response.status === 200 ? ((await response.json()) as { id: string; claimSeq: number }) : null;
    const spans = (await exportedSpans()).filter((s) => s.traceId === traceId);
    return { status: response.status, body, callerSpanId, spans };
}

let app: FastifyInstance;
let boardUrl: string;
let harness: MetricsHarness;
let serverMetrics: ServerMetrics;

beforeAll(async () => {
    if (!enabled) return;
    const collectorPort = await listen(collector);
    Object.assign(process.env, {
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collectorPort}`,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_METRICS_EXPORTER: 'none',
    });
    startOtel(process.env);
    // The http instrumentation patches `http` on its first require after it is enabled.
    createRequire(import.meta.url)('http');
});

beforeEach(async () => {
    if (!enabled) return;
    const sql = db.sql;
    const ready = Promise.resolve();
    const config = testConfig({ auth: githubAuth() });
    harness = metricsHarness();
    serverMetrics = createServerMetrics({
        admission: {},
        occupancy: async () => ({ global: 0, orgMax: 0, repoMax: 0 }),
        meter: harness.meter,
    });
    app = await buildApp({
        config,
        orgs: createOrgRegistry({
            sql,
            ready,
            config,
            withStores: true,
            claimMetrics: serverMetrics.claim,
            secrets: testSecretStore(sql),
            secretLog: () => {},
            artifacts: {
                objects: createFilesystemStore(mkdtempSync(join(tmpdir(), 'otel-claim-store-'))),
                prefix: '',
                prepare: async () => '',
            },
        }),
        auth: createAuthStore({ sql }),
        orgOfLease: createOrgOfLease({ sql, ready }),
        orgOfJob: createOrgOfJob({ sql, ready }),
        orgOfReclaim: createOrgOfReclaim({ sql, ready }),
        driverCredentials: testDriverCredentials,
        metrics: serverMetrics,
        ready,
        version: '0.0.0',
    });
    boardUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
    if (enabled) await app?.close();
});

afterAll(() => {
    collector.close();
    for (const api of [trace, logs, metrics, context, diag]) api.disable();
});

describe.skipIf(!enabled)('board claim spans', () => {
    it('a claim that acquires a row joins the caller trace with its sweep, acquisition and lock wait', async () => {
        const id = await craftJob({ sql: db.sql, org: ORG, author: '' }, { author: null });

        const claim = await claimOver('/api/jobs/claim');
        expect(claim.status).toBe(200);
        expect(claim.body?.id).toBe(id);

        const client = claim.spans.filter((s) => s.parentSpanId === claim.callerSpanId);
        expect(client, 'the caller client span').toHaveLength(1);
        const spans = claim.spans.filter((s) => s !== client[0]);
        const named = (name: string) => {
            const found = spans.filter((s) => s.name === name);
            expect(found, name).toHaveLength(1);
            return found[0]!;
        };
        const servers = spans.filter((s) => s.kind === SPAN_KIND_SERVER);
        expect(servers).toHaveLength(1);
        const server = servers[0]!;
        expect(server.parentSpanId).toBe(client[0]!.spanId);
        expect(attr(server, 'bellows.job.id')).toBe(id);
        expect(Number(attr(server, 'bellows.claim.seq'))).toBe(claim.body?.claimSeq);
        const sweep = named('claim.sweep');
        const acquire = named('claim.acquire');
        const lockWait = named('claim.lock_wait');
        expect(sweep.parentSpanId).toBe(server.spanId);
        expect(acquire.parentSpanId).toBe(server.spanId);
        expect(lockWait.parentSpanId).toBe(acquire.spanId);
        for (const parent of [sweep, acquire, lockWait]) {
            expect(BigInt(parent.endTimeUnixNano) > BigInt(parent.startTimeUnixNano), parent.name).toBe(true);
            const children = spans.filter((s) => s.parentSpanId === parent.spanId && s.name.startsWith('postgres '));
            expect(children.length, parent.name).toBeGreaterThan(0);
        }
        expect(countOf(await harness.points('bellows.claim.polls'), { outcome: 'claimed' })).toBe(1);
    });

    it('a claim that finds nothing exports no span and is counted idle', async () => {
        const claim = await claimOver('/api/jobs/claim');
        expect(claim.status).toBe(204);

        expect(claim.spans).toEqual([]);
        expect(countOf(await harness.points('bellows.claim.polls'), { outcome: 'idle' })).toBe(1);
    });

    it('an empty reclaim claim exports no span', async () => {
        const claim = await claimOver('/api/reclaims/claim');
        expect(claim.status).toBe(204);

        expect(claim.spans).toEqual([]);
    });

    it('a background pass is its own root span, ERROR when it throws', async () => {
        const outer = trace.getTracer('test');
        await outer.startActiveSpan('outer', async (span) => {
            await serverMetrics.timedPass('otel-pass-ok', async () => undefined);
            await expect(
                serverMetrics.timedPass('otel-pass-error', async () => {
                    throw new Error('pass failed');
                })
            ).rejects.toThrow('pass failed');
            span.end();
        });

        const passes = (await exportedSpans()).filter((s) => s.name === 'background.pass');
        const ok = passes.filter((s) => attr(s, 'loop') === 'otel-pass-ok');
        const failed = passes.filter((s) => attr(s, 'loop') === 'otel-pass-error');
        expect(ok).toHaveLength(1);
        expect(failed).toHaveLength(1);
        for (const pass of [...ok, ...failed]) expect(pass.parentSpanId ?? '').toBe('');
        expect(attr(ok[0]!, 'bellows.pass.outcome')).toBe('ok');
        expect(ok[0]!.status?.code ?? 0).not.toBe(STATUS_ERROR);
        expect(attr(failed[0]!, 'bellows.pass.outcome')).toBe('error');
        expect(failed[0]!.status?.code).toBe(STATUS_ERROR);
    });
});
