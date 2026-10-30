import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';

/** BEL-174: 102 widens the requirement's reason and records who asked, how it closed and what was delivered. */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '102_runtime_requirements.sql';
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

describe.skipIf(!enabled)('102_runtime_requirements', () => {
    it('keeps every existing row and widens the checks', async () => {
        await pool`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
        for (const name of versioned((n) => n < VERSION)) {
            await pool.unsafe(readFileSync(new URL(name, DIR), 'utf8'));
            await pool`insert into schema_migrations (version) values (${name})`;
        }
        const org = `o${randomUUID().replaceAll('-', '').slice(0, 30)}`;
        await pool`insert into organization (id, name) values (${org}, ${org})`;
        const root = randomUUID();
        await pool`insert into job (org_id, id, command, root_job_id) values (${org}, ${root}, 'work', ${root})`;
        await pool`insert into job_integration_requirement (org_id, root_job_id, provider, reason)
                   values (${org}, ${root}, 'jira', 'missing')`;

        await pool.unsafe(readFileSync(new URL(VERSION, DIR), 'utf8'));

        const [kept] = await pool<{ source: string; outcome: string | null; asked_job_id: string | null }[]>`
            select source, outcome, asked_job_id from job_integration_requirement where org_id = ${org}
        `;
        expect(kept).toEqual({ source: 'create', outcome: null, asked_job_id: null });

        const insert = (over: Record<string, unknown>) =>
            pool`insert into job_integration_requirement ${pool({
                org_id: org,
                root_job_id: root,
                provider: `p-${randomUUID()}`,
                reason: 'missing',
                ...over,
            } as never)}`;
        await insert({ reason: 'reconnect', source: 'runtime', asked_job_id: root, asked_claim_seq: 1 });
        await expect(insert({ reason: 'gone' })).rejects.toThrow();
        await expect(insert({ source: 'runtime' })).rejects.toThrow();
        await expect(insert({ asked_job_id: root })).rejects.toThrow();
        await expect(insert({ source: 'elsewhere' })).rejects.toThrow();
        await expect(insert({ outcome: 'ignored' })).rejects.toThrow();
        await insert({ outcome: 'dismissed', satisfied_at: new Date() });

        const columns = await pool<{ data_type: string; is_nullable: string }[]>`
            select data_type, is_nullable from information_schema.columns
            where table_schema = current_schema() and table_name = 'integration_authorization'
              and column_name = 'bind_job_id'
        `;
        expect(columns).toEqual([{ data_type: 'uuid', is_nullable: 'YES' }]);
    });
});
