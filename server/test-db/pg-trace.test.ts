import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, describe, expect, it } from 'vitest';
import { installPostgresTracing } from '../src/pg-trace.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb();
const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });

afterAll(async () => {
    trace.disable();
    await provider.shutdown();
});

describe.skipIf(!enabled)('postgres tracing against a database', () => {
    it('cuts one span per statement of a transaction, each ended OK, without altering the result', async () => {
        trace.setGlobalTracerProvider(provider);
        installPostgresTracing();
        exporter.reset();
        const rows = await db.sql.begin(async (tx) => {
            await tx`set local statement_timeout = 0`;
            return tx<{ one: number }[]>`select 1 as one`;
        });
        expect(rows).toEqual([{ one: 1 }]);
        const names = exporter.getFinishedSpans().map((s) => s.name);
        expect(names).toEqual(expect.arrayContaining(['postgres SET', 'postgres SELECT']));
        expect(exporter.getFinishedSpans().every((s) => s.status.code !== 2)).toBe(true);
    });
});
