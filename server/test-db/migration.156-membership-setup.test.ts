import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';
import { randomGithubId } from './fixtures.js';

/**
 * 156 records onboarding setup state on `org_membership`: a membership that exists when it ships is an existing member
 * and reads completed; one created after it starts with nothing done, nothing skipped and no completion.
 */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '156_membership_setup.sql';
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

const insertMember = async (org: string): Promise<string> => {
    const login = `u-${randomUUID()}`;
    const [row] = await pool<{ id: string }[]>`
        insert into app_user (github_user_id, github_login) values (${randomGithubId()}, ${login})
        returning id
    `;
    await pool`
        insert into org_membership (org_id, github_login, user_id, claimed_at)
        values (${org}, ${login}, ${row!.id}, now())
    `;
    return row!.id;
};

interface SetupRow {
    setup_completed_at: Date | null;
    setup_done: string[];
    setup_skipped: string[];
}

const setupOf = async (org: string, userId: string): Promise<SetupRow> => {
    const [row] = await pool<SetupRow[]>`
        select setup_completed_at, setup_done, setup_skipped from org_membership
        where org_id = ${org} and user_id = ${userId}
    `;
    return row!;
};

describe.runIf(enabled)('156: setup state per membership', () => {
    let org: string;
    let existing: string;

    it('backfills a membership that exists before it as completed', async () => {
        await applyAll(versioned(VERSION));
        org = `o${randomUUID().replaceAll('-', '').slice(0, 30)}`;
        await pool`insert into organization (id, name) values (${org}, ${org})`;
        existing = await insertMember(org);

        await applyAll(versioned().filter((name) => name >= VERSION));

        const row = await setupOf(org, existing);
        expect(row.setup_completed_at).not.toBeNull();
        expect(row.setup_done).toEqual([]);
        expect(row.setup_skipped).toEqual([]);
    });

    it('starts a membership created after it with nothing done, skipped or completed', async () => {
        const fresh = await insertMember(org);
        expect(await setupOf(org, fresh)).toEqual({ setup_completed_at: null, setup_done: [], setup_skipped: [] });
    });

    it('refuses a step outside model and tools', async () => {
        await expect(
            pool`update org_membership set setup_done = array['repos'] where org_id = ${org} and user_id = ${existing}`
        ).rejects.toThrow(/check constraint/);
        await expect(
            pool`update org_membership set setup_skipped = array['x'] where org_id = ${org} and user_id = ${existing}`
        ).rejects.toThrow(/check constraint/);
    });
});
