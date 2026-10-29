import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';

/** BEL-61: 099 adds the operation receipt table, its unique logical key and its status check, expand only. */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '099_operation_receipts.sql';
const DIR = new URL('../migrations/', import.meta.url);
let admin: Sql;
let pool: Sql;
let schema: string;

beforeAll(async () => {
    if (!enabled) return;
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    schema = `mig_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`create schema ${schema}`);
    pool = postgres(url as string, { max: 2, onnotice: () => {}, connection: { search_path: schema } });
});

afterAll(async () => {
    if (!enabled) return;
    await pool.end();
    await admin.unsafe(`drop schema ${schema} cascade`);
    await admin.end();
});

const versioned = (upTo: string): string[] =>
    readdirSync(DIR)
        .filter((name) => name.endsWith('.sql') && !name.endsWith('.repeatable.sql') && name <= upTo)
        .sort();

describe.skipIf(!enabled)('099_operation_receipts', () => {
    it('creates the table, the unique key and the status check, and cascades with the root', async () => {
        await pool`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
        for (const name of versioned(VERSION)) {
            await pool.unsafe(readFileSync(new URL(name, DIR), 'utf8'));
            await pool`insert into schema_migrations (version) values (${name})`;
        }
        const org = `o${randomUUID().replaceAll('-', '').slice(0, 30)}`;
        await pool`insert into organization (id, name) values (${org}, ${org})`;
        const root = randomUUID();
        await pool`insert into job (org_id, id, command, root_job_id) values (${org}, ${root}, 'work', ${root})`;
        const row = (over: Record<string, unknown> = {}) => ({
            org_id: org,
            root_job_id: root,
            provider: 'jira',
            operation: 'addComment',
            operation_key: 'k1',
            fingerprint: 'f'.repeat(64),
            ...over,
        });
        const insert = (over: Record<string, unknown> = {}) =>
            pool`insert into integration_operation_receipt ${pool(row(over) as never)}`;

        await insert();
        const [stored] = await pool<{ status: string; result: unknown; dispatched_at: Date | null }[]>`
            select status, result, dispatched_at from integration_operation_receipt where org_id = ${org}
        `;
        expect(stored).toEqual({ status: 'started', result: null, dispatched_at: null });

        await expect(insert()).rejects.toThrow(/unique|duplicate/i);
        await insert({ operation_key: 'k2' });
        await expect(insert({ operation_key: 'k3', status: 'done' })).rejects.toThrow();
        await expect(insert({ operation_key: 'bad key' })).rejects.toThrow();
        await expect(insert({ operation_key: 'k'.repeat(129) })).rejects.toThrow();
        await expect(insert({ operation_key: 'k4', root_job_id: randomUUID() })).rejects.toThrow();

        await pool`delete from job where org_id = ${org} and id = ${root}`;
        const [counted] = await pool<{ count: string }[]>`
            select count(*) from integration_operation_receipt where org_id = ${org}
        `;
        expect(Number(counted?.count)).toBe(0);
    });
});
