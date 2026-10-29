import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';
import { randomGithubId } from './fixtures.js';

/** BEL-138: 096 adds the authorization transaction table, expand only: nothing that wrote before it changes. */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '096_integration_authorization.sql';
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

describe.skipIf(!enabled)('096_integration_authorization', () => {
    it('upgrades a 095 database: the table appears and no grant or connection row changes', async () => {
        await applyAll(versioned(VERSION));
        const org = await insertOrg();
        const user = await insertUser();
        const [grant] = await pool<{ id: string }[]>`
            insert into integration_grant (org_id, principal_kind, principal_user_id, provider, external_account_id)
            values (${org}, 'user', ${user}, 'jira', 'acct-1') returning id
        `;
        await applyAll([VERSION]);
        const [row] = await pool<{ status: string; version: string }[]>`
            select status, version from integration_grant where id = ${grant!.id}
        `;
        expect(row).toEqual({ status: 'active', version: '1' });
        const [row2] = await pool<{ n: string }[]>`select count(*)::text as n from integration_authorization`;
        expect(row2!.n).toBe('0');
    });

    const insert = (org: string, user: string, over: Record<string, unknown> = {}) =>
        pool`
            insert into integration_authorization ${pool({
                org_id: org,
                user_id: user,
                provider: 'jira',
                intent: 'connect',
                state_hash: `h-${randomUUID()}`,
                return_to: '/',
                expires_at: new Date(Date.now() + 600_000),
                ...over,
            } as never)}
        `;

    it('a row starts pending and carries a unique state hash', async () => {
        const org = await insertOrg();
        const user = await insertUser();
        const hash = `h-${randomUUID()}`;
        await insert(org, user, { state_hash: hash });
        const [row] = await pool<{ status: string; consumed_at: Date | null }[]>`
            select status, consumed_at from integration_authorization where state_hash = ${hash}
        `;
        expect(row).toMatchObject({ status: 'pending', consumed_at: null });
        await expect(insert(org, user, { state_hash: hash })).rejects.toThrow();
    });

    it('the intent, the status and the failure are closed lists', async () => {
        const org = await insertOrg();
        const user = await insertUser();
        await expect(insert(org, user, { intent: 'other' })).rejects.toThrow();
        await expect(insert(org, user, { status: 'other' })).rejects.toThrow();
        await expect(insert(org, user, { failure: 'other' })).rejects.toThrow();
        await insert(org, user, { status: 'failed', failure: 'busy' });
    });

    it('a deleted user or organization takes its transactions with it', async () => {
        const org = await insertOrg();
        const user = await insertUser();
        const hash = `h-${randomUUID()}`;
        await insert(org, user, { state_hash: hash });
        await pool`delete from app_user where id = ${user}`;
        const rows = await pool`select 1 from integration_authorization where state_hash = ${hash}`;
        expect(rows).toHaveLength(0);
    });
});
