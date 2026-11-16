import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';

/**
 * 159 adds `job.run_model`: the model the latest claim handed the runner, beside the requested `agent_model`.
 * Nullable with no default — metadata only, so no row is rewritten under the boot lock; null until a claim records one.
 */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

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
    const names = readdirSync(DIR)
        .filter((name) => name.endsWith('.sql') && !name.endsWith('.repeatable.sql'))
        .sort();
    await pool`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
    for (const name of names) {
        await pool.unsafe(readFileSync(new URL(name, DIR), 'utf8'));
        await pool`insert into schema_migrations (version) values (${name})`;
    }
});

afterAll(async () => {
    if (!enabled) return;
    await pool.end();
    await admin.unsafe(`drop schema ${schema} cascade`);
    await admin.end();
});

describe.runIf(enabled)('159: the model a run got', () => {
    it('adds a nullable text run_model to job, with no default', async () => {
        const columns = await pool<{ is_nullable: string; data_type: string; column_default: string | null }[]>`
            select is_nullable, data_type, column_default from information_schema.columns
            where table_schema = ${schema} and table_name = 'job' and column_name = 'run_model'
        `;
        expect(columns).toEqual([{ is_nullable: 'YES', data_type: 'text', column_default: null }]);
    });

    it('applies twice without error', async () => {
        const name = readdirSync(DIR).find((file) => file.startsWith('159_'));
        expect(name).toBe('159_job_run_model.sql');
        await pool.unsafe(readFileSync(new URL(name!, DIR), 'utf8'));
    });
});
