import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { CommercePlanWriter } from '../src/db/commerce-plan-writer.js';
import type { CommerceStore } from '../src/db/commerce-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import {
    githubAuth,
    memoryAuthStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    TEST_JOB_BOARD_TOKEN,
    testConfig,
} from './helpers.js';
import { HTTP_NOT_FOUND, HTTP_UNAUTHORIZED, trackApps } from './helpers-http.js';

/**
 * BEL-146: the credential class follows the route the router MATCHED, not a re-parse of the URL. A
 * spelling the router maps onto a session-less handler (percent-encoding, a raw `#`, a query) must meet
 * that handler's credential, never a person's cookie.
 */
const ORG = 'test-org';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const COMMERCE_TOKEN = 'commerce-route-token-0123456789abcdef-xyz';
const track = trackApps();

const PLAN = '/api/commerce/orgs/test-org/plan';
const CLAIM = '/api/jobs/claim';

const PLAN_SPELLINGS = [
    PLAN,
    '/api/commerce/orgs/test-org/pl%61n',
    '/api/c%6Fmmerce/orgs/test-org/plan',
    `${PLAN}?x=1`,
    `//api/commerce/orgs/test-org/plan`,
    `/api//commerce/orgs/test-org/plan`,
    `${PLAN}/`,
    '/API/commerce/orgs/test-org/plan',
    '/api/Commerce/orgs/test-org/plan',
    `${PLAN}%23x`,
    `${PLAN}%3Fx`,
];

const CLAIM_SPELLINGS = [
    CLAIM,
    '/api/jobs/cl%61im',
    '/api/%6Aobs/claim',
    `${CLAIM}?x=1`,
    '//api/jobs/claim',
    '/api//jobs/claim',
    `${CLAIM}/`,
    '/API/jobs/claim',
    '/api/Jobs/claim',
    `${CLAIM}%23x`,
];

const PLAN_BODY = {
    plan: 'pro',
    includedMinutes: 3000,
    usedMinutes: 10,
    periodStart: '2026-08-01T00:00:00.000Z',
    periodEnd: '2026-09-01T00:00:00.000Z',
    version: 3,
};

async function boot(heartbeatOrgs: string[] = []) {
    const store = memoryAuthStore();
    const member = store.seedMember(ORG, 'octocat');
    const config = testConfig({
        auth: githubAuth(),
        commerce: { enabled: true, url: 'https://commerce.example/', token: COMMERCE_TOKEN },
    });
    const planCalls: string[] = [];
    const claimCalls: string[] = [];
    const writer: CommercePlanWriter = {
        async put(orgId) {
            planCalls.push(orgId);
            return { verdict: 'stored' };
        },
    };
    const jobs = {
        async claim() {
            claimCalls.push('claim');
            return null;
        },
        async heartbeat() {
            return { result: 'ok', leaseExpiresAt: '2026-08-21T12:05:00.000Z' };
        },
    } as unknown as JobStore;
    const commerce: CommerceStore = {
        enqueueUsage: async () => {},
        leaseDueUsage: async () => null,
        settleUsage: async () => {},
        read: async () => ({ plan: null, unreportedClaims: 0 }),
    };
    const orgs = staticRegistry({ config, telemetry: stubTelemetryClient(), jobs });
    const base = orgs.for;
    orgs.for = async (id) => {
        const runtime = await base(id);
        return runtime ? { ...runtime, commerce } : runtime;
    };
    const app = track(
        await buildApp({
            config,
            orgs,
            store: telemetryStoreStub(),
            auth: store,
            commercePlanWriter: writer,
            orgOfJob: async (jobId) => {
                heartbeatOrgs.push(jobId);
                return jobId === JOB_ID ? ORG : null;
            },
        })
    );
    return { app, cookie: await signedIn(store, member), planCalls, claimCalls };
}

/**
 * `inject` parses the URL and drops a fragment; a socket sends it as written, which is how a client puts a
 * raw `#` on the request line. Answers the status line's code.
 */
async function rawRequest(
    app: Awaited<ReturnType<typeof boot>>['app'],
    { method, target, headers, body }: { method: string; target: string; headers: Record<string, string>; body: object }
): Promise<number> {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const payload = JSON.stringify(body);
    const head = {
        host: '127.0.0.1',
        'content-type': 'application/json',
        'content-length': String(payload.length),
        ...headers,
        connection: 'close',
    };
    const lines = Object.entries(head).map(([name, value]) => `${name}: ${value}`);
    const text = `${method} ${target} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n${payload}`;
    return new Promise((resolve, reject) => {
        let received = '';
        const socket = connect(port, '127.0.0.1', () => socket.write(text));
        socket.on('data', (chunk) => {
            received += chunk.toString();
        });
        socket.on('error', reject);
        socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(received)?.[1])));
    });
}

const REFUSED = [HTTP_UNAUTHORIZED, HTTP_NOT_FOUND];

describe('the commerce plan PUT, spelled every way', () => {
    it.each(PLAN_SPELLINGS)('refuses a session cookie on %s', async (url) => {
        const { app, cookie, planCalls } = await boot();
        const response = await app.inject({ method: 'PUT', url, payload: PLAN_BODY, headers: { cookie } });
        expect(REFUSED, `${url} -> ${response.statusCode}`).toContain(response.statusCode);
        expect(planCalls).toEqual([]);
    });

    it.each(['/api/commerce/orgs/test-org/pl%61n', `${PLAN}?x=1`])(
        'delivers %s to the writer under the commerce token',
        async (url) => {
            const { app, planCalls } = await boot();
            await app.inject({
                method: 'PUT',
                url,
                payload: PLAN_BODY,
                headers: { authorization: `Bearer ${COMMERCE_TOKEN}` },
            });
            expect(planCalls).toEqual([ORG]);
        }
    );
});

describe('a raw # on the request line', () => {
    it.each([
        ['PUT', `${PLAN}#x`, PLAN_BODY],
        ['POST', `${CLAIM}#x`, { worker: 'w', leaseSeconds: 60 }],
    ])('refuses a session cookie on %s %s', async (method, target, body) => {
        const { app, cookie, planCalls, claimCalls } = await boot();
        const status = await rawRequest(app, { method, target, headers: { cookie }, body });
        expect(REFUSED, `${target} -> ${status}`).toContain(status);
        expect([...planCalls, ...claimCalls]).toEqual([]);
    });

    it.each([
        ['PUT', `${PLAN}#x`, PLAN_BODY, `Bearer ${COMMERCE_TOKEN}`],
        ['POST', `${CLAIM}#x`, { worker: 'w', leaseSeconds: 60 }, `Bearer ${TEST_JOB_BOARD_TOKEN}`],
    ])('reaches the handler on %s %s under its own credential', async (method, target, body, authorization) => {
        const { app, planCalls, claimCalls } = await boot();
        await rawRequest(app, { method, target, headers: { authorization }, body });
        expect(planCalls.length + claimCalls.length).toBe(1);
    });
});

describe('the worker claim, spelled every way', () => {
    const claim = { worker: 'w', leaseSeconds: 60 };

    it.each(CLAIM_SPELLINGS)('refuses a session cookie on %s', async (url) => {
        const { app, cookie, claimCalls } = await boot();
        const response = await app.inject({ method: 'POST', url, payload: claim, headers: { cookie } });
        expect(REFUSED, `${url} -> ${response.statusCode}`).toContain(response.statusCode);
        expect(claimCalls).toEqual([]);
    });

    it.each(['/api/jobs/cl%61im', `${CLAIM}?x=1`])('delivers %s to the claim under the worker secret', async (url) => {
        const { app, claimCalls } = await boot();
        await app.inject({
            method: 'POST',
            url,
            payload: claim,
            headers: { authorization: `Bearer ${TEST_JOB_BOARD_TOKEN}` },
        });
        expect(claimCalls).toEqual(['claim']);
    });
});

describe('a job-scoped worker route', () => {
    it('resolves the org from the id the handler sees, not the spelled one', async () => {
        const seen: string[] = [];
        const { app } = await boot(seen);
        const encoded = JOB_ID.replace('-', '%2D');
        await app.inject({
            method: 'POST',
            url: `/api/jobs/${encoded}/heartbeat`,
            payload: { leaseToken: 'x' },
            headers: { authorization: `Bearer ${TEST_JOB_BOARD_TOKEN}` },
        });
        expect(seen).toEqual([JOB_ID]);
    });
});

describe('an unmatched request', () => {
    it('walls /api/nope and /API/nope, leaves a document path open', async () => {
        const { app, cookie } = await boot();
        expect((await app.inject({ method: 'GET', url: '/api/nope' })).statusCode).toBe(HTTP_UNAUTHORIZED);
        expect((await app.inject({ method: 'GET', url: '/api/nope', headers: { cookie } })).statusCode).toBe(
            HTTP_NOT_FOUND
        );
        expect((await app.inject({ method: 'GET', url: '/API/nope' })).statusCode).toBe(HTTP_UNAUTHORIZED);
        expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).not.toBe(HTTP_UNAUTHORIZED);
    });
});
