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
        // Before 086 the unique key was the narrow one, which let null-session duplicates in (null <> null)
        // and nothing else; the board is put in that state, and restored by re-running the migration.
        await sql`drop index metric_point_dedup`;
        await sql`create unique index metric_point_dedup on metric_point (metric, session_id, time, source, md5(attrs::text))`;
        try {
            const nullTime = new Date(time.getTime() + 1);
            const laterTime = new Date(time.getTime() + 2);
            await sql`insert into metric_point ${sql([
                row({ received_at: new Date('2026-01-02T00:00:00Z') }),
                row({ time: laterTime, received_at: new Date('2026-01-01T00:00:00Z') }),
                row({ session_id: null, time: nullTime, received_at: new Date('2026-02-01T00:00:00Z') }),
                row({ session_id: null, time: nullTime, received_at: new Date('2026-01-05T00:00:00Z') }),
                row({
                    session_id: null,
                    time: nullTime,
                    agent: 'opencode',
                    received_at: new Date('2026-01-06T00:00:00Z'),
                }),
                row({
                    session_id: null,
                    time: nullTime,
                    start_time: new Date('2026-01-01T00:00:00Z'),
                    received_at: new Date('2026-01-07T00:00:00Z'),
                }),
            ])}`;

            await sql.unsafe(MIGRATION);
            await sql.unsafe(MIGRATION);

            const [sessionRows] = await sql<{ n: string }[]>`
                select count(*) as n from metric_point where session_id = ${session}`;
            expect(Number(sessionRows!.n)).toBe(2);
            const nulls = await sql<{ agent: string; received_at: Date }[]>`
                select agent, received_at from metric_point where session_id is null and time = ${nullTime}
                order by received_at`;
            expect(nulls.map((r) => [r.agent, r.received_at.toISOString()])).toEqual([
                ['claude-code', '2026-01-05T00:00:00.000Z'],
                ['opencode', '2026-01-06T00:00:00.000Z'],
                ['claude-code', '2026-01-07T00:00:00.000Z'],
            ]);
            // The widened key: the same session row for another agent is no longer a conflict.
            await sql`insert into metric_point ${sql([row({ agent: 'opencode' })])}`;
        } finally {
            await sql.unsafe(MIGRATION);
        }
    });
});
