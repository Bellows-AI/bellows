import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, diag, logs, metrics, type ProxyTracerProvider, trace } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBoard } from '../../driver/src/board/board.js';
import { withClaimSpan } from '../../driver/src/lifecycle-span.js';
import { buildApp } from '../src/app.js';
import { createAuthStore } from '../src/auth/store.js';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import { createOrgOfJob, createOrgOfLease, createOrgOfReclaim } from '../src/db/jobs/job-store-org-resolvers.js';
import { createServerMetrics } from '../src/metrics.js';
import { createOrgRegistry } from '../src/orgs.js';
import { startOtel } from '../src/otel.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { metricsHarness } from '../test/helpers-metrics.js';
import { githubAuth, testConfig, TEST_DRIVER_CREDENTIAL, testDriverCredentials } from '../test/helpers-config.js';
import { seedEncryptedRow, testSecretStore } from './env-secrets-harness.js';
import { account, craftJob, legacyConnection, randomGithubId, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The issue's join and scan, in one process: the driver's real board client, called inside the driver's claim span,
 * against the real board app and store on a migrated `_test` database. The driver claim span, its undici client span,
 * the board server span and the board's `claim.*` spans share one trace id, and no exported span carries the job's
 * repository, branch, prompt, a personal token value or a user's email.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });
const LEASE_S = 300;
const SPAN_KIND_SERVER = 2;
const SPAN_KIND_CLIENT = 3;

const REPO = 'o-zq/n-zq';
const BRANCH = 'b-zq';
const PROMPT = 'p-zq';
const TOKEN = 't-zq';
const EMAIL = 'e@zq.example';
const FIXTURE_VALUES = [REPO, BRANCH, PROMPT, TOKEN, EMAIL];

type OtlpAttribute = { key: string; value: Record<string, unknown> };

interface OtlpSpan {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    kind: number;
    name: string;
    status?: { code?: number; message?: string };
    attributes: OtlpAttribute[];
    events?: { name: string; attributes?: OtlpAttribute[] }[];
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

/** Every string a span exports: its name, attribute values, event names and attributes, and status message. */
const exportedText = (span: OtlpSpan): string[] => {
    const values = (attributes: OtlpAttribute[] = []) => attributes.map((a) => JSON.stringify(a.value));
    return [
        span.name,
        ...values(span.attributes),
        ...(span.events ?? []).flatMap((e) => [e.name, ...values(e.attributes)]),
        span.status?.message ?? '',
    ];
};

let app: FastifyInstance;
let boardUrl: string;
let secrets: SecretStore;

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
    secrets = testSecretStore(sql);
    const serverMetrics = createServerMetrics({
        admission: {},
        occupancy: async () => ({ global: 0, orgMax: 0, repoMax: 0 }),
        meter: metricsHarness().meter,
    });
    app = await buildApp({
        config,
        orgs: createOrgRegistry({
            sql,
            ready,
            config,
            withStores: true,
            claimMetrics: serverMetrics.claim,
            secrets,
            secretLog: () => {},
            artifacts: {
                objects: createFilesystemStore(mkdtempSync(join(tmpdir(), 'otel-join-store-'))),
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

describe.skipIf(!enabled)('driver and board claim spans', () => {
    it('share one trace id, and no span names the repository, branch, prompt, a token or an email', async () => {
        const sql = db.sql;
        const author = await account(sql, randomGithubId(), 'otel-join');
        await legacyConnection(sql, ORG, author, { email: EMAIL });
        await seedEncryptedRow(
            sql,
            secrets,
            { orgId: ORG, scope: { kind: 'workspace', userId: author }, name: 'PERSONAL_TOKEN' },
            TOKEN
        );
        const id = await craftJob({ sql, org: ORG, author }, { repo: REPO, command: PROMPT });
        await sql`update job set base_branch = ${BRANCH} where id = ${id}`;
        const board = createBoard({ url: boardUrl, leaseSeconds: LEASE_S, credential: () => TEST_DRIVER_CREDENTIAL });

        const claimed = await withClaimSpan('claim', 'docker', () => board.claim('otel-join-driver'));
        expect(claimed?.id).toBe(id);
        // The fixture reached the claim, so its absence from the spans below is the scrub, not a missing value.
        expect(claimed?.command).toBe(PROMPT);
        expect(claimed?.repo).toBe(REPO);
        expect(claimed?.baseBranch).toBe(BRANCH);
        expect(claimed?.env).toMatchObject({ PERSONAL_TOKEN: TOKEN });

        const all = await exportedSpans();
        const driverClaims = all.filter((s) => s.name === 'claim');
        expect(driverClaims, 'the driver claim span').toHaveLength(1);
        const driverClaim = driverClaims[0]!;
        const spans = all.filter((s) => s.traceId === driverClaim.traceId);
        const clients = spans.filter((s) => s.kind === SPAN_KIND_CLIENT && s.parentSpanId === driverClaim.spanId);
        expect(clients, 'the undici client span').toHaveLength(1);
        const servers = spans.filter((s) => s.kind === SPAN_KIND_SERVER);
        expect(servers, 'the board server span').toHaveLength(1);
        expect(servers[0]!.parentSpanId).toBe(clients[0]!.spanId);
        for (const name of ['claim.sweep', 'claim.acquire', 'claim.lock_wait']) {
            expect(
                spans.filter((s) => s.name === name),
                name
            ).toHaveLength(1);
        }

        for (const span of all) {
            const text = exportedText(span);
            for (const value of FIXTURE_VALUES) {
                expect(
                    text.filter((t) => t.includes(value)),
                    `${span.name} carries ${value}`
                ).toEqual([]);
            }
        }
    });
});
