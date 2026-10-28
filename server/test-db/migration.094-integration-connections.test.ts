import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';
import { randomGithubId } from './fixtures.js';

/** BEL-59: 094 extends connector_connection in place, adds grants and bindings, and bridges old pods. */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '094_integration_connections.sql';
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

/** The pre-094 column set: exactly what connection-store.ts inserted before this change. */
const oldConnection = async (org: string, owner: string | null, email = 'agent@example.com'): Promise<string> => {
    const [row] = await pool<{ id: string }[]>`
        insert into connector_connection (org_id, owner_user_id, kind, site, cloud_id, email, api_token, access)
        values (${org}, ${owner}, 'jira', 'example.atlassian.net', ${`cloud-${randomUUID()}`}, ${email}, 'tok', 'write')
        returning id
    `;
    return row!.id;
};

/** The pre-094 job insert: a thread row, the root when `rootId` is omitted. */
const oldJob = async (
    org: string,
    createdBy: string | null,
    opts: { connection?: string | null; rootId?: string } = {}
): Promise<string> => {
    const id = randomUUID();
    await pool`
        insert into job (org_id, id, command, root_job_id, created_by, jira_connection_id)
        values (${org}, ${id}, 'work', ${opts.rootId ?? id}, ${createdBy}, ${opts.connection ?? null})
    `;
    return id;
};

describe.skipIf(!enabled)('094_integration_connections', () => {
    let org: string;
    let author: string;
    let personal: string;
    let shared: string;
    let boundRoot: string;
    let boundFollowUp: string;
    let plainRoot: string;

    it('upgrades a 093 database: backfills connections, execution users and migrated bindings', async () => {
        await applyAll(versioned(VERSION));
        org = await insertOrg();
        author = await insertUser();
        personal = await oldConnection(org, author);
        shared = await oldConnection(org, null, 'shared@example.com');
        boundRoot = await oldJob(org, author, { connection: personal });
        boundFollowUp = await oldJob(org, author, { rootId: boundRoot });
        plainRoot = await oldJob(org, author);

        await applyAll([VERSION]);
    });

    it('labels org-owned rows legacy and gives personal rows their owner as principal', async () => {
        const rows = await pool<
            {
                id: string;
                provider: string;
                credential: string;
                principal_user_id: string | null;
                external_account_id: string | null;
                status: string;
                grant_id: string | null;
            }[]
        >`select id, provider, credential, principal_user_id, external_account_id, status, grant_id
          from connector_connection where org_id = ${org}`;
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get(personal)).toMatchObject({
            provider: 'jira',
            credential: 'legacy_api_token',
            principal_user_id: author,
            external_account_id: 'agent@example.com',
            status: 'active',
            grant_id: null,
        });
        expect(byId.get(shared)).toMatchObject({
            credential: 'legacy_api_token',
            principal_user_id: null,
            external_account_id: 'shared@example.com',
        });
    });

    it('backfills execution_user_id = created_by on roots only', async () => {
        const rows = await pool<{ id: string; execution_user_id: string | null }[]>`
            select id, execution_user_id from job where org_id = ${org}
        `;
        const byId = new Map(rows.map((r) => [r.id, r.execution_user_id]));
        expect(byId.get(boundRoot)).toBe(author);
        expect(byId.get(plainRoot)).toBe(author);
        expect(byId.get(boundFollowUp)).toBeNull();
    });

    it('backfills a migrated binding per root with jira_connection_id, frozen from its connection', async () => {
        const bindings = await pool<
            {
                root_job_id: string;
                connection_id: string;
                revision: number;
                source: string;
                provider: string;
                credential: string;
                external_account_id: string;
                access: string;
            }[]
        >`select root_job_id, connection_id, revision, source, provider, credential, external_account_id, access
          from job_connection_binding where org_id = ${org}`;
        expect(bindings).toEqual([
            {
                root_job_id: boundRoot,
                connection_id: personal,
                revision: 1,
                source: 'migrated',
                provider: 'jira',
                credential: 'legacy_api_token',
                external_account_id: 'agent@example.com',
                access: 'write',
            },
        ]);
        const revisions = await pool<{ id: string; binding_revision: number }[]>`
            select id, binding_revision from job where org_id = ${org}
        `;
        const byId = new Map(revisions.map((r) => [r.id, r.binding_revision]));
        expect(byId.get(boundRoot)).toBe(1);
        expect(byId.get(boundFollowUp)).toBe(0);
        expect(byId.get(plainRoot)).toBe(0);
    });

    it('an old-pod root insert without execution_user_id is stamped from created_by', async () => {
        const id = await oldJob(org, author);
        const [row] = await pool<{ execution_user_id: string | null }[]>`
            select execution_user_id from job where org_id = ${org} and id = ${id}
        `;
        expect(row!.execution_user_id).toBe(author);
    });

    it('an old-pod root insert with jira_connection_id gets a migrated binding; a non-root insert gets none', async () => {
        const root = await oldJob(org, author, { connection: personal });
        const child = await oldJob(org, author, { rootId: root, connection: personal });
        const bindings = await pool<{ root_job_id: string; source: string; revision: number }[]>`
            select root_job_id, source, revision from job_connection_binding where org_id = ${org} and root_job_id in ${pool([root, child])}
        `;
        expect(bindings).toEqual([{ root_job_id: root, source: 'migrated', revision: 1 }]);
        const [row] = await pool<{ binding_revision: number }[]>`
            select binding_revision from job where org_id = ${org} and id = ${root}
        `;
        expect(row!.binding_revision).toBe(1);
    });

    it('an old-pod connection insert derives principal and account exactly as the backfill did', async () => {
        const mine = await oldConnection(org, author, 'late@example.com');
        const orgRow = await oldConnection(org, null, 'late-shared@example.com');
        const rows = await pool<
            { id: string; principal_user_id: string | null; external_account_id: string | null; credential: string }[]
        >`select id, principal_user_id, external_account_id, credential from connector_connection
          where id in ${pool([mine, orgRow])}`;
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get(mine)).toMatchObject({
            principal_user_id: author,
            external_account_id: 'late@example.com',
            credential: 'legacy_api_token',
        });
        expect(byId.get(orgRow)).toMatchObject({
            principal_user_id: null,
            external_account_id: 'late-shared@example.com',
            credential: 'legacy_api_token',
        });
    });

    it('execution_user_id cannot change once set', async () => {
        const other = await insertUser();
        await expect(
            pool`update job set execution_user_id = ${other} where org_id = ${org} and id = ${plainRoot}`
        ).rejects.toThrow(/execution_user_id/);
        const [row] = await pool<{ execution_user_id: string | null }[]>`
            select execution_user_id from job where org_id = ${org} and id = ${plainRoot}
        `;
        expect(row!.execution_user_id).toBe(author);
    });

    it('an old-pod hard delete of a bound connection keeps the binding row with connection_id null', async () => {
        await pool`delete from connector_connection where id = ${personal}`;
        const [row] = await pool<{ connection_id: string | null; external_account_id: string }[]>`
            select connection_id, external_account_id from job_connection_binding
            where org_id = ${org} and root_job_id = ${boundRoot}
        `;
        expect(row).toEqual({ connection_id: null, external_account_id: 'agent@example.com' });
    });

    it('allows a disconnected connection without a token, one open requirement per provider, and one grant per account', async () => {
        const conn = await oldConnection(org, author, 'soft@example.com');
        await pool`update connector_connection set api_token = null, status = 'disconnected', disconnected_at = now() where id = ${conn}`;

        await pool`insert into job_integration_requirement (org_id, root_job_id, provider, reason)
                   values (${org}, ${plainRoot}, 'jira', 'missing')`;
        await expect(
            pool`insert into job_integration_requirement (org_id, root_job_id, provider, reason)
                 values (${org}, ${plainRoot}, 'jira', 'ambiguous')`
        ).rejects.toThrow();

        const account = `acct-${randomUUID()}`;
        await pool`insert into integration_grant (org_id, principal_kind, principal_user_id, provider, external_account_id)
                   values (${org}, 'user', ${author}, 'jira', ${account})`;
        await expect(
            pool`insert into integration_grant (org_id, principal_kind, principal_user_id, provider, external_account_id)
                 values (${org}, 'user', ${author}, 'jira', ${account})`
        ).rejects.toThrow();
        await expect(
            pool`insert into integration_grant (org_id, principal_kind, provider, external_account_id)
                 values (${org}, 'user', 'jira', ${`acct-${randomUUID()}`})`
        ).rejects.toThrow();
    });
});
