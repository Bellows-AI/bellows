import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';

/**
 * 173 renames the setup receipts' table to `provider_setup_operation`: a receipt written under the old name survives,
 * and the constraints, the unique index and the row level security policy follow the table.
 */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '173_provider_setup_operation.sql';
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

const versioned = (below?: string): string[] =>
    readdirSync(DIR)
        .filter((name) => name.endsWith('.sql') && !name.endsWith('.repeatable.sql') && (!below || name < below))
        .sort();

async function applyAll(names: string[]): Promise<void> {
    await pool`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
    for (const name of names) {
        await pool.unsafe(readFileSync(new URL(name, DIR), 'utf8'));
        await pool`insert into schema_migrations (version) values (${name})`;
    }
}

const namesOf = async (query: Promise<{ name: string }[]>) => (await query).map((row) => row.name).sort();

describe.runIf(enabled)('173: the provider setup operation', () => {
    it('renames the table and keeps the receipts written before it', async () => {
        await applyAll(versioned(VERSION));
        const org = `o${randomUUID().replaceAll('-', '').slice(0, 30)}`;
        await pool`insert into organization (id, name) values (${org}, ${org})`;
        const [executor] = await pool<{ id: string }[]>`
            insert into executor_profile (org_id, user_id, name, type, config)
            values (${org}, null, 'Claude', 'claude-code', '{}'::jsonb) returning id
        `;
        await pool`
            insert into model_setup_operation (org_id, owner_id, request_id, fingerprint, executor_id)
            values (${org}, null, 'request-1', 'fingerprint', ${executor!.id})
        `;

        await applyAll([VERSION]);

        const [kept] = await pool<{ request_id: string; executor_id: string }[]>`
            select request_id, executor_id from provider_setup_operation where org_id = ${org}
        `;
        expect(kept).toEqual({ request_id: 'request-1', executor_id: executor!.id });
        const [old] = await pool<{ found: string | null }[]>`select to_regclass('model_setup_operation')::text as found`;
        expect(old!.found).toBeNull();
        await expect(
            pool`
                insert into provider_setup_operation (org_id, owner_id, request_id, fingerprint, executor_id)
                values (${org}, null, 'request-1', 'fingerprint', ${executor!.id})
            `
        ).rejects.toThrow(/provider_setup_operation_request_uk/);
    });

    it('renames the constraints and the index, and keeps one org isolation policy', async () => {
        expect(
            await namesOf(pool`
                select conname as name from pg_constraint
                where conrelid = to_regclass('provider_setup_operation')
            `)
        ).toEqual(
            [
                'provider_setup_operation_pk',
                'provider_setup_operation_org_fk',
                'provider_setup_operation_owner_fk',
                'provider_setup_operation_executor_fk',
                'provider_setup_operation_connection_fk',
                'provider_setup_operation_request_ck',
            ].sort()
        );
        expect(
            await namesOf(pool`
                select indexname as name from pg_indexes
                where schemaname = ${schema} and tablename = 'provider_setup_operation' and indexname like '%request_uk'
            `)
        ).toEqual(['provider_setup_operation_request_uk']);
        const policies = await namesOf(pool`
            select policyname as name from pg_policies
            where schemaname = ${schema} and tablename = 'provider_setup_operation'
        `);
        expect(policies).toEqual(['org_isolation']);
    });
});
