import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';
import { randomGithubId } from './fixtures.js';

/**
 * 157 records the agent default: one row for the organization (`user_id` null) and one per member, each an agent type
 * and a model. `job`, `batch_task` and `workflow_round` gain the nullable `agent_type`/`agent_model` a task is frozen with.
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
    await pool`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
    const names = readdirSync(DIR)
        .filter((name) => name.endsWith('.sql') && !name.endsWith('.repeatable.sql'))
        .sort();
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

const newOrg = async (): Promise<string> => {
    const org = `o${randomUUID().replaceAll('-', '').slice(0, 30)}`;
    await pool`insert into organization (id, name) values (${org}, ${org})`;
    return org;
};

const newUser = async (): Promise<string> => {
    const [row] = await pool<{ id: string }[]>`
        insert into app_user (github_user_id, github_login) values (${randomGithubId()}, ${`u-${randomUUID()}`})
        returning id
    `;
    return row!.id;
};

const insertDefault = (org: string, userId: string | null, agentType: string, model: string) =>
    pool`insert into agent_default (org_id, user_id, agent_type, model) values (${org}, ${userId}, ${agentType}, ${model})`;

describe.runIf(enabled)('157: the agent default', () => {
    it('holds one org row and one row per member', async () => {
        const org = await newOrg();
        const alice = await newUser();
        await insertDefault(org, null, 'claude-code', 'claude-sonnet-4-5');
        await insertDefault(org, alice, 'opencode', 'anthropic/claude-sonnet-4-5');

        await expect(insertDefault(org, null, 'opencode', 'm')).rejects.toThrow(/duplicate key/);
        await expect(insertDefault(org, alice, 'claude-code', 'm')).rejects.toThrow(/duplicate key/);

        const [row] = await pool<{ updated_at: Date | null }[]>`
            select updated_at from agent_default where org_id = ${org} and user_id is null
        `;
        expect(row!.updated_at).toBeInstanceOf(Date);
    });

    it('refuses an agent type outside claude-code and opencode, and a model outside 1..200 characters', async () => {
        const org = await newOrg();
        await expect(insertDefault(org, null, 'codex', 'm')).rejects.toThrow(/check constraint/);
        await expect(insertDefault(org, null, 'claude-code', '')).rejects.toThrow(/check constraint/);
        await expect(insertDefault(org, null, 'claude-code', 'm'.repeat(201))).rejects.toThrow(/check constraint/);
        await insertDefault(org, null, 'claude-code', 'm'.repeat(200));
    });

    it('goes with its organization and its member', async () => {
        const org = await newOrg();
        const alice = await newUser();
        await insertDefault(org, alice, 'claude-code', 'm');
        await pool`delete from app_user where id = ${alice}`;
        await insertDefault(org, null, 'claude-code', 'm');
        await pool`delete from organization where id = ${org}`;
        const [left] = await pool<{ count: number }[]>`
            select count(*)::int as count from agent_default where org_id = ${org}
        `;
        expect(left!.count).toBe(0);
    });

    it('isolates rows per organization under row level security', async () => {
        const [table] = await pool<{ relrowsecurity: boolean }[]>`
            select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = ${schema} and c.relname = 'agent_default'
        `;
        expect(table?.relrowsecurity).toBe(true);
        const policies = await pool<{ policyname: string }[]>`
            select policyname from pg_policies where schemaname = ${schema} and tablename = 'agent_default'
        `;
        expect(policies.map((p) => p.policyname)).toEqual(['org_isolation']);
    });

    it.each(['job', 'batch_task', 'workflow_round'])(
        'adds nullable agent_type and agent_model to %s',
        async (table) => {
            const columns = await pool<{ column_name: string; is_nullable: string; data_type: string }[]>`
            select column_name, is_nullable, data_type from information_schema.columns
            where table_schema = ${schema} and table_name = ${table} and column_name in ('agent_type', 'agent_model')
            order by column_name
        `;
            expect(columns).toEqual([
                { column_name: 'agent_model', is_nullable: 'YES', data_type: 'text' },
                { column_name: 'agent_type', is_nullable: 'YES', data_type: 'text' },
            ]);
            const checks = await pool<{ def: string }[]>`
            select pg_get_constraintdef(c.oid) as def from pg_constraint c
            join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
            where n.nspname = ${schema} and t.relname = ${table} and c.contype = 'c'
              and pg_get_constraintdef(c.oid) like '%agent_type%'
        `;
            expect(checks).toHaveLength(1);
            expect(checks[0]!.def).toMatch(/claude-code/);
            expect(checks[0]!.def).toMatch(/opencode/);
            expect(checks[0]!.def).not.toMatch(/agent_model/);
        }
    );
});
