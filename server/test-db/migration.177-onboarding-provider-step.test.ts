import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';
import { randomGithubId } from './fixtures.js';

/**
 * 177 renames the onboarding step `model` to `provider`: a member's recorded done and skipped values follow, and the
 * step checks admit the new name and refuse the old.
 */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '177_onboarding_provider_step.sql';
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

const insertMember = async (org: string, done: string[], skipped: string[]): Promise<string> => {
    const login = `u-${randomUUID()}`;
    const [row] = await pool<{ id: string }[]>`
        insert into app_user (github_user_id, github_login) values (${randomGithubId()}, ${login})
        returning id
    `;
    await pool`
        insert into org_membership (org_id, github_login, user_id, claimed_at, setup_done, setup_skipped)
        values (${org}, ${login}, ${row!.id}, now(), ${done}, ${skipped})
    `;
    return row!.id;
};

const setupOf = async (org: string, userId: string) => {
    const [row] = await pool<{ setup_done: string[]; setup_skipped: string[] }[]>`
        select setup_done, setup_skipped from org_membership where org_id = ${org} and user_id = ${userId}
    `;
    return row!;
};

describe.runIf(enabled)('177: the onboarding provider step', () => {
    it('rewrites a recorded model step to provider and leaves every other value alone', async () => {
        await applyAll(versioned(VERSION));
        const org = `o${randomUUID().replaceAll('-', '').slice(0, 30)}`;
        await pool`insert into organization (id, name) values (${org}, ${org})`;
        const done = await insertMember(org, ['model', 'tools'], []);
        const skipped = await insertMember(org, ['tools'], ['model']);
        const untouched = await insertMember(org, [], ['tools']);

        await applyAll(versioned().filter((name) => name >= VERSION));

        expect(await setupOf(org, done)).toEqual({ setup_done: ['provider', 'tools'], setup_skipped: [] });
        expect(await setupOf(org, skipped)).toEqual({ setup_done: ['tools'], setup_skipped: ['provider'] });
        expect(await setupOf(org, untouched)).toEqual({ setup_done: [], setup_skipped: ['tools'] });

        const fresh = await insertMember(org, ['provider'], []);
        expect((await setupOf(org, fresh)).setup_done).toEqual(['provider']);
        await expect(
            pool`update org_membership set setup_done = array['model'] where org_id = ${org} and user_id = ${fresh}`
        ).rejects.toThrow(/check constraint/);
        await expect(
            pool`update org_membership set setup_skipped = array['model'] where org_id = ${org} and user_id = ${fresh}`
        ).rejects.toThrow(/check constraint/);
    });
});
