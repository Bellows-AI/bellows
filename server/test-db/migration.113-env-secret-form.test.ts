import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createEnvVarStore } from '../src/db/env-var-store.js';
import { encodeEnvSecret, envSecretIdentity } from '../src/db/env-secrets.js';
import { migrate } from '../src/db/migrate.js';
import { createSecretRef } from '../src/secrets/secret-input.js';
import { seedEncryptedRow, testSecretStore } from './env-secrets-harness.js';
import { assertTestDatabase } from './harness.js';
import { randomGithubId } from './fixtures.js';

/**
 * BEL-150: 113 is the contract for 093. A database still holding a plaintext secret refuses it, naming the
 * conversion command; once every secret is a store reference it applies, and the row admits only the two forms.
 */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '113_env_var_secret_form.sql';
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

const versioned = (below: string): string[] =>
    readdirSync(DIR)
        .filter((name) => name.endsWith('.sql') && !name.endsWith('.repeatable.sql') && name < below)
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

const constraintExists = async (): Promise<boolean> => {
    const rows = await pool`
        select 1 from pg_constraint c join pg_namespace n on n.oid = c.connamespace
        where n.nspname = ${schema} and c.conname = 'env_var_secret_form_ck'
    `;
    return rows.length > 0;
};

const applied = async (): Promise<boolean> =>
    (await pool`select 1 from schema_migrations where version = ${VERSION}`).length > 0;

const rejection = async (p: Promise<unknown>): Promise<Error> => {
    try {
        await p;
    } catch (error) {
        return error as Error;
    }
    throw new Error('expected a rejection');
};

describe.skipIf(!enabled)('113_env_var_secret_form', () => {
    let org: string;
    let user: string;
    let secrets: ReturnType<typeof testSecretStore>;
    const oversized = 'x'.repeat(32769);

    it('refuses an older database holding plaintext secret rows, naming the conversion command', async () => {
        await applyAll(versioned(VERSION));
        org = await insertOrg();
        user = await insertUser();
        secrets = testSecretStore(pool);
        await pool`insert into env_var (org_id, name, value, is_secret) values (${org}, 'PLAIN_ORG', 'plain-org', true)`;
        await pool`
            insert into env_var (org_id, user_id, name, value, is_secret)
            values (${org}, ${user}, 'BIG', ${oversized}, true)
        `;
        await pool`insert into env_var (org_id, name, value, is_secret) values (${org}, 'VISIBLE', 'v', false)`;
        await seedEncryptedRow(pool, secrets, { orgId: org, scope: { kind: 'org' }, name: 'SEALED' }, 's');

        const error = await rejection(pool.unsafe(readFileSync(new URL(VERSION, DIR), 'utf8')));
        expect(error.message).toMatch(/npm run secrets:convert-env/);
        expect(error.message).toMatch(/2 plaintext/);
        expect(error.message).toMatch(/1 over 32768/);
        expect(error.message).not.toContain('plain-org');
        expect(await constraintExists()).toBe(false);
        const rows = await pool<{ name: string; value: string }[]>`
            select name, value from env_var where org_id = ${org} and is_secret and secret_ref is null order by name
        `;
        expect(rows).toEqual([
            { name: 'BIG', value: oversized },
            { name: 'PLAIN_ORG', value: 'plain-org' },
        ]);
    });

    it('the migration runner refuses the same way and records nothing', async () => {
        const error = await rejection(migrate(pool, { attempts: 1, log: () => {} }));
        expect(error.message).toMatch(/secrets:convert-env/);
        expect(await applied()).toBe(false);
        expect(await constraintExists()).toBe(false);
    });

    it('applies once every secret is in the store and the claim resolves it', async () => {
        // The conversion: a store record, then the row rewritten in place to hold only its reference.
        const ref = createSecretRef();
        const made = await secrets.create({
            identity: envSecretIdentity(org, { kind: 'org' }, 'PLAIN_ORG'),
            ref,
            operationId: await secrets.issueOperationId(),
            payload: encodeEnvSecret('plain-org'),
        });
        if (!made.ok) throw new Error(`create refused: ${made.error.code}`);
        await pool`
            update env_var set value = null, secret_ref = ${ref}, secret_version = ${made.version}
            where org_id = ${org} and name = 'PLAIN_ORG' and is_secret and secret_ref is null
        `;
        // An oversized value the store refuses: a member re-enters it.
        await pool`delete from env_var where org_id = ${org} and name = 'BIG'`;
        await seedEncryptedRow(
            pool,
            secrets,
            { orgId: org, scope: { kind: 'workspace', userId: user }, name: 'BIG' },
            're-entered'
        );

        await migrate(pool, { attempts: 1, log: () => {} });
        expect(await applied()).toBe(true);
        expect(await constraintExists()).toBe(true);
        const store = createEnvVarStore({ sql: pool, orgId: org, secrets, secretLog: () => {} });
        expect(await store.resolveFor({ userId: user, repo: null })).toEqual({
            PLAIN_ORG: 'plain-org',
            BIG: 're-entered',
            VISIBLE: 'v',
            SEALED: 's',
        });
    });

    it.each([
        ['a plaintext secret', `true, 'leak', null, null`],
        ['a secret with no reference and no value', `true, null, null, null`],
        ['a secret holding both a reference and a value', `true, 'leak', 'REF', 'v1'`],
        ['a secret with a reference and no version', `true, null, 'REF', null`],
        ['a non-secret with no value', `false, null, null, null`],
        ['a non-secret holding a reference', `false, 'v', 'REF', null`],
    ])('after 113 the row refuses %s', async (_label, values) => {
        const error = await rejection(
            pool.unsafe(
                `insert into env_var (org_id, name, is_secret, value, secret_ref, secret_version)
                 values ($1, $2, ${values.replaceAll('REF', createSecretRef())})`,
                [org, `BAD_${randomUUID().slice(0, 8)}`]
            )
        );
        expect(error.message).toMatch(/env_var_secret_form_ck/);
    });

    it('after 113 the two stored forms still insert', async () => {
        await pool`insert into env_var (org_id, name, value, is_secret) values (${org}, 'PLAIN_OK', 'ok', false)`;
        await seedEncryptedRow(pool, secrets, { orgId: org, scope: { kind: 'org' }, name: 'SEALED_OK' }, 'k');
        expect(await constraintExists()).toBe(true);
    });
});
