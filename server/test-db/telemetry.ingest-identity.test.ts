import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { OrgRegistry } from '../src/orgs.js';
import { ingestRoutes } from '../src/routes/ingest.js';
import { createPostgresStore } from '../src/telemetry/store.js';
import { useTestDb } from './harness.js';

/**
 * #846 / #851: the ingest identity. Every case goes through the real OTLP route and store, so the
 * flattener, the digest and the unique index are exercised together.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb();

const T = '1760000000000000000';
const START = '1759999990000000000';

type Attr = { key: string; value: { stringValue: string } };
const attr = (key: string, stringValue: string): Attr => ({ key, value: { stringValue } });

interface PointSpec {
    session: string | null;
    extra?: Record<string, string>;
    value: string;
    start?: string;
    time?: string;
}

const pointOf = (spec: PointSpec) => ({
    attributes: [
        ...(spec.session === null ? [] : [attr('session.id', spec.session)]),
        attr('type', 'cacheRead'),
        attr('model', 'm'),
        attr('query_source', 'main'),
        ...Object.entries(spec.extra ?? {}).map(([k, v]) => attr(k, v)),
    ],
    startTimeUnixNano: spec.start ?? START,
    timeUnixNano: spec.time ?? T,
    asInt: spec.value,
});

const bodyOf = (points: PointSpec[], temporality = 1, resource: Attr[] = []) => ({
    resourceMetrics: [
        {
            resource: { attributes: resource },
            scopeMetrics: [
                {
                    metrics: [
                        {
                            name: 'claude_code.token.usage',
                            sum: { aggregationTemporality: temporality, dataPoints: points.map(pointOf) },
                        },
                    ],
                },
            ],
        },
    ],
});

describe.skipIf(!enabled)('OTLP ingest identity (#846)', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = Fastify();
        await app.register(ingestRoutes(createPostgresStore({ sql: db.sql }), {} as OrgRegistry));
    });
    afterAll(async () => {
        await app.close();
    });

    const post = async (body: unknown) => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/otlp/v1/metrics',
            headers: { 'content-type': 'application/json' },
            payload: JSON.stringify(body),
        });
        expect(res.statusCode).toBe(200);
    };
    const rowsOf = (session: string) =>
        db.sql<{ value: number; received_at: Date }[]>`
            select value, received_at from metric_point where session_id = ${session} order by value`;

    it('keeps two points that differ only in a non-allowlisted attribute', async () => {
        const session = randomUUID();
        await post(
            bodyOf([
                { session, extra: { 'agent.name': 'a' }, value: '100' },
                { session, extra: { 'agent.name': 'b' }, value: '250' },
            ])
        );
        expect((await rowsOf(session)).map((r) => r.value)).toEqual([100, 250]);
    });

    it('keeps two points that differ only in a resource attribute the allowlist drops', async () => {
        const session = randomUUID();
        await post(bodyOf([{ session, value: '100' }], 1, [attr('host.name', 'h1')]));
        await post(bodyOf([{ session, value: '250' }], 1, [attr('host.name', 'h2')]));
        expect((await rowsOf(session)).map((r) => r.value)).toEqual([100, 250]);
    });

    it('keeps two points that differ only in temporality', async () => {
        const session = randomUUID();
        await post(bodyOf([{ session, value: '100' }], 1));
        await post(bodyOf([{ session, value: '250' }], 2));
        expect((await rowsOf(session)).map((r) => r.value)).toEqual([100, 250]);
    });

    it('keeps two points that differ only in start time', async () => {
        const session = randomUUID();
        await post(
            bodyOf([
                { session, value: '100', start: START },
                { session, value: '250', start: '1759999980000000000' },
            ])
        );
        expect((await rowsOf(session)).map((r) => r.value)).toEqual([100, 250]);
    });

    it('keeps two points that differ only in agent', async () => {
        const session = randomUUID();
        await post(
            bodyOf([
                { session, extra: { agent: 'claude-code' }, value: '100' },
                { session, extra: { agent: 'opencode' }, value: '250' },
            ])
        );
        expect((await rowsOf(session)).map((r) => r.value)).toEqual([100, 250]);
    });

    it('treats an identical retry as a no-op that leaves received_at alone', async () => {
        const session = randomUUID();
        const body = bodyOf([{ session, extra: { 'agent.name': 'a' }, value: '100' }]);
        await post(body);
        const [first] = await rowsOf(session);
        await db.sql`select pg_sleep(0.05)`;
        await post(body);
        const after = await rowsOf(session);
        expect(after).toHaveLength(1);
        expect(after[0]!.received_at.getTime()).toBe(first!.received_at.getTime());
    });

    // A null session has no id to filter by, so each null-session case owns a unique timestamp.
    const uniqueTime = () => {
        const seconds = 1_761_000_000 + Math.floor(Math.random() * 1_000_000);
        return { nanos: `${seconds}000000000`, iso: new Date(seconds * 1000) };
    };
    const nullSessionRows = (iso: Date) =>
        db.sql<{ value: number }[]>`
            select value from metric_point where session_id is null and time = ${iso} order by value`;

    it('treats an identical null-session retry as a no-op', async () => {
        const { nanos, iso } = uniqueTime();
        const body = bodyOf([{ session: null, value: '100', time: nanos }]);
        await post(body);
        await post(body);
        expect((await nullSessionRows(iso)).map((r) => r.value)).toEqual([100]);
    });

    it('keeps distinct null-session series', async () => {
        const { nanos, iso } = uniqueTime();
        await post(
            bodyOf([
                { session: null, extra: { 'agent.name': 'a' }, value: '100', time: nanos },
                { session: null, extra: { 'agent.name': 'b' }, value: '250', time: nanos },
            ])
        );
        expect((await nullSessionRows(iso)).map((r) => r.value)).toEqual([100, 250]);
    });
});
