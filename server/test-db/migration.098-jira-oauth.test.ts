import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';
import { randomGithubId } from './fixtures.js';

/** BEL-61: 098 adds what an authorization asked for and the `site-mismatch` ending, expand only. */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '098_jira_oauth.sql';
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

describe.skipIf(!enabled)('098_jira_oauth', () => {
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

    it('adds requested_access and expected_site, keeps an earlier row, and accepts failure site-mismatch', async () => {
        await applyAll(versioned(VERSION));
        const org = await insertOrg();
        const user = await insertUser();
        const hash = `h-${randomUUID()}`;
        await insert(org, user, { state_hash: hash, status: 'failed', failure: 'busy' });
        await applyAll([VERSION]);
        const [earlier] = await pool<
            { failure: string; requested_access: string | null; expected_site: string | null }[]
        >`
            select failure, requested_access, expected_site from integration_authorization where state_hash = ${hash}
        `;
        expect(earlier).toEqual({ failure: 'busy', requested_access: null, expected_site: null });

        const mismatch = `h-${randomUUID()}`;
        await insert(org, user, {
            state_hash: mismatch,
            status: 'failed',
            failure: 'site-mismatch',
            requested_access: 'write',
            expected_site: 'example.atlassian.net',
        });
        const [row] = await pool<{ failure: string; requested_access: string; expected_site: string }[]>`
            select failure, requested_access, expected_site from integration_authorization where state_hash = ${mismatch}
        `;
        expect(row).toEqual({
            failure: 'site-mismatch',
            requested_access: 'write',
            expected_site: 'example.atlassian.net',
        });
    });

    it('rejects an unknown failure and an unknown requested access', async () => {
        const org = await insertOrg();
        const user = await insertUser();
        await expect(insert(org, user, { failure: 'other' })).rejects.toThrow();
        await expect(insert(org, user, { requested_access: 'admin' })).rejects.toThrow();
    });
});
