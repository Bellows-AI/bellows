import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AgentTitle, AgentTitleResult } from '../src/db/agent-title.js';
import type { AttemptCheck, AttemptOfLease } from '../src/db/attempt-of-lease.js';
import { githubAuth, memoryAuthStore, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_FORBIDDEN,
    HTTP_OK,
    HTTP_SERVICE_UNAVAILABLE,
    HTTP_UNAUTHORIZED,
    trackApps,
} from './helpers-http.js';

/**
 * Offline: the agent title route's HTTP contract (BEL-252; docs/connections.md) against stub checks and a stub
 * store. The SQL and its locks are pinned by server/test-db/agent-title.test.ts.
 */
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const ROOT_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = '66666666-6666-4666-8666-666666666666';
const URL = `/api/jobs/${JOB_ID}/agent-title`;
const PAIR = { 'x-factory-job-id': JOB_ID, 'x-factory-job-lease-token': LEASE };
const HTTP_TOO_MANY = 429;

const LIVE: AttemptCheck = {
    ok: true,
    orgId: 'local',
    jobId: JOB_ID,
    rootJobId: ROOT_ID,
    repo: null,
    rootRepo: null,
    executionUserId: USER_ID,
    claimSeq: 2,
};

const track = trackApps();

interface Boot {
    attempt?: AttemptCheck | (() => never);
    store?: AgentTitleResult | (() => never);
}

async function boot(over: Boot = {}) {
    const calls: Record<string, unknown>[] = [];
    const attemptOfLease: AttemptOfLease = async () =>
        typeof over.attempt === 'function' ? over.attempt() : (over.attempt ?? LIVE);
    const agentTitle: AgentTitle = async (input) => {
        calls.push({ ...input });
        const answer = over.store ?? { ok: true, title: input.title, updated: true, version: 1 };
        return typeof answer === 'function' ? answer() : answer;
    };
    const config = testConfig({ auth: githubAuth() });
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
        auth: memoryAuthStore(),
        attemptOfLease,
        agentTitle,
        logger: false,
    });
    track(app);
    return { app, calls };
}

const post = (app: Awaited<ReturnType<typeof boot>>['app'], payload: unknown, headers: Record<string, string> = PAIR) =>
    app.inject({ method: 'POST', url: URL, headers, payload: payload as never });

describe('POST /api/jobs/:id/agent-title', () => {
    it('writes the normalized title under the live attempt, never cached', async () => {
        const { app, calls } = await boot();
        const res = await post(app, { title: '  Fix   login ' });
        expect(res.statusCode).toBe(HTTP_OK);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.json()).toEqual({ title: 'Fix login', updated: true, version: 1 });
        expect(calls).toEqual([
            { orgId: 'local', jobId: JOB_ID, rootJobId: ROOT_ID, leaseToken: LEASE, title: 'Fix login' },
        ]);
    });

    it('a throwing attemptOfLease is 503 retryable, never 403, and writes nothing', async () => {
        const { app, calls } = await boot({
            attempt: () => {
                throw new Error('db down');
            },
        });
        const res = await post(app, { title: 'Fix login' });
        expect(res.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
        expect(calls).toEqual([]);
    });

    it('a throwing store is 503 retryable, never "unchanged"', async () => {
        const { app } = await boot({
            store: () => {
                throw new Error('db down');
            },
        });
        const res = await post(app, { title: 'Fix login' });
        expect(res.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(res.json()).toMatchObject({ retryable: true });
    });

    it('a pending attempt is 503 LEASE_PENDING, a refused one 403, both without a write', async () => {
        const pending = await boot({ attempt: { ok: false, pending: true } });
        const res = await post(pending.app, { title: 'Fix login' });
        expect(res.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(res.headers['retry-after']).toBe('1');
        expect(res.json()).toMatchObject({ code: 'LEASE_PENDING' });
        const refused = await boot({ attempt: { ok: false, pending: false } });
        expect((await post(refused.app, { title: 'Fix login' })).statusCode).toBe(HTTP_FORBIDDEN);
        expect([...pending.calls, ...refused.calls]).toEqual([]);
    });

    it('a store that finds the lease moved answers by its classification', async () => {
        const moved = await boot({ store: { ok: false, refusal: 'pending' } });
        expect((await post(moved.app, { title: 'x' })).statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        const gone = await boot({ store: { ok: false, refusal: 'refused' } });
        expect((await post(gone.app, { title: 'x' })).statusCode).toBe(HTTP_FORBIDDEN);
    });

    it('a user-owned title is 200 updated:false with the reason', async () => {
        const { app } = await boot({
            store: { ok: true, title: 'Mine', updated: false, reason: 'user_title', version: 3 },
        });
        expect((await post(app, { title: 'Other' })).json()).toEqual({
            title: 'Mine',
            updated: false,
            reason: 'user_title',
            version: 3,
        });
    });

    it('the cap is 429 TITLE_LIMIT', async () => {
        const { app } = await boot({ store: { ok: false, refusal: 'limit' } });
        const res = await post(app, { title: 'Sixth' });
        expect(res.statusCode).toBe(HTTP_TOO_MANY);
        expect(res.json()).toMatchObject({ code: 'TITLE_LIMIT' });
    });

    it.each([
        ['extra keys', { title: 'x', origin: 'user' }],
        ['a non-string', { title: 5 }],
        ['no title', {}],
        ['blank', { title: '   ' }],
        ['oversized', { title: 'x'.repeat(121) }],
        ['a control character', { title: 'a\u0007b' }],
    ])('%s is 400 and checks nothing', async (_name, payload) => {
        const { app, calls } = await boot();
        const res = await post(app, payload);
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(calls).toEqual([]);
    });

    it('a body over the limit is refused', async () => {
        const { app } = await boot();
        const res = await post(app, { title: 'x'.repeat(10_000) });
        expect(res.statusCode).toBeGreaterThanOrEqual(HTTP_BAD_REQUEST);
    });

    it('a session cookie or worker token alone is 401', async () => {
        const { app } = await boot();
        const bearer = await post(app, { title: 'x' }, { authorization: 'Bearer nope', 'x-factory-job-id': JOB_ID });
        expect(bearer.statusCode).toBe(HTTP_UNAUTHORIZED);
        const none = await post(app, { title: 'x' }, {});
        expect(none.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});
