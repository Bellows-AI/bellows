import { beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { useTestDb } from './harness.js';
import { account, craftJob, randomGithubId, testOrg } from './fixtures.js';

/** the claim names the member who started the thread as the commit author, never the bot. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const WORKER = 'author-claimer';
const LEASE_SECONDS = 300;

const db = useTestDb({ max: 4, orgs: [ORG] });
let sql: Sql;

beforeEach(() => {
    if (!enabled) return;
    sql = db.sql;
});

describe.skipIf(!enabled)('claim author', () => {
    it('names the root starter: display name, github-id noreply email', async () => {
        const githubId = randomGithubId();
        const member = await account(sql, githubId, 'octo-member');
        await sql`update app_user set display_name = 'Octo Member' where id = ${member}`;
        await craftJob({ sql, org: ORG, author: member });
        const claim = await createJobStore({ sql, orgId: ORG, commitAuthor: true }).claim(WORKER, LEASE_SECONDS);
        expect(claim?.author).toEqual({
            name: 'Octo Member',
            email: `${githubId}+octo-member@users.noreply.github.com`,
        });
    });

    it('falls back to the login when there is no display name', async () => {
        const githubId = randomGithubId();
        const member = await account(sql, githubId, 'login-only');
        await craftJob({ sql, org: ORG, author: member });
        const claim = await createJobStore({ sql, orgId: ORG, commitAuthor: true }).claim(WORKER, LEASE_SECONDS);
        expect(claim?.author).toEqual({ name: 'login-only', email: `${githubId}+login-only@users.noreply.github.com` });
    });

    it('is absent when the deployment does not attribute commits (AUTH_MODE=none)', async () => {
        const member = await account(sql, randomGithubId(), 'local-member');
        await craftJob({ sql, org: ORG, author: member });
        const claim = await createJobStore({ sql, orgId: ORG }).claim(WORKER, LEASE_SECONDS);
        expect(claim?.id).toBeDefined();
        expect(claim?.author).toBeUndefined();
    });

    it('is absent for an unattributed job', async () => {
        await craftJob({ sql, org: ORG, author: '' }, { author: null });
        const claim = await createJobStore({ sql, orgId: ORG, commitAuthor: true }).claim(WORKER, LEASE_SECONDS);
        expect(claim?.id).toBeDefined();
        expect(claim?.author).toBeUndefined();
    });
});
