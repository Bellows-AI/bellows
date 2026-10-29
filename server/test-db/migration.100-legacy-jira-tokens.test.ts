import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { assertTestDatabase } from './harness.js';
import { randomGithubId } from './fixtures.js';

/**
 * BEL-61: 100 ends the legacy Jira API-token connections. A database that ran 099 holds active legacy rows with
 * their tokens, bindings to them and queued tasks waiting on them; 100 disconnects the rows, scrubs the tokens,
 * clears the rollout projection and leaves each queued task as an open requirement the claim never offers.
 */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '100_legacy_jira_tokens.sql';
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

const connection = async (
    org: string,
    owner: string | null,
    credential: 'legacy_api_token' | 'oauth_grant',
    status: 'active' | 'disconnected' = 'active'
): Promise<string> => {
    const [row] = await pool<{ id: string }[]>`
        insert into connector_connection
            (org_id, owner_user_id, kind, site, cloud_id, email, api_token, access, provider, credential,
             principal_user_id, external_account_id, status)
        values (${org}, ${owner}, 'jira', 'example.atlassian.net', ${`cloud-${randomUUID()}`}, 'agent@example.com',
                ${credential === 'legacy_api_token' ? 'legacy-secret-token' : null}, 'read', 'jira', ${credential},
                ${owner}, 'agent@example.com', ${status})
        returning id
    `;
    return row!.id;
};

/** A thread root; naming `connection` selects it the way an old pod does (the 094 trigger mirrors a binding). */
const root = async (
    org: string,
    author: string,
    opts: { connection?: string; status?: 'queued' | 'running' } = {}
): Promise<string> => {
    const id = randomUUID();
    await pool`
        insert into job (org_id, id, command, root_job_id, created_by, status, jira_connection_id)
        values (${org}, ${id}, 'work', ${id}, ${author}, ${opts.status ?? 'queued'}, ${opts.connection ?? null})
    `;
    return id;
};

const openRequirements = async (org: string, rootId: string) =>
    pool<{ provider: string; reason: string }[]>`
        select provider, reason from job_integration_requirement
        where org_id = ${org} and root_job_id = ${rootId} and satisfied_at is null
    `;

describe.skipIf(!enabled)('100_legacy_jira_tokens', () => {
    let org: string;
    let author: string;
    let legacyPersonal: string;
    let legacyOrgWide: string;
    let legacyGone: string;
    let oauth: string;
    let queuedLegacy: string;
    let queuedOrgWide: string;
    let runningLegacy: string;
    let queuedOauth: string;
    let followUp: string;
    let alreadyWaiting: string;

    it('upgrades a 099 database', async () => {
        await applyAll(versioned(VERSION));
        org = await insertOrg();
        author = await insertUser();
        legacyPersonal = await connection(org, author, 'legacy_api_token');
        legacyOrgWide = await connection(org, null, 'legacy_api_token');
        legacyGone = await connection(org, author, 'legacy_api_token', 'disconnected');
        await pool`update connector_connection set api_token = 'residual-token' where id = ${legacyGone}`;
        oauth = await connection(org, author, 'oauth_grant');
        queuedLegacy = await root(org, author, { connection: legacyPersonal });
        queuedOrgWide = await root(org, author, { connection: legacyOrgWide });
        runningLegacy = await root(org, author, { connection: legacyPersonal, status: 'running' });
        queuedOauth = await root(org, author, { connection: oauth });
        alreadyWaiting = await root(org, author, { connection: legacyPersonal });
        await pool`
            insert into job_integration_requirement (org_id, root_job_id, provider, reason)
            values (${org}, ${alreadyWaiting}, 'jira', 'missing')
        `;
        followUp = randomUUID();
        await pool`
            insert into job (org_id, id, command, root_job_id, parent_job_id, created_by)
            values (${org}, ${followUp}, 'more', ${queuedLegacy}, ${queuedLegacy}, ${author})
        `;
        await applyAll([VERSION]);
    });

    it('80: disconnects every active legacy row and nulls every legacy api_token; oauth rows untouched', async () => {
        const rows = await pool<
            { id: string; status: string; api_token: string | null; disconnected_at: Date | null }[]
        >`
            select id, status, api_token, disconnected_at from connector_connection where org_id = ${org}
        `;
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const id of [legacyPersonal, legacyOrgWide]) {
            expect(byId.get(id)).toMatchObject({ status: 'disconnected', api_token: null });
            expect(byId.get(id)!.disconnected_at).not.toBeNull();
        }
        expect(byId.get(legacyGone)).toMatchObject({ status: 'disconnected', api_token: null });
        expect(byId.get(oauth)).toMatchObject({ status: 'active', api_token: null });
        expect(byId.get(oauth)!.disconnected_at).toBeNull();
        const left =
            await pool`select 1 from connector_connection where credential = 'legacy_api_token' and api_token is not null`;
        expect(left).toHaveLength(0);
    });

    it('81: a queued root with a live legacy binding gets one open jira requirement; a running root gets none; an oauth root gets none', async () => {
        expect(await openRequirements(org, queuedLegacy)).toEqual([{ provider: 'jira', reason: 'missing' }]);
        expect(await openRequirements(org, queuedOrgWide)).toEqual([{ provider: 'jira', reason: 'missing' }]);
        expect(await openRequirements(org, alreadyWaiting)).toEqual([{ provider: 'jira', reason: 'missing' }]);
        expect(await openRequirements(org, runningLegacy)).toEqual([]);
        expect(await openRequirements(org, queuedOauth)).toEqual([]);
        expect(await openRequirements(org, followUp)).toEqual([]);
    });

    it('82: job.jira_connection_id pointing at a legacy row is nulled; an oauth one is kept', async () => {
        const rows = await pool<{ id: string; jira_connection_id: string | null }[]>`
            select id, jira_connection_id from job where org_id = ${org} and id in ${pool([
                queuedLegacy,
                queuedOrgWide,
                runningLegacy,
                queuedOauth,
            ])}
        `;
        const byId = new Map(rows.map((r) => [r.id, r.jira_connection_id]));
        expect(byId.get(queuedLegacy)).toBeNull();
        expect(byId.get(queuedOrgWide)).toBeNull();
        expect(byId.get(runningLegacy)).toBeNull();
        expect(byId.get(queuedOauth)).toBe(oauth);
    });

    it('83: the claim does not offer that queued root and spends no attempt', async () => {
        // Only the roots the migration left waiting are in play: park the others.
        const parked = [queuedOrgWide, runningLegacy, queuedOauth, alreadyWaiting, followUp];
        await pool`update job set claim_deferred_until = now() + interval '1 hour' where id in ${pool(parked)}`;
        const claimed = await createJobStore({ sql: pool, orgId: org }).claim('worker-1', 60);
        expect(claimed).toBeNull();
        const [row] = await pool<{ attempts: number; status: string }[]>`
            select attempts, status from job where id = ${queuedLegacy}
        `;
        expect(row).toEqual({ attempts: 0, status: 'queued' });
    });

    it('a second run changes nothing', async () => {
        await pool.unsafe(readFileSync(new URL(VERSION, DIR), 'utf8'));
        expect(await openRequirements(org, queuedLegacy)).toEqual([{ provider: 'jira', reason: 'missing' }]);
        const [counted] = await pool<{ n: number }[]>`
            select count(*)::int as n from job_integration_requirement where org_id = ${org}
        `;
        expect(counted!.n).toBe(3);
    });
});
