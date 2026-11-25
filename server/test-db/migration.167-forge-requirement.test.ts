import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';

/** 166 widens the requirement's reason with `starter-removed`, the forge hold's reason for a removed starter. */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '167_forge_requirement.sql';
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

const versioned = (filter: (name: string) => boolean): string[] =>
    readdirSync(DIR)
        .filter((name) => name.endsWith('.sql') && !name.endsWith('.repeatable.sql') && filter(name))
        .sort();

describe.skipIf(!enabled)('167_forge_requirement', () => {
    it('accepts the new reason, keeps the old ones and refuses an unknown one', async () => {
        await pool`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
        for (const name of versioned((n) => n < VERSION)) {
            await pool.unsafe(readFileSync(new URL(name, DIR), 'utf8'));
            await pool`insert into schema_migrations (version) values (${name})`;
        }
        const org = `o${randomUUID().replaceAll('-', '').slice(0, 30)}`;
        await pool`insert into organization (id, name) values (${org}, ${org})`;
        const root = randomUUID();
        await pool`insert into job (org_id, id, command, root_job_id) values (${org}, ${root}, 'work', ${root})`;
        const insert = (reason: string) =>
            pool`insert into job_integration_requirement (org_id, root_job_id, provider, reason)
                 values (${org}, ${root}, ${`p-${randomUUID()}`}, ${reason})`;
        await expect(insert('starter-removed')).rejects.toThrow();
        await insert('reconnect');

        await pool.unsafe(readFileSync(new URL(VERSION, DIR), 'utf8'));

        await insert('starter-removed');
        await insert('missing');
        await expect(insert('gone')).rejects.toThrow();
        const kept = await pool`select reason from job_integration_requirement where org_id = ${org} order by reason`;
        expect(kept.map((row) => row.reason)).toEqual(['missing', 'reconnect', 'starter-removed']);
    });
});
