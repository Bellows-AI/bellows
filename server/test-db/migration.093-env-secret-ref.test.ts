import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';

/** BEL-54: 093 adds the secret reference columns to env_var and keeps plaintext rows readable. */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '093_env_var_secret_ref.sql';
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

const insertOrg = async (): Promise<string> => {
    const id = `o${randomUUID().replaceAll('-', '').slice(0, 30)}`;
    await pool`insert into organization (id, name) values (${id}, ${id})`;
    return id;
};

describe.skipIf(!enabled)('093_env_var_secret_ref', () => {
    it('upgrades a 092 database, keeping plaintext rows readable', async () => {
        await applyAll(versioned(VERSION));
        const org = await insertOrg();
        await pool`insert into env_var (org_id, name, value, is_secret) values (${org}, 'OLD_SECRET', 'plain', true)`;

        await applyAll([VERSION]);

        const [row] = await pool<{ value: string | null; secret_ref: string | null; secret_version: string | null }[]>`
            select value, secret_ref, secret_version from env_var where org_id = ${org}
        `;
        expect(row).toEqual({ value: 'plain', secret_ref: null, secret_version: null });
    });

    it('an old-pod plaintext secret insert still succeeds', async () => {
        const org = await insertOrg();
        await pool`insert into env_var (org_id, name, value, is_secret) values (${org}, 'LATE', 'v', true)`;
        const rows = await pool`select 1 from env_var where org_id = ${org} and value = 'v'`;
        expect(rows).toHaveLength(1);
    });

    it('accepts a reference row with no value, and secret_ref is unique', async () => {
        const org = await insertOrg();
        const ref = `sec_${randomUUID()}`;
        await pool`insert into env_var (org_id, name, value, is_secret, secret_ref, secret_version)
                   values (${org}, 'A', null, true, ${ref}, 'v1')`;
        await expect(
            pool`insert into env_var (org_id, name, value, is_secret, secret_ref, secret_version)
                 values (${org}, 'B', null, true, ${ref}, 'v1')`
        ).rejects.toThrow(/secret_ref/);
    });
});
