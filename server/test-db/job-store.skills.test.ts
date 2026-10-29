import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { requirementsOf } from '../src/db/connection-bindings.js';
import { expireLease, oauthConnection, testOrg, testUser } from './fixtures.js';

/**
 * Issue 545: a task selects skills at creation; the selection lives on the root row, every claim of
 * the thread (retry, follow-up, reclaim) reads it, and the claim refuses — by name, never by value —
 * a selection whose connection the task does not carry: env names for GitHub, the selected managed
 * connection for Jira (docs/connections.md).
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const WORKER = 'worker-1';
const LEASE_SECONDS = 60;
const USER = testUser('skills-user');
const db = useTestDb({ orgs: [ORG], users: [USER], max: 8 });

const PLAIN_ENV = { PLAIN: 'plain-sentinel' };

let sql: Sql;
let plain: JobStore;

/**
 * A store whose claim resolves exactly `env` for every job, the board's stacked env in miniature —
 * on an org holding a GitHub App installation (`githubApp`) unless told otherwise.
 */
const storeWithEnv = (env: Record<string, string>, githubApp = true): JobStore =>
    createJobStore({ sql, orgId: ORG, env: { resolveFor: async () => ({ ...env }) }, githubApp });

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    plain = createJobStore({ sql, orgId: ORG });
});

/** The author's own managed Jira connection (097); its id is the explicit selection (BEL-59: a binding). */
async function jiraConnection(): Promise<string> {
    return (await oauthConnection(sql, ORG, USER.id, { account: 'agent@example.com' })).id;
}

async function queue(store: JobStore, skills?: string[], connectionId?: string): Promise<string> {
    const created = await store.create('do the work', connectionId ? USER.id : null, {
        repo: null,
        executor: null,
        ...(skills ? { skills } : {}),
        ...(connectionId ? { connectionIds: [connectionId] } : {}),
    });
    if (typeof created === 'string') throw new Error(created);
    return created.id;
}

async function claim(store: JobStore): Promise<Claim> {
    const claimed = (await store.claim(WORKER, LEASE_SECONDS)) as Claim | null;
    expect(claimed).not.toBeNull();
    return claimed!;
}

describe.skipIf(!enabled)('skill selection — database', () => {
    it('stores the selection on the root and hands the claim a prompt naming it', async () => {
        const store = storeWithEnv(PLAIN_ENV);
        const id = await queue(store, ['jira', 'gates'], await jiraConnection());
        const [row] = await sql<{ skills: string[] }[]>`select skills from job where id = ${id}`;
        expect(row?.skills).toEqual(['jira', 'gates']);

        const claimed = await claim(store);
        expect(claimed.skillRefusal).toBeNull();
        expect(claimed.masterPrompt).toContain('- Selected skills: jira, gates');
    });

    it('a task with no skills renders no line and has no refusal', async () => {
        await queue(plain);
        const claimed = await claim(plain);
        expect(claimed.skillRefusal).toBeNull();
        expect(claimed.masterPrompt).not.toContain('Selected skills');
    });

    it('a Jira skill with a live binding has no refusal', async () => {
        const store = storeWithEnv({ ATLASSIAN_SITE: 'site-sentinel' });
        await queue(store, ['jira'], await jiraConnection());
        const claimed = await claim(store);
        expect(claimed.skillRefusal).toBeNull();
    });

    it('a Jira skill on a task with no connection is not claimed: a missing requirement, no refusal text', async () => {
        // ATLASSIAN_* env never stands in for a connection (BEL-59: the claim excludes it, spending no attempt).
        const store = storeWithEnv({ ATLASSIAN_SITE: 'site-sentinel' });
        const id = await queue(store, ['jira']);
        expect(await store.claim(WORKER, LEASE_SECONDS)).toBeNull();
        expect((await requirementsOf(sql, ORG, id)).map((r) => [r.provider, r.reason])).toEqual([['jira', 'missing']]);
        const [row] = await sql<{ attempts: number }[]>`select attempts from job where id = ${id}`;
        expect(row?.attempts).toBe(0);
    });

    it('refuses the github connection on an org with no App installation, naming no value', async () => {
        // A member token cannot stand in: GitHub is the App's (docs/connections.md).
        const store = storeWithEnv({ OTHER: 'other-sentinel', GITHUB_TOKEN: 'pat-sentinel' }, false);
        await queue(store, ['github']);

        const claimed = await claim(store);
        expect(claimed.skillRefusal).toContain('install the GitHub App on this organization');
        expect(claimed.skillRefusal).not.toContain('other-sentinel');
        expect(claimed.skillRefusal).not.toContain('pat-sentinel');
    });

    it('refuses the github connection on a board that resolves no environment and holds no App', async () => {
        await queue(plain, ['github']);
        expect((await claim(plain)).skillRefusal).toContain('install the GitHub App');
    });

    it('selecting a skill never changes the claim env', async () => {
        const store = storeWithEnv(PLAIN_ENV);
        await queue(store);
        const without = (await claim(store)).env;
        await sql`delete from job`;
        await queue(store, ['jira', 'github', 'gates'], await jiraConnection());
        const withSkills = (await claim(store)).env;
        expect(withSkills).toEqual(without);
        expect(withSkills).toEqual(PLAIN_ENV);
    });

    it('refuses a stored name the catalog no longer has, listing what is installed', async () => {
        const id = await queue(plain);
        await sql`update job set skills = ${sql.array(['retired-skill'])}::text[] where id = ${id}`;
        const refusal = (await claim(plain)).skillRefusal;
        expect(refusal).toContain('skill "retired-skill" is not installed');
        expect(refusal).toContain('installed: ');
    });

    it('a retry keeps the root selection and sees the same refusal until the App is installed', async () => {
        const broken = storeWithEnv({}, false);
        const root = await queue(broken, ['github']);
        const first = await claim(broken);
        expect(first.skillRefusal).not.toBeNull();
        await broken.complete(first.id, first.leaseToken, {
            status: 'failed',
            exitCode: null,
            output: first.skillRefusal!,
            failureKind: 'config',
        });

        const retry = await broken.createRetry(root, null);
        if (typeof retry === 'string') throw new Error(`retry refused: ${retry}`);
        const [retryRow] = await sql<{ skills: string[] }[]>`select skills from job where id = ${retry.id}`;
        // The root decides: the retry row itself carries the default, and its claim reads the root.
        expect(retryRow?.skills).toEqual([]);

        const stillBroken = await claim(broken);
        expect(stillBroken.id).toBe(retry.id);
        expect(stillBroken.skillRefusal).toContain('install the GitHub App');
        expect(stillBroken.masterPrompt).toContain('- Selected skills: github');

        // The App is installed: a fresh retry now runs, with the same prompt.
        await broken.complete(stillBroken.id, stillBroken.leaseToken, {
            status: 'failed',
            exitCode: null,
            output: 'x',
            failureKind: 'config',
        });
        const fixed = storeWithEnv(PLAIN_ENV);
        const again = await fixed.createRetry(root, null);
        if (typeof again === 'string') throw new Error(`retry refused: ${again}`);
        const ok = await claim(fixed);
        expect(ok.skillRefusal).toBeNull();
        expect(ok.masterPrompt).toBe(first.masterPrompt);
    });

    it('a retry of a Jira task still sees the root’s connection, so its claim passes', async () => {
        const store = plain;
        const root = await queue(store, ['jira'], await jiraConnection());
        const first = await claim(store);
        expect(first.skillRefusal).toBeNull();
        await store.complete(first.id, first.leaseToken, { status: 'failed', exitCode: 1, output: 'red' });

        const retry = await store.createRetry(root, USER.id);
        if (typeof retry === 'string') throw new Error(`retry refused: ${retry}`);
        const [counted] = await sql<{ n: number }[]>`
            select count(*)::int as n from job_connection_binding where root_job_id = ${retry.id}`;
        // Only the root carries the bindings; the retry's claim reads them from there.
        expect(counted?.n).toBe(0);
        expect((await claim(store)).skillRefusal).toBeNull();
    });

    it('a follow-up claims with the root selection', async () => {
        const store = storeWithEnv(PLAIN_ENV);
        const root = await queue(store, ['gates']);
        const first = await claim(store);
        await store.session(first.id, first.leaseToken, randomUUID());
        await store.complete(first.id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });

        const followUp = await store.createFollowUp(root, 'and also this', null);
        if (typeof followUp === 'string') throw new Error(`follow-up refused: ${followUp}`);
        const claimed = await claim(store);
        expect(claimed.id).toBe(followUp.id);
        expect(claimed.masterPrompt).toBe(first.masterPrompt);
        expect(claimed.masterPrompt).toContain('- Selected skills: gates');
    });

    it('an expired-lease reclaim of the same row still carries the selection', async () => {
        const store = storeWithEnv(PLAIN_ENV);
        const id = await queue(store, ['github']);
        const first = await claim(store);
        await expireLease(sql, id);

        const second = await claim(store);
        expect(second.id).toBe(id);
        expect(second.claimSeq).toBe(first.claimSeq + 1);
        expect(second.masterPrompt).toBe(first.masterPrompt);
        expect(second.masterPrompt).toContain('- Selected skills: github');
    });
});
