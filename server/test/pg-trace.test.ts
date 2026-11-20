import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installPostgresTracing, operationOf } from '../src/pg-trace.js';
import { countOf, metricsHarness } from './helpers-metrics.js';

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
const harness = metricsHarness();
const DB_ATTRIBUTES = { 'db.system.name': 'postgresql', 'db.operation.name': 'SELECT' };

beforeAll(() => {
    trace.setGlobalTracerProvider(provider);
    installPostgresTracing(harness.meter);
});
afterAll(async () => {
    trace.disable();
    await provider.shutdown();
});

describe('operationOf', () => {
    it.each([
        ['select 1', 'SELECT'],
        ['  \n Insert into t values (1)', 'INSERT'],
        ['set local statement_timeout = 0', 'SET'],
        ['', 'QUERY'],
        ['(select 1)', 'QUERY'],
    ])('reads %j as %s', (text, expected) => {
        expect(operationOf(text)).toBe(expected);
    });

    it('reads a tagged template by its first string', () => {
        const strings = Object.assign(['update t set x = ', ''], { raw: ['update t set x = ', ''] });
        expect(operationOf(strings as unknown as TemplateStringsArray)).toBe('UPDATE');
    });
});

describe('postgres tracing', () => {
    it('ends one client span, in error, for a statement that cannot reach the database', async () => {
        exporter.reset();
        const sql = postgres('postgres://nobody:secret@127.0.0.1:1/none', { max: 1, connect_timeout: 1 });
        const id = 'order-9f1c';
        await expect(sql`select ${id}::text as token`).rejects.toBeDefined();
        await sql.end({ timeout: 1 });

        const spans = exporter.getFinishedSpans();
        expect(spans.map((s) => s.name)).toEqual(['postgres SELECT']);
        expect(spans[0]!.attributes).toEqual({ 'db.system.name': 'postgresql', 'db.operation.name': 'SELECT' });
        expect(spans[0]!.status.code).toBe(2);
        // No statement text, parameter or credential rides the span.
        expect(JSON.stringify(spans[0]!.attributes)).not.toMatch(/order-9f1c|secret|token/);
    });

    it('records db.client.operation.duration once per statement, by verb only', async () => {
        installPostgresTracing(harness.meter);
        const before = countOfSelect(await harness.points('db.client.operation.duration'));
        const sql = postgres('postgres://nobody:secret@127.0.0.1:1/none', { max: 1, connect_timeout: 1 });
        const id = 'order-9f1c';
        await expect(sql`select ${id}::text as token`).rejects.toBeDefined();
        await sql.end({ timeout: 1 });

        const collected = await harness.collect();
        const metric = collected.find((m) => m.descriptor.name === 'db.client.operation.duration')!;
        expect(metric.descriptor.unit).toBe('s');
        const points = metric.dataPoints as { attributes: object; value: { count: number } }[];
        // Only the verb labels the series, so every statement lands in one point.
        expect(points).toHaveLength(1);
        expect(points[0]!.value.count - before).toBe(1);
        expect(points[0]!.attributes).toEqual(DB_ATTRIBUTES);
        expect(JSON.stringify(points)).not.toMatch(/order-9f1c|secret|token/);
    });

    it('is installed once: a second install does not nest a second span', async () => {
        installPostgresTracing(harness.meter);
        exporter.reset();
        const sql = postgres('postgres://nobody@127.0.0.1:1/none', { max: 1, connect_timeout: 1 });
        await expect(sql`select 1`).rejects.toBeDefined();
        await sql.end({ timeout: 1 });
        expect(exporter.getFinishedSpans()).toHaveLength(1);
    });

    it('still ends the span when the query reassigns resolve after it started, as a cursor does', async () => {
        exporter.reset();
        installPostgresTracing(harness.meter);
        const before = countOfSelect(await harness.points('db.client.operation.duration'));
        const sql = postgres({ max: 0 });
        const query = sql`select 1` as unknown as {
            handler: (q: { resolve: (v: unknown) => void }) => void;
        } & Promise<unknown>;
        const delivered: unknown[] = [];
        query.handler = (q) => {
            q.resolve = (value) => delivered.push(value);
            q.resolve('row');
            q.resolve('done');
        };
        query.then(
            () => undefined,
            () => undefined
        );
        await new Promise((r) => setTimeout(r, 0));
        expect(delivered).toEqual(['row', 'done']);
        expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(['postgres SELECT']);
        // Recorded once, though resolve ran twice.
        expect(countOfSelect(await harness.points('db.client.operation.duration')) - before).toBe(1);
    });
});

const countOfSelect = (points: Awaited<ReturnType<typeof harness.points>>): number =>
    countOf(points, DB_ATTRIBUTES) ?? 0;
