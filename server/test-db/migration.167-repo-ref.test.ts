import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { assertTestDatabase } from './harness.js';

/** 167 gives every repo-bearing table a forge and host, and tracked_repo a surrogate id and a full path. */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '167_repo_ref.sql';
const DIR = new URL('../migrations/', import.meta.url);
/** Repo-bearing tables the migration leaves out on purpose (telemetry paths, GitHub-only dedupe, an API-shaped filter). */
const EXCLUDED = ['session_branch', 'github_delivery', 'transcript_tool_event', 'notification_subscription'];
const FORGED = [
    'job',
    'task_reclaim',
    'env_var',
    'workflow',
    'tracked_repo',
    'job_pr',
    'workflow_wait',
    'workflow_round',
    'pr_merge',
    'batch_target',
    'batch_attempt',
    'batch_acceptance',
    'batch_pr_observation',
    'batch_merge',
    'pr_follow',
    'job_execution',
    'job_pr_operation',
    'notification_event',
];
const REPO_COLUMNS = ['repo', 'repo_owner', 'job_repo', 'pr_repo', 'repos'];

let admin: Sql;
let pool: Sql;
let schema: string;
let org: string;
let root: string;

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

const columnsOf = async (table: string) =>
    pool<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
        select column_name, is_nullable, column_default from information_schema.columns
        where table_schema = ${schema} and table_name = ${table}`;

describe.skipIf(!enabled)('167_repo_ref', () => {
    it('carries every existing row over as GitHub on github.com', async () => {
        await pool`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
        for (const name of versioned((n) => n < VERSION)) {
            await pool.unsafe(readFileSync(new URL(name, DIR), 'utf8'));
            await pool`insert into schema_migrations (version) values (${name})`;
        }
        expect((await columnsOf('job')).map((c) => c.column_name)).not.toContain('forge');

        org = `o${randomUUID().replaceAll('-', '').slice(0, 30)}`;
        await pool`insert into organization (id, name) values (${org}, ${org})`;
        root = randomUUID();
        await pool`insert into job (org_id, id, command, root_job_id, repo) values (${org}, ${root}, 'work', ${root}, 'acme/web')`;
        await pool`insert into job_pr (org_id, root_job_id, repo, pr_number, pr_url, head_branch, base_branch)
                   values (${org}, ${root}, 'acme/web', 7, 'https://x/pull/7', 'h', 'main')`;
        await pool`insert into workflow_wait (org_id, root_job_id, reason, repo, pr_number)
                   values (${org}, ${root}, 'pr-merged', 'acme/web', 7)`;
        await pool`insert into pr_merge (org_id, repo, pr_number, delivery_id) values (${org}, 'acme/web', 7, 'd1')`;
        await pool`insert into pr_follow (org_id, repo, pr_number) values (${org}, 'acme/web', 7)`;
        await pool`insert into tracked_repo (org_id, owner, name) values (${org}, 'acme', 'web')`;
        await pool`insert into env_var (org_id, repo_owner, repo_name, name, value) values (${org}, 'acme', 'web', 'A', '1')`;
        await pool`insert into workflow (org_id, name, repo_owner, repo_name, definition)
                   values (${org}, 'wf', 'acme', 'web', '{}'::jsonb)`;
        await pool`insert into notification_event (org_id, id, kind, job_id, root_job_id, repo, command)
                   values (${org}, ${randomUUID()}, 'task.ready', ${root}, ${root}, 'acme/web', 'work')`;

        // Through the migrator, so the concurrent index step runs too.
        await migrate(pool, { attempts: 1 });

        for (const table of [
            'job',
            'job_pr',
            'workflow_wait',
            'pr_merge',
            'pr_follow',
            'tracked_repo',
            'env_var',
            'workflow',
            'notification_event',
        ]) {
            const rows = await pool.unsafe(`select forge, host from ${table} where org_id = $1`, [org]);
            expect(
                rows.map((r) => [r.forge, r.host]),
                table
            ).toEqual([['github', 'github.com']]);
        }
        const tracked = await pool`select id, path from tracked_repo where org_id = ${org}`;
        expect(tracked).toHaveLength(1);
        expect(tracked[0]!.id).toEqual(expect.any(String));
        expect(tracked[0]!.path).toBe('acme/web');
    });

    it('gives every repo-bearing table forge and host, or names it as excluded', async () => {
        const tables = await pool<{ table_name: string }[]>`
            select distinct c.table_name from information_schema.columns c
            join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
            where c.table_schema = ${schema} and t.table_type = 'BASE TABLE'
              and (c.column_name = any(${REPO_COLUMNS}) or (c.table_name = 'tracked_repo' and c.column_name = 'owner'))`;
        const found = tables.map((t) => t.table_name).sort();
        expect(found).toEqual([...FORGED, ...EXCLUDED].sort());
        for (const table of FORGED) {
            const cols = Object.fromEntries((await columnsOf(table)).map((c) => [c.column_name, c]));
            expect(cols.forge?.is_nullable, table).toBe('NO');
            expect(cols.forge?.column_default, table).toBe("'github'::text");
            expect(cols.host?.is_nullable, table).toBe('NO');
            expect(cols.host?.column_default, table).toBe("'github.com'::text");
        }
        for (const table of EXCLUDED) {
            expect(
                (await columnsOf(table)).map((c) => c.column_name),
                table
            ).not.toContain('forge');
        }
    });

    it('accepts an insert written as the previous release writes it', async () => {
        await pool`insert into pr_merge (org_id, repo, pr_number, delivery_id) values (${org}, 'acme/web', 8, 'd2')
                   on conflict (org_id, repo, pr_number) do nothing`;
        await pool`insert into tracked_repo (org_id, owner, name) values (${org}, 'acme', 'api')`;
        await pool`insert into env_var (org_id, repo_owner, repo_name, name, value) values (${org}, 'acme', 'api', 'A', '1')`;
        await pool`insert into workflow (org_id, name, repo_owner, repo_name, definition)
                   values (${org}, 'wf', 'acme', 'api', '{}'::jsonb)`;
        await pool`insert into pr_follow (org_id, repo, pr_number) values (${org}, 'acme/web', 8)
                   on conflict do nothing`;
        const merged = await pool`select forge, host from pr_merge where org_id = ${org} and pr_number = 8`;
        expect(merged.map((r) => [r.forge, r.host])).toEqual([['github', 'github.com']]);
        const tracked = await pool`select forge, host, path from tracked_repo where org_id = ${org} and name = 'api'`;
        expect(tracked.map((r) => [r.forge, r.host, r.path])).toEqual([['github', 'github.com', 'acme/api']]);
    });

    it('keeps every narrow key and index beside a new wide one', async () => {
        const indexes = await pool<{ indexname: string; indexdef: string }[]>`
            select indexname, indexdef from pg_indexes where schemaname = ${schema}`;
        const defs = new Map(indexes.map((r) => [r.indexname, r.indexdef]));
        const narrow = [
            'tracked_repo_pk',
            'env_var_key_uk',
            'workflow_name_uk',
            'pr_follow_pk',
            'pr_merge_pk',
            'batch_merge_slot_idx',
            'job_admission_repo_uk',
        ];
        for (const name of narrow) {
            expect(defs.has(name), name).toBe(true);
            expect(defs.get(name), name).not.toMatch(/\bforge\b/);
        }
        const wide = [
            'tracked_repo_ref_uk',
            'env_var_ref_uk',
            'workflow_ref_uk',
            'pr_follow_ref_uk',
            'pr_merge_ref_uk',
            'batch_merge_ref_slot_idx',
            'job_admission_repo_ref_uk',
        ];
        for (const name of wide) expect(defs.get(name), name).toMatch(/\(org_id, forge,/);
        expect(defs.get('tracked_repo_id_uk')).toMatch(/UNIQUE.*\(id\)/);
        const invalid = await pool`
            select c.relname from pg_index i join pg_class c on c.oid = i.indexrelid
            where i.indrelid = any(${FORGED.map((t) => `${schema}.${t}`)}::regclass[]) and not i.indisvalid`;
        expect(invalid).toEqual([]);
    });

    it('keys the new rows by forge and host, and still refuses one path on two hosts until the contract', async () => {
        await pool`insert into tracked_repo (org_id, owner, name, forge, host) values (${org}, 'g/sub', 'p', 'gitlab', 'gl.example')`;
        const nested = await pool`select path, id from tracked_repo where org_id = ${org} and forge = 'gitlab'`;
        expect(nested).toHaveLength(1);
        expect(nested[0]!.path).toBe('g/sub/p');
        expect(nested[0]!.id).toEqual(expect.any(String));
        await expect(
            pool`insert into tracked_repo (org_id, owner, name, forge, host) values (${org}, 'g/sub', 'p', 'gitlab', 'gl.example')`
        ).rejects.toMatchObject({ code: '23505' });
        // The narrow key (org, owner, name) is still there: the same owner/name on another host collides.
        await expect(
            pool`insert into tracked_repo (org_id, owner, name, forge, host) values (${org}, 'acme', 'web', 'gitlab', 'gl.example')`
        ).rejects.toMatchObject({ code: '23505' });

        await expect(
            pool`insert into env_var (org_id, repo_owner, repo_name, name, value, forge, host)
                 values (${org}, 'acme', 'web', 'A', '2', 'gitlab', 'gl.example')`
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
            pool`insert into pr_follow (org_id, repo, pr_number, forge, host) values (${org}, 'acme/web', 7, 'gitlab', 'gl.example')`
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
            pool`insert into pr_merge (org_id, repo, pr_number, delivery_id, forge, host)
                 values (${org}, 'acme/web', 7, 'd9', 'gitlab', 'gl.example')`
        ).rejects.toMatchObject({ code: '23505' });
    });

    it('refuses an unknown forge on every table', async () => {
        for (const table of FORGED) {
            const [check] = await pool`
                select convalidated from pg_constraint
                where conrelid = ${table}::regclass and conname = ${`${table}_forge_ck`}`;
            expect(check, table).toBeDefined();
            expect(check!.convalidated, table).toBe(false);
        }
        await expect(
            pool`insert into tracked_repo (org_id, owner, name, forge) values (${org}, 'x', 'y', 'svn')`
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
            pool`insert into pr_merge (org_id, repo, pr_number, delivery_id, forge) values (${org}, 'x/y', 1, 'd', 'svn')`
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
            pool`insert into job (org_id, id, command, root_job_id, repo, forge)
                 values (${org}, ${randomUUID()}, 'w', ${root}, 'x/y', 'svn')`
        ).rejects.toMatchObject({ code: '23514' });
    });
});
