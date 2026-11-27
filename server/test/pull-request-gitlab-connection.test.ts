import { parseRepoRef, type RepoRef } from '@factory-ai/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ForgeConnectionStore } from '../src/db/forge-connections.js';
import type { PrWriteStore } from '../src/db/jobs/job-store-pr-write.js';
import type { GitlabAccess } from '../src/forge/forge-gate.js';
import type { GitlabApi } from '../src/gitlab/gitlab-api.js';
import { pullRequestRoutes } from '../src/routes/jobs/job-handlers-pull-request.js';
import { jobStoreSlice, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';

/**
 * The GitLab connection read behind the publish route (`sourceOf`): every way it is not confirmed is a 503 under the
 * call's one deadline, with no wait opened and no GitLab request made. The grant has already said live.
 */
const ID = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const REPO = parseRepoRef('gitlab:board.gitlab.test/grp/sub/web') as RepoRef;
const ASK = { leaseToken: LEASE, branch: 'task/one', base: 'main' };
const DEADLINE_MS = 100;
const UNAVAILABLE = 503;

const apps: FastifyInstance[] = [];
afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function post(connectionsOf: GitlabAccess['connectionsOf'] | null) {
    const requests: string[] = [];
    const waits: string[] = [];
    const api = {
        request: async () => {
            requests.push('request');
            throw new Error('GitLab must not be reached');
        },
    } as unknown as GitlabApi;
    const config = testConfig();
    const jobs = jobStoreSlice<PrWriteStore>({
        prWriteContext: async () => ({
            result: 'ok',
            orgId: 'org-1',
            rootJobId: ID,
            repo: REPO,
            rootRepo: REPO,
            executionUserId: 'user-1',
        }),
        openPrForgeWait: async () => {
            waits.push('wait');
            return { result: 'ok' };
        },
        closePrForgeWait: async () => {},
    });
    const app = Fastify();
    apps.push(app);
    app.decorateRequest('closing', { getter: () => new AbortController().signal });
    pullRequestRoutes(app, staticRegistry({ config, jobs, telemetry: stubTelemetryClient() }), {
        tokens: async () => ({ ok: true, token: 'member-token', as: 'user' }),
        forge: {},
        ...(connectionsOf === null ? {} : { gitlab: { connectionsOf, api } }),
        deadlineMs: DEADLINE_MS,
    });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${ID}/pull-request`, payload: ASK });
    return { res, requests, waits };
}

const store = (application: ForgeConnectionStore['application']) =>
    ({ application }) as unknown as ForgeConnectionStore;
const never = () => new Promise<never>(() => {});

describe('the publish route’s GitLab connection read', () => {
    it.each([
        ['no connection store', async () => undefined],
        ['no connection on the host', async () => store(async () => null)],
        [
            'a connection no longer active',
            async () => store(async () => ({ active: false, caBundle: undefined }) as never),
        ],
        ['a store read that throws', async () => store(async () => Promise.reject(new Error('db down')))],
        ['a store lookup that throws', async () => Promise.reject(new Error('registry down'))],
    ])('answers 503 for %s: no wait, no GitLab call', async (_label, connectionsOf) => {
        const { res, requests, waits } = await post(connectionsOf);
        expect(res.statusCode).toBe(UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'UNAVAILABLE' });
        expect(requests).toEqual([]);
        expect(waits).toEqual([]);
    });

    it.each([
        ['the store lookup', never],
        ['the connection read', async () => store(never)],
    ])('answers 503 within the call’s deadline when %s never resolves', async (_label, connectionsOf) => {
        const started = Date.now();
        const { res, requests, waits } = await post(connectionsOf);
        expect(res.statusCode).toBe(UNAVAILABLE);
        expect(Date.now() - started).toBeLessThan(DEADLINE_MS * 20);
        expect(requests).toEqual([]);
        expect(waits).toEqual([]);
    });

    it('answers 409 with no GitLab access wired: no grant read, no wait, no GitLab call', async () => {
        const { res, requests, waits } = await post(null);
        expect(res.statusCode).toBe(409);
        expect(requests).toEqual([]);
        expect(waits).toEqual([]);
    });
});
