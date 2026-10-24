import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { useTestDb } from './harness.js';

/** #846: 086 on a board that already holds exact duplicates under the widened key. */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb();
const MIGRATION = readFileSync(new URL('../migrations/086_metric_point_identity.sql', import.meta.url), 'utf8');

describe.skipIf(!enabled)('086_metric_point_identity', () => {
    it('collapses exact duplicates to the earliest received_at, keeps distinct rows, and re-applies cleanly', async () => {
        const { sql } = db;
        const session = randomUUID();
        const time = new Date(1_762_000_000_000 + Math.floor(Math.random() * 1e8));
        const row = (over: Record<string, unknown>) => ({
            agent: 'claude-code',
            metric: 'claude_code.token.usage',
            field: 'tokens_input',
            session_id: session,
            value: 1,
            temporality: 'delta',
            start_time: null,
            time,
            attrs: { series: 'x' },
            ...over,
        });
        // Before 086 the unique key was narrower; duplicates under the new key are rows only the
        // old index could have let in, so the index is dropped to put them in.
        await sql`drop index metric_point_dedup`;
        const nullTime = new Date(time.getTime() + 1);
        await sql`insert into metric_point ${sql([
            row({ received_at: new Date('2026-01-02T00:00:00Z') }),
            row({ received_at: new Date('2026-01-01T00:00:00Z') }),
            row({ agent: 'opencode', received_at: new Date('2026-01-03T00:00:00Z') }),
            row({ start_time: new Date('2026-01-01T00:00:00Z'), received_at: new Date('2026-01-03T00:00:00Z') }),
            row({ session_id: null, time: nullTime, received_at: new Date('2026-02-01T00:00:00Z') }),
            row({ session_id: null, time: nullTime, received_at: new Date('2026-01-05T00:00:00Z') }),
        ])}`;

        await sql.unsafe(MIGRATION);
        await sql.unsafe(MIGRATION);

        const kept = await sql<{ received_at: Date }[]>`
            select received_at from metric_point where session_id = ${session} and agent = 'claude-code' and start_time is null`;
        expect(kept.map((r) => r.received_at.toISOString())).toEqual(['2026-01-01T00:00:00.000Z']);
        const [others] = await sql<{ n: string }[]>`
            select count(*) as n from metric_point where session_id = ${session}`;
        expect(Number(others!.n)).toBe(3);
        const nulls = await sql<{ received_at: Date }[]>`
            select received_at from metric_point where session_id is null and time = ${nullTime}`;
        expect(nulls.map((r) => r.received_at.toISOString())).toEqual(['2026-01-05T00:00:00.000Z']);
    });
});
