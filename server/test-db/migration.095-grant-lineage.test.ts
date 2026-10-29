import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';
import { randomGithubId } from './fixtures.js';

/** BEL-138: 095 adds the grant lineage columns, expand only: an old pod's grant writes still work. */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '095_grant_lineage.sql';
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

const insertUser = async (): Promise<string> => {
    const [row] = await pool<{ id: string }[]>`
        insert into app_user (github_user_id, github_login) values (${randomGithubId()}, ${`u-${randomUUID()}`})
        returning id
    `;
    return row!.id;
};

const LINEAGE = [
    'lineage_claim',
    'lineage_claim_kind',
    'lineage_claim_expires_at',
    'lineage_operation_id',
    'lineage_secret_ref',
    'secret_destroyed_at',
    'secret_wedged_at',
];

/** The 094 grant insert: exactly the columns grants were written with before the lineage existed. */
const oldGrant = async (org: string, user: string): Promise<string> => {
    const [row] = await pool<{ id: string }[]>`
        insert into integration_grant (org_id, principal_kind, principal_user_id, provider, external_account_id, authority)
        values (${org}, 'user', ${user}, 'jira', ${`acct-${randomUUID()}`}, '{"scopes":["read"]}'::jsonb)
        returning id
    `;
    return row!.id;
};

describe.skipIf(!enabled)('095_grant_lineage', () => {
    it('upgrades a 094 database: a grant written before it keeps every value and gains null lineage columns', async () => {
        await applyAll(versioned(VERSION));
        const org = await insertOrg();
        const user = await insertUser();
        const id = await oldGrant(org, user);
        await pool`update integration_grant set secret_ref = 'ref-old', secret_version = 'v1' where id = ${id}`;

        await applyAll([VERSION]);

        const [row] = await pool<Record<string, unknown>[]>`select * from integration_grant where id = ${id}`;
        expect(row).toMatchObject({ secret_ref: 'ref-old', secret_version: 'v1', status: 'active' });
        for (const column of LINEAGE) expect(row![column]).toBeNull();
    });

    it('every lineage column is nullable', async () => {
        const columns = await pool<{ column_name: string; is_nullable: string }[]>`
            select column_name, is_nullable from information_schema.columns
            where table_schema = ${schema} and table_name = 'integration_grant' and column_name = any(${LINEAGE})
        `;
        expect(columns.map((c) => c.column_name).sort()).toEqual([...LINEAGE].sort());
        expect(columns.every((c) => c.is_nullable === 'YES')).toBe(true);
    });

    it('an old pod still inserts and updates grants in the 094 shape', async () => {
        const org = await insertOrg();
        const user = await insertUser();
        const id = await oldGrant(org, user);
        await pool`
            update integration_grant set version = version + 1, secret_version = 'v2', status = 'reconnect_required',
                updated_at = now() where id = ${id}
        `;
        await pool`update integration_grant set status = 'revoked', revoked_at = now() where id = ${id}`;
        const [row] = await pool<
            { status: string; version: string }[]
        >`select status, version from integration_grant where id = ${id}`;
        expect(row).toEqual({ status: 'revoked', version: '2' });
    });

    it('the claim kind is a closed list', async () => {
        const org = await insertOrg();
        const user = await insertUser();
        const id = await oldGrant(org, user);
        await expect(
            pool`update integration_grant set lineage_claim_kind = 'other' where id = ${id}`
        ).rejects.toThrow();
        await pool`update integration_grant set lineage_claim_kind = 'destroy' where id = ${id}`;
    });
});
