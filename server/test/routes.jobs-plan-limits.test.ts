import { ATTACHMENT_NAME_HEADER, OCTET_STREAM_CONTENT_TYPE } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AttachmentStore } from '../src/attachments/attachment-store.js';
import type { OrgRegistry } from '../src/orgs.js';
import type { JobActionStore } from '../src/db/jobs/job-store-action-types.js';
import type { JobReadStore } from '../src/db/jobs/job-store-reads.js';
import { PlanLimitError } from '../src/db/plan-limits.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import { githubAuth, jobStoreSlice, memoryAuthStore, signedIn, staticRegistry, testConfig } from './helpers.js';
import { trackApps } from './helpers-http.js';

/**
 * Offline: a create or upload the organization's plan refuses answers 429 `PLAN_LIMIT` naming the limit it hit.
 * Which the plan refuses is the store's (server/test-db/job-store.plan-limits.test.ts, plan-allowances.test.ts).
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

    it('answers 429 PLAN_LIMIT naming `tokens` once the period allowance is used', async () => {
        const auth = memoryAuthStore();
        const member = auth.seedMember('test-org', 'octocat');
        const jobs = jobStoreSlice<JobActionStore & JobReadStore>({
            async create() {
                throw new PlanLimitError('tokens', 5_000_000);
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
        expect(res.json()).toMatchObject({ code: 'PLAN_LIMIT', limit: 'tokens', max: 5_000_000 });
        expect(res.json().error).toMatch(/5000000 tokens its plan allows this period/);
    });
});

describe('POST /api/attachments past the plan', () => {
    it('answers 429 PLAN_LIMIT naming `storage` and the allowance', async () => {
        const auth = memoryAuthStore();
        const member = auth.seedMember('test-org', 'octocat');
        const config = testConfig({ auth: githubAuth() });
        const registry = staticRegistry({ config, repos: staticRepoSource([{ owner: 'acme', name: 'web' }]) });
        const attachments = {
            async upload() {
                throw new PlanLimitError('storage', 1024);
            },
        } as unknown as AttachmentStore;
        const orgs: OrgRegistry = {
            ...registry,
            for: async (id) => ({ ...(await registry.for(id))!, attachments }),
        };
        const app = track(await buildApp({ config, orgs, auth }));
        const res = await app.inject({
            method: 'POST',
            url: '/api/attachments',
            headers: {
                cookie: await signedIn(auth, member),
                'content-type': OCTET_STREAM_CONTENT_TYPE,
                [ATTACHMENT_NAME_HEADER]: 'note.txt',
            },
            payload: Buffer.from('hello'),
        });
        expect(res.statusCode).toBe(HTTP_TOO_MANY_REQUESTS);
        expect(res.json()).toMatchObject({ code: 'PLAN_LIMIT', limit: 'storage', max: 1024 });
        expect(res.json().error).toMatch(/1024 bytes of stored files and run logs/);
    });
});
