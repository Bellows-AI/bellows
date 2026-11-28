import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';

/**
 * 175 marks every executor that has no connection `provider_migration_pending` and validates its check at once: rows the
 * migration found are admitted, and a new write without a connection is refused.
 */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '175_executor_provider_required.sql';
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

const insertExecutor = (org: string, name: string, connection: string | null) =>
    pool<{ id: string }[]>`
        insert into executor_profile (org_id, user_id, name, type, config, provider_connection_id)
        values (${org}, null, ${name}, 'claude-code', '{}'::jsonb, ${connection}) returning id
    `;

describe.runIf(enabled)('175: every executor has a provider connection', () => {
    it('marks the executors found with no connection pending, and leaves the others alone', async () => {
        await applyAll(versioned(VERSION));
        const org = `o${randomUUID().replaceAll('-', '').slice(0, 30)}`;
        await pool`insert into organization (id, name) values (${org}, ${org})`;
        const [connection] = await pool<{ id: string }[]>`
            insert into provider_connection (org_id, id, name, provider, secret_ref, secret_version)
            values (${org}, gen_random_uuid(), 'Anthropic', 'anthropic', 'ref', 'v1') returning id
        `;
        await insertExecutor(org, 'bare', null);
        await insertExecutor(org, 'connected', connection!.id);

        await applyAll([VERSION]);

        const rows = await pool<{ name: string; pending: boolean; reason: string | null }[]>`
            select name, provider_migration_pending as pending, provider_migration_reason as reason
            from executor_profile where org_id = ${org} order by name
        `;
        expect(rows).toEqual([
            { name: 'bare', pending: true, reason: null },
            { name: 'connected', pending: false, reason: null },
        ]);
        const [check] = await pool<{ validated: boolean }[]>`
            select convalidated as validated from pg_constraint
            where conname = 'executor_profile_provider_required_ck' and conrelid = to_regclass('executor_profile')
        `;
        expect(check!.validated).toBe(true);
    });

    it('refuses a new executor with no connection, and a reason without a suspension', async () => {
        const org = `o${randomUUID().replaceAll('-', '').slice(0, 30)}`;
        await pool`insert into organization (id, name) values (${org}, ${org})`;
        await expect(insertExecutor(org, 'bare', null)).rejects.toThrow(/executor_profile_provider_required_ck/);
        await expect(
            pool`
                insert into executor_profile (org_id, user_id, name, type, config, provider_migration_reason)
                values (${org}, null, 'reasoned', 'claude-code', '{}'::jsonb, 'because')
            `
        ).rejects.toThrow(/executor_profile_provider_required_ck/);
    });
});
