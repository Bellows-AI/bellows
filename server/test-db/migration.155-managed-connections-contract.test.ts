import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createAttemptOfLease } from '../src/db/attempt-of-lease.js';
import { bindingsOf, liveOAuthConnectionsOf } from '../src/db/connection-bindings.js';
import { createConnectionGrants } from '../src/db/connection-grants.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim } from '../src/db/jobs/job-store-types.js';
import { assertTestDatabase } from './harness.js';
import { randomGithubId } from './fixtures.js';

/**
 * 155 contracts the managed-connections model: it drops 094's rollout bridge (`job.jira_connection_id`,
 * `connector_connection.kind` and the `*_rollout_094` triggers) and tightens the execution-user rule, so a root's
 * `execution_user_id` never changes and only deleting the account nulls it.
 */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '155_managed_connections_contract.sql';
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

/** A user who is a claimed member of `org`: the attempt check requires the execution user's membership. */
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

const executionUserOf = async (id: string): Promise<string | null> => {
    const [row] = await pool<{ execution_user_id: string | null }[]>`
        select execution_user_id from job where id = ${id}
    `;
    return row!.execution_user_id;
};

/** A thread root inserted with exactly the columns named: no execution user unless `executionUser` is given. */
const insertRoot = async (org: string, author: string, executionUser?: string): Promise<string> => {
    const id = randomUUID();
    await pool`
        insert into job (org_id, id, command, root_job_id, created_by, execution_user_id)
        values (${org}, ${id}, 'work', ${id}, ${author}, ${executionUser ?? null})
    `;
    return id;
};

describe.skipIf(!enabled)('155_managed_connections_contract', () => {
    let org: string;
    let author: string;
    let other: string;
    let oauth: string;
    let mirroredRoot: string;
    let stampedRoot: string;

    it('upgrades a database that still carries the 094 bridge', async () => {
        await applyAll(versioned(VERSION));
        org = await insertOrg();
        author = await insertMember(org);
        other = await insertMember(org);
        const [conn] = await pool<{ id: string }[]>`
            insert into connector_connection
                (org_id, owner_user_id, kind, site, cloud_id, email, access, provider, credential,
                 principal_user_id, external_account_id)
            values (${org}, ${author}, 'jira', 'example.atlassian.net', ${`cloud-${randomUUID()}`},
                    'agent@example.com', 'read', 'jira', 'oauth_grant', ${author}, 'agent@example.com')
            returning id
        `;
        oauth = conn!.id;
        mirroredRoot = randomUUID();
        await pool`
            insert into job (org_id, id, command, root_job_id, created_by, jira_connection_id)
            values (${org}, ${mirroredRoot}, 'work', ${mirroredRoot}, ${author}, ${oauth})
        `;
        stampedRoot = randomUUID();
        await pool`
            insert into job (org_id, id, command, root_job_id, created_by)
            values (${org}, ${stampedRoot}, 'work', ${stampedRoot}, ${author})
        `;
        await applyAll(versioned().filter((name) => name >= VERSION));
    });

    it('drops job.jira_connection_id and connector_connection.kind', async () => {
        const columns = await pool<{ table_name: string; column_name: string }[]>`
            select table_name, column_name from information_schema.columns
            where table_schema = ${schema}
              and ((table_name = 'job' and column_name = 'jira_connection_id')
                or (table_name = 'connector_connection' and column_name = 'kind'))
        `;
        expect(columns).toEqual([]);
    });

    it('drops every rollout_094 trigger and function', async () => {
        const triggers = await pool<{ tgname: string }[]>`
            select t.tgname from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = ${schema} and t.tgname like '%rollout_094'
        `;
        expect(triggers).toEqual([]);
        const functions = await pool<{ proname: string }[]>`
            select p.proname from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = ${schema} and p.proname like '%rollout_094'
        `;
        expect(functions).toEqual([]);
    });

    it('keeps migrated bindings and stamped execution users', async () => {
        const bound = await bindingsOf(pool, org, mirroredRoot);
        expect(bound.map((b) => [b.connectionId, b.source])).toEqual([[oauth, 'migrated']]);
        expect(await executionUserOf(mirroredRoot)).toBe(author);
        expect(await executionUserOf(stampedRoot)).toBe(author);
    });

    it('a root inserted without execution_user_id is no longer stamped', async () => {
        expect(await executionUserOf(await insertRoot(org, author))).toBeNull();
    });

    it('execution_user_id cannot change to another user', async () => {
        const id = await insertRoot(org, author, author);
        await expect(pool`update job set execution_user_id = ${other} where id = ${id}`).rejects.toThrow(
            /execution_user_id/
        );
        expect(await executionUserOf(id)).toBe(author);
    });

    it('execution_user_id cannot be nulled while the account exists', async () => {
        const id = await insertRoot(org, author, author);
        await expect(pool`update job set execution_user_id = null where id = ${id}`).rejects.toThrow(
            /execution_user_id/
        );
        expect(await executionUserOf(id)).toBe(author);
    });

    it('a null execution_user_id cannot be set', async () => {
        const id = await insertRoot(org, author);
        await expect(pool`update job set execution_user_id = ${author} where id = ${id}`).rejects.toThrow(
            /execution_user_id/
        );
        expect(await executionUserOf(id)).toBeNull();
    });

    it('deleting the account nulls execution_user_id and keeps the job', async () => {
        const gone = await insertMember(org);
        const id = await insertRoot(org, gone, gone);
        await pool`delete from org_membership where user_id = ${gone}`;
        await pool`delete from app_user where id = ${gone}`;
        const rows = await pool<{ execution_user_id: string | null }[]>`
            select execution_user_id from job where id = ${id}
        `;
        expect(rows).toEqual([{ execution_user_id: null }]);
    });

    it('create, follow-up, claim and proxy work with bindings alone', async () => {
        // Park every root seeded above so the claims below take only this thread.
        await pool`update job set claim_deferred_until = now() + interval '1 hour' where org_id = ${org}`;
        const grants = createConnectionGrants({ sql: pool, orgId: org });
        const attach = async (): Promise<string> => {
            const result = await grants.attachGrantConnection({
                principal: { kind: 'user', userId: author },
                provider: 'jira',
                externalAccountId: `acct-${randomUUID()}`,
                authority: { scopes: ['read:jira-work'] },
                resource: { id: `cloud-${randomUUID()}`, label: 'example.atlassian.net' },
                access: 'read',
            });
            if (!result.ok) throw new Error(`attach refused: ${result.reason}`);
            return result.connectionId;
        };
        const c1 = await attach();
        const c2 = await attach();

        const store = createJobStore({ sql: pool, orgId: org });
        const created = await store.create('do the work', author, {
            repo: null,
            executor: null,
            connectionIds: [c1],
        });
        if (typeof created === 'string') throw new Error(created);
        const root = created.id;
        expect((await bindingsOf(pool, org, root)).map((b) => b.connectionId)).toEqual([c1]);

        const first = (await store.claim('worker-1', 60)) as Claim | null;
        expect(first?.id).toBe(root);
        await store.complete(root, first!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });

        const followUp = await store.createFollowUp(root, 'and more', author, undefined, [c2]);
        if (typeof followUp === 'string') throw new Error(followUp);
        const second = (await store.claim('worker-1', 60)) as Claim | null;
        expect(second?.id).toBe(followUp.id);

        const attempt = await createAttemptOfLease({ sql: pool })(followUp.id, second!.leaseToken);
        expect(attempt).toMatchObject({ ok: true, rootJobId: root, executionUserId: author });
        const live = await liveOAuthConnectionsOf(pool, org, root);
        expect(live.map((c) => c.id).sort()).toEqual([c1, c2].sort());
    });
});
