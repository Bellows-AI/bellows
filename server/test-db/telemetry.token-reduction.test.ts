import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { reduceTokenObservations, type TokenObservation, type TokenType } from '@factory-ai/core';
import { migrate } from '../src/db/migrate.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb();
let sql: Sql;

beforeAll(() => {
    if (enabled) sql = db.sql;
});

const FIELD_OF: Record<TokenType, string> = {
    input: 'tokens_input',
    output: 'tokens_output',
    cacheRead: 'tokens_cacheRead',
    cacheCreation: 'tokens_cacheCreation',
};

interface Row {
    agent?: string;
    session: string | null;
    source?: 'otel' | 'transcript';
    type: TokenType;
    temporality?: 'delta' | 'cumulative' | 'unspecified';
    start?: string | null;
    time: string;
    value: number;
    attrs?: Record<string, string>;
}

async function put(row: Row): Promise<void> {
    await sql`insert into metric_point ${sql({
        agent: row.agent ?? 'claude-code',
        metric: 'claude_code.token.usage',
        field: FIELD_OF[row.type],
        session_id: row.session,
        source: row.source ?? 'otel',
        value: row.value,
        temporality: row.temporality ?? 'delta',
        start_time: row.start ? new Date(row.start) : null,
        time: new Date(row.time),
        attrs: { type: row.type, ...row.attrs },
    })}`;
}

interface Stored {
    agent: string;
    session_id: string | null;
    source: 'otel' | 'transcript';
    metric: string;
    field: string;
    temporality: 'delta' | 'cumulative' | 'unspecified';
    start_time: Date | null;
    time: Date;
    value: number;
    attrs: Record<string, string>;
}

const cell = (agent: string, session: string | null, field: string): string => JSON.stringify([agent, session, field]);

/** The reference: every stored token row through the core reducer, summed per (agent, session, type). */
async function reducerTotals(): Promise<Map<string, number>> {
    const rows = await sql<Stored[]>`
        select agent, session_id, source, metric, field, temporality, start_time, time, value, attrs
        from metric_point where field like 'tokens\\_%'
    `;
    const observations: TokenObservation[] = rows.map((r) => ({
        agent: r.agent,
        sessionId: r.session_id,
        source: r.source,
        metric: r.metric,
        field: r.field.slice('tokens_'.length) as TokenType,
        temporality: r.temporality,
        startTime: r.start_time === null ? null : r.start_time.toISOString(),
        time: r.time.toISOString(),
        value: Number(r.value),
        attrs: r.attrs,
    }));
    const totals = new Map<string, number>();
    for (const c of reduceTokenObservations(observations)) {
        if (c.kind !== 'timed' && c.kind !== 'unlocated') continue;
        const type = (Object.keys(c.tokens) as TokenType[]).find((t) => c.tokens[t] !== null)!;
        const key = cell(c.selection.agent, c.selection.sessionId, FIELD_OF[type]);
        totals.set(key, (totals.get(key) ?? 0) + (c.tokens[type] as number));
    }
    return totals;
}

async function sqlTotals(): Promise<Map<string, number>> {
    const rows = await sql<{ agent: string; session_id: string | null; field: string; value: number }[]>`
        select agent, session_id, field, value from session_field_total where field like 'tokens\\_%'
    `;
    return new Map(rows.map((r) => [cell(r.agent, r.session_id, r.field), Number(r.value)]));
}

const S0 = '2026-08-01T10:00:00Z';
const S1 = '2026-08-01T12:00:00Z';
const at = (minutes: number): string => new Date(Date.parse(S0) + minutes * 60_000).toISOString();

describe.skipIf(!enabled)('SQL token reduction matches the core reducer', () => {
    it('agrees on a mix of every series shape, and on the numbers each should have', async () => {
        const sess = Object.fromEntries(
            ['delta', 'rebound', 'twoModels', 'agents', 'unspec', 'unspecOnly', 'suppressed', 'transcriptOnly'].map(
                (n) => [n, `${n}-${randomUUID()}`]
            )
        ) as Record<string, string>;
        const more = Object.fromEntries(
            ['fold', 'ambiguous', 'legacyOnly', 'zero', 'noStart', 'reordered'].map((n) => [n, `${n}-${randomUUID()}`])
        ) as Record<string, string>;

        // Deltas sum; a measured zero is a row (0), an unmeasured type has no row at all.
        await put({ session: sess.delta!, type: 'input', time: at(1), value: 10 });
        await put({ session: sess.delta!, type: 'input', time: at(2), value: 20 });
        await put({ session: sess.delta!, type: 'output', time: at(1), value: 0 });

        // Cumulative with a rebound (reads 30, then 20, then 40): high-water 40. A restart (new
        // start_time) is a new counter and adds: 5 then 15.
        for (const [i, v] of [10, 30, 20, 40].entries()) {
            await put({
                session: sess.rebound!,
                type: 'input',
                temporality: 'cumulative',
                start: S0,
                time: at(i),
                value: v,
            });
        }
        for (const [i, v] of [5, 15].entries()) {
            await put({
                session: sess.rebound!,
                type: 'input',
                temporality: 'cumulative',
                start: S1,
                time: at(200 + i),
                value: v,
            });
        }

        // The same cumulative counter per model: two counters that share a start time are both counted.
        await put({
            session: sess.twoModels!,
            type: 'input',
            temporality: 'cumulative',
            start: S0,
            time: at(1),
            value: 100,
            attrs: { model: 'model-a' },
        });
        await put({
            session: sess.twoModels!,
            type: 'input',
            temporality: 'cumulative',
            start: S0,
            time: at(1),
            value: 80,
            attrs: { model: 'model-b' },
        });
        await put({
            session: sess.twoModels!,
            type: 'input',
            temporality: 'cumulative',
            start: S0,
            time: at(2),
            value: 120,
            attrs: { model: 'model-a' },
        });

        // Two agents may share a session id; neither merges into the other.
        await put({ session: sess.agents!, type: 'input', time: at(1), value: 7 });
        await put({ agent: 'opencode', session: sess.agents!, type: 'input', time: at(1), value: 9 });

        // A null session is its own group per agent and is not lost to null equality.
        await put({ session: null, type: 'input', time: at(1), value: 3 });
        await put({ session: null, type: 'input', time: at(2), value: 4 });
        await put({ session: null, type: 'output', temporality: 'cumulative', start: S0, time: at(1), value: 8 });
        await put({ session: null, type: 'output', temporality: 'cumulative', start: S0, time: at(2), value: 11 });
        await put({ agent: 'opencode', session: null, type: 'input', time: at(1), value: 100 });

        // Unspecified temporality is not summed as a delta; a field with only unspecified reads is unmeasured.
        await put({ session: sess.unspec!, type: 'input', time: at(1), value: 4 });
        await put({ session: sess.unspec!, type: 'input', temporality: 'unspecified', time: at(2), value: 100 });
        await put({ session: sess.unspecOnly!, type: 'output', temporality: 'unspecified', time: at(1), value: 60 });

        // OTEL owns a session: its transcript copy is a diagnostic, not usage.
        await put({ session: sess.suppressed!, type: 'input', time: at(1), value: 50 });
        await put({ session: sess.suppressed!, source: 'transcript', type: 'input', time: at(1), value: 999 });
        await put({ session: sess.transcriptOnly!, source: 'transcript', type: 'input', time: at(1), value: 200 });

        // Deploy case: a counter live across the digest rollout has legacy (no series) and digest rows.
        const fold = more.fold!;
        await put({
            session: fold,
            type: 'input',
            temporality: 'cumulative',
            start: S0,
            time: at(1),
            value: 100,
            attrs: { model: 'm' },
        });
        await put({
            session: fold,
            type: 'input',
            temporality: 'cumulative',
            start: S0,
            time: at(2),
            value: 150,
            attrs: { model: 'm', series: 'a1' },
        });
        await put({
            session: fold,
            type: 'input',
            temporality: 'cumulative',
            start: S0,
            time: at(3),
            value: 160,
            attrs: { model: 'm' },
        });
        // Two digest siblings make the legacy rows ambiguous: they are never added to either.
        const amb = more.ambiguous!;
        await put({
            session: amb,
            type: 'input',
            temporality: 'cumulative',
            start: S0,
            time: at(1),
            value: 100,
            attrs: { model: 'm' },
        });
        await put({
            session: amb,
            type: 'input',
            temporality: 'cumulative',
            start: S0,
            time: at(2),
            value: 150,
            attrs: { model: 'm', series: 'a1' },
        });
        await put({
            session: amb,
            type: 'input',
            temporality: 'cumulative',
            start: S0,
            time: at(2),
            value: 70,
            attrs: { model: 'm', series: 'b2' },
        });
        // A legacy counter with no digest sibling stands alone.
        await put({
            session: more.legacyOnly!,
            type: 'input',
            temporality: 'cumulative',
            start: S0,
            time: at(1),
            value: 100,
        });

        // A measured cumulative zero is 0, not null; a cumulative series with no start time still counts.
        await put({
            session: more.zero!,
            type: 'cacheRead',
            temporality: 'cumulative',
            start: S0,
            time: at(1),
            value: 0,
        });
        await put({ session: more.noStart!, type: 'cacheCreation', temporality: 'cumulative', time: at(1), value: 40 });
        await put({ session: more.noStart!, type: 'cacheCreation', temporality: 'cumulative', time: at(2), value: 60 });

        // Attribute order is not identity: jsonb stores the same attributes the same way.
        await sql`insert into metric_point (agent, metric, field, session_id, value, temporality, start_time, time, attrs)
            values ('claude-code', 'claude_code.token.usage', 'tokens_input', ${more.reordered!}, 10, 'cumulative', ${new Date(S0)}, ${new Date(at(1))}, '{"type":"input","query_source":"q","model":"m","series":"z9"}'::jsonb)`;
        await sql`insert into metric_point (agent, metric, field, session_id, value, temporality, start_time, time, attrs)
            values ('claude-code', 'claude_code.token.usage', 'tokens_input', ${more.reordered!}, 25, 'cumulative', ${new Date(S0)}, ${new Date(at(2))}, '{"series":"z9","type":"input","model":"m","query_source":"q"}'::jsonb)`;

        const viaSql = await sqlTotals();
        const viaReducer = await reducerTotals();
        expect(Object.fromEntries(viaSql)).toEqual(Object.fromEntries(viaReducer));

        const total = (agent: string, session: string | null, field: string) => viaSql.get(cell(agent, session, field));
        expect(total('claude-code', sess.delta!, 'tokens_input')).toBe(30);
        expect(total('claude-code', sess.delta!, 'tokens_output')).toBe(0);
        expect(total('claude-code', sess.delta!, 'tokens_cacheRead')).toBeUndefined();
        expect(total('claude-code', sess.rebound!, 'tokens_input')).toBe(55);
        expect(total('claude-code', sess.twoModels!, 'tokens_input')).toBe(200);
        expect(total('claude-code', sess.agents!, 'tokens_input')).toBe(7);
        expect(total('opencode', sess.agents!, 'tokens_input')).toBe(9);
        expect(total('claude-code', null, 'tokens_input')).toBe(7);
        expect(total('claude-code', null, 'tokens_output')).toBe(11);
        expect(total('opencode', null, 'tokens_input')).toBe(100);
        expect(total('claude-code', sess.unspec!, 'tokens_input')).toBe(4);
        expect(total('claude-code', sess.unspecOnly!, 'tokens_output')).toBeUndefined();
        expect(total('claude-code', sess.suppressed!, 'tokens_input')).toBe(50);
        expect(total('claude-code', sess.transcriptOnly!, 'tokens_input')).toBe(200);
        expect(total('claude-code', fold, 'tokens_input')).toBe(160);
        expect(total('claude-code', amb, 'tokens_input')).toBe(220);
        expect(total('claude-code', more.legacyOnly!, 'tokens_input')).toBe(100);
        expect(total('claude-code', more.zero!, 'tokens_cacheRead')).toBe(0);
        expect(total('claude-code', more.noStart!, 'tokens_cacheCreation')).toBe(60);
        expect(total('claude-code', more.reordered!, 'tokens_input')).toBe(25);
    });

    it('is stable when the repeatable views are re-applied', async () => {
        const session = `again-${randomUUID()}`;
        await put({ session, type: 'input', temporality: 'cumulative', start: S0, time: at(1), value: 12 });
        const before = await sqlTotals();
        await migrate(sql, { attempts: 3 });
        expect(await sqlTotals()).toEqual(before);
    });
});
