import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { JobActionStore } from '../src/db/jobs/job-store-action-types.js';
import type { JobReadStore } from '../src/db/jobs/job-store-reads.js';
import { PlanLimitError } from '../src/db/plan-limits.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import { githubAuth, jobStoreSlice, memoryAuthStore, signedIn, staticRegistry, testConfig } from './helpers.js';
import { trackApps } from './helpers-http.js';

/**
 * Offline: a create the organization's plan refuses answers 429 `PLAN_LIMIT` naming the limit it hit. Which
 * create the plan refuses is the store's (server/test-db/job-store.plan-limits.test.ts).
 */

const track = trackApps();
const HTTP_TOO_MANY_REQUESTS = 429;

describe('POST /api/jobs past the plan', () => {
    it('answers 429 PLAN_LIMIT naming `queued` and the cap', async () => {
        const auth = memoryAuthStore();
        const member = auth.seedMember('test-org', 'octocat');
        const jobs = jobStoreSlice<JobActionStore & JobReadStore>({
            async create() {
                throw new PlanLimitError('queued', 10);
            },
        });
        const config = testConfig({ auth: githubAuth() });
        const app = await buildApp({
            config,
            orgs: staticRegistry({ config, repos: staticRepoSource([{ owner: 'acme', name: 'web' }]), jobs }),
            auth,
        });
        track(app);
        const res = await app.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: { cookie: await signedIn(auth, member) },
            payload: { repo: 'acme/web', command: 'one more' },
        });
        expect(res.statusCode).toBe(HTTP_TOO_MANY_REQUESTS);
        expect(res.json()).toMatchObject({ code: 'PLAN_LIMIT', limit: 'queued', max: 10 });
        expect(res.json().error).toMatch(/10 queued tasks/);
    });
});
