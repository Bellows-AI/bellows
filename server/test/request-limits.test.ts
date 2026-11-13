import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Principal } from '../src/auth/plugin.js';
import { rateKeysOf } from '../src/auth/request-limits.js';
import type { AppConfig } from '../src/config.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import {
    githubAuth,
    memoryAuthStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
    TEST_JOB_BOARD_TOKEN,
} from './helpers.js';
import type { MemoryAuthStore } from './helpers.js';
import { HTTP_FORBIDDEN, HTTP_OK, HTTP_TOO_MANY_REQUESTS, HTTP_UNAUTHORIZED, trackApps } from './helpers-http.js';

const track = trackApps();

const ORG = 'test-org';
const OTHER_ORG = 'other-org';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const WINDOW_SECONDS = 60;
const T0 = Date.parse('2026-11-13T12:00:00.000Z');

/** The two worker calls a running task cannot lose: the claim that starts it and the heartbeat that keeps it. */
const workerJobs = (): JobStore =>
    ({
        async claim() {
            return null;
        },
        async heartbeat() {
            return { result: 'ok', leaseExpiresAt: '2026-11-13T12:05:00.000Z' };
        },
    }) as unknown as JobStore;

async function build(
    store: MemoryAuthStore,
    overrides: Partial<AppConfig> = {},
    clock: { at: number } = { at: T0 }
): Promise<FastifyInstance> {
    const config = testConfig({
        auth: githubAuth(),
        requestLimits: { perCredential: 2, perOrg: 3, windowMs: WINDOW_SECONDS * 1000, streamsPerOrg: 1 },
        ...overrides,
    });
    const app = await buildApp({
        config,
        orgs: staticRegistry({
            config,
            telemetry: stubTelemetryClient(),
            jobs: workerJobs(),
            repos: staticRepoSource([{ owner: 'acme', name: 'web' }]),
        }),
        store: telemetryStoreStub(),
        auth: store,
        orgOfJob: async (jobId) => (jobId === JOB_ID ? ORG : null),
        now: () => clock.at,
    });
    track(app);
    return app;
}

const repos = (app: FastifyInstance, cookie: string) =>
    app.inject({ method: 'GET', url: '/api/repos', headers: { cookie } });

describe('the request rate per credential and per organization', () => {
    it('answers 429 with Retry-After once a credential spends its window, and again after the window', async () => {
        const store = memoryAuthStore();
        const clock = { at: T0 };
        const app = await build(store, {}, clock);
        const cookie = await signedIn(store, store.seedMember(ORG, 'octocat'));

        expect((await repos(app, cookie)).statusCode).toBe(HTTP_OK);
        expect((await repos(app, cookie)).statusCode).toBe(HTTP_OK);
        const refused = await repos(app, cookie);
        expect(refused.statusCode).toBe(HTTP_TOO_MANY_REQUESTS);
        expect(refused.headers['retry-after']).toBe(String(WINDOW_SECONDS));
        expect(refused.json()).toMatchObject({ code: 'RATE_LIMITED' });

        clock.at += WINDOW_SECONDS * 1000;
        expect((await repos(app, cookie)).statusCode).toBe(HTTP_OK);
    });

    it('counts every credential of one organization against the org, and no other org', async () => {
        const store = memoryAuthStore();
        const app = await build(store);
        const first = await signedIn(store, store.seedMember(ORG, 'octocat'));
        const second = await signedIn(store, store.seedMember(ORG, 'hubot'));
        const stranger = await signedIn(store, store.seedMember(OTHER_ORG, 'mallory'));

        expect((await repos(app, first)).statusCode).toBe(HTTP_OK);
        expect((await repos(app, first)).statusCode).toBe(HTTP_OK);
        expect((await repos(app, second)).statusCode).toBe(HTTP_OK);
        const refused = await repos(app, second);
        expect(refused.statusCode).toBe(HTTP_TOO_MANY_REQUESTS);
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
        expect((await repos(app, stranger)).statusCode).toBe(HTTP_OK);
    });

    it('never refuses the worker routes a running task depends on, whatever the rate', async () => {
        const store = memoryAuthStore();
        const app = await build(store, {
            requestLimits: { perCredential: 1, perOrg: 1, windowMs: WINDOW_SECONDS * 1000, streamsPerOrg: 1 },
        });
        const worker = { authorization: `Bearer ${TEST_JOB_BOARD_TOKEN}` };
        for (let i = 0; i < 5; i += 1) {
            const claim = await app.inject({ method: 'POST', url: '/api/jobs/claim', payload: {}, headers: worker });
            const beat = await app.inject({
                method: 'POST',
                url: `/api/jobs/${JOB_ID}/heartbeat`,
                payload: { leaseToken: LEASE },
                headers: worker,
            });
            for (const response of [claim, beat]) {
                expect([HTTP_TOO_MANY_REQUESTS, HTTP_UNAUTHORIZED, HTTP_FORBIDDEN]).not.toContain(response.statusCode);
            }
        }
    });

    it('is off under AUTH_MODE=none, where one stand-in account is every caller', async () => {
        const app = await build(memoryAuthStore(), { auth: { mode: 'none' } });
        for (let i = 0; i < 5; i += 1) {
            expect((await app.inject({ method: 'GET', url: '/api/repos' })).statusCode).not.toBe(
                HTTP_TOO_MANY_REQUESTS
            );
        }
    });
});

describe('rateKeysOf', () => {
    const caller = memoryAuthStore().seedMember(ORG, 'octocat');
    const principals: Principal[] = [
        { kind: 'worker', orgId: ORG, orgs: null },
        { kind: 'job', orgId: ORG, jobId: JOB_ID },
        { kind: 'org', token: { orgId: ORG, id: 'tok', label: 'ci' } },
        { kind: 'user', caller },
    ];

    it.each(['worker', 'branch', 'ingest', 'connector', 'commerce', 'open'] as const)(
        'exempts every principal on a %s route',
        (requirement) => {
            for (const principal of principals) expect(rateKeysOf(requirement, principal, false)).toBeNull();
        }
    );

    it('exempts a bridged request: its MCP call was counted once already', () => {
        expect(rateKeysOf('user', { kind: 'user', caller }, true)).toBeNull();
    });

    it('keys a human route by the credential and the organization the auth hook resolved', () => {
        const session = { ...caller, sessionHash: Buffer.from('abcd', 'hex') };
        expect(rateKeysOf('user', { kind: 'user', caller: session }, false)).toEqual({
            credential: 'session:abcd',
            org: ORG,
        });
        expect(rateKeysOf('user', { kind: 'user', caller: { ...caller, accessTokenId: 't1' } }, false)).toEqual({
            credential: 'token:t1',
            org: ORG,
        });
        expect(rateKeysOf('mcp', { kind: 'user', caller: { ...caller, grantFamilyId: 'g1' } }, false)).toEqual({
            credential: 'grant:g1',
            org: ORG,
        });
        expect(rateKeysOf('user', principals[2]!, false)).toEqual({ credential: 'org-token:tok', org: ORG });
    });
});

describe('the client address behind a proxy', () => {
    const probe = async (trustedProxies: readonly string[], remoteAddress: string) => {
        const app = await build(memoryAuthStore(), { auth: { mode: 'none' }, trustedProxies });
        app.get('/probe-ip', async (request) => ({ ip: request.ip }));
        const response = await app.inject({
            method: 'GET',
            url: '/probe-ip',
            remoteAddress,
            headers: { 'x-forwarded-for': '198.51.100.7' },
        });
        return (response.json() as { ip: string }).ip;
    };

    it('ignores X-Forwarded-For by default', async () => {
        expect(await probe([], '10.1.2.3')).toBe('10.1.2.3');
    });

    it('ignores a forged X-Forwarded-For from a peer outside TRUSTED_PROXIES', async () => {
        expect(await probe(['10.0.0.0/8'], '203.0.113.9')).toBe('203.0.113.9');
    });

    it('honours X-Forwarded-For from a peer inside TRUSTED_PROXIES', async () => {
        expect(await probe(['10.0.0.0/8'], '10.1.2.3')).toBe('198.51.100.7');
    });
});
