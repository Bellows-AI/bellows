import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AuthConfig } from '../src/config.js';
import type { CommercePlanWriter, PlanPush, PlanVerdict } from '../src/db/commerce-plan-writer.js';
import type { CommerceStore } from '../src/db/commerce-store.js';
import {
    githubAuth,
    memoryAuthStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
} from './helpers.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_CONFLICT,
    HTTP_NOT_FOUND,
    HTTP_OK,
    HTTP_SERVICE_UNAVAILABLE,
    HTTP_UNAUTHORIZED,
    trackApps,
} from './helpers-http.js';

/** BEL-146: the member's plan read and the commerce service's plan push, behind a credential of its own. */
const ORG = 'test-org';
const TOKEN = 'commerce-route-token-0123456789abcdef-xyz';
const track = trackApps();

const BODY = {
    plan: 'pro',
    includedMinutes: 3000,
    usedMinutes: 10,
    periodStart: '2026-08-01T00:00:00.000Z',
    periodEnd: '2026-09-01T00:00:00.000Z',
    version: 3,
};

const planView = {
    plan: 'pro',
    includedMinutes: 3000,
    usedMinutes: 10,
    periodStart: '2026-08-01T00:00:00.000Z',
    periodEnd: '2026-09-01T00:00:00.000Z',
    version: 3,
    updatedAt: '2026-08-02T00:00:00.000Z',
};

function fakeWriter(answer: PlanVerdict | Error = { verdict: 'stored' }) {
    const calls: { orgId: string; push: PlanPush }[] = [];
    const writer: CommercePlanWriter = {
        async put(orgId, push) {
            calls.push({ orgId, push });
            if (answer instanceof Error) throw answer;
            return answer;
        },
    };
    return { writer, calls };
}

const storeOf = (read: CommerceStore['read']): CommerceStore => ({
    enqueueUsage: async () => {},
    leaseDueUsage: async () => null,
    settleUsage: async () => {},
    read,
});

async function boot(
    options: { enabled?: boolean; auth?: AuthConfig; read?: CommerceStore['read']; writer?: CommercePlanWriter } = {}
) {
    const auth = options.auth ?? githubAuth();
    const store = memoryAuthStore();
    const member = store.seedMember(ORG, 'octocat');
    const config = testConfig({
        auth,
        commerce:
            options.enabled === false
                ? { enabled: false }
                : { enabled: true, url: 'https://commerce.example/', token: TOKEN },
    });
    const orgs = staticRegistry({ config, telemetry: stubTelemetryClient() });
    const base = orgs.for;
    const commerce = storeOf(options.read ?? (async () => ({ plan: planView, unreportedClaims: 4 })));
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
            commercePlanWriter: options.writer ?? fakeWriter().writer,
        })
    );
    return { app, cookie: await signedIn(store, member) };
}

const put = (
    app: Awaited<ReturnType<typeof boot>>['app'],
    payload: unknown,
    headers: Record<string, string> = {},
    org = ORG
) =>
    app.inject({
        method: 'PUT',
        url: `/api/commerce/orgs/${org}/plan`,
        payload: payload as object,
        headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    });

describe('GET /api/commerce', () => {
    it("answers the caller org's plan and unreported count", async () => {
        const { app, cookie } = await boot();
        const response = await app.inject({ method: 'GET', url: '/api/commerce', headers: { cookie } });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({ plan: planView, unreportedClaims: 4 });
    });

    it('answers plan null before any push', async () => {
        const { app, cookie } = await boot({ read: async () => ({ plan: null, unreportedClaims: 0 }) });
        const response = await app.inject({ method: 'GET', url: '/api/commerce', headers: { cookie } });
        expect(response.json()).toEqual({ plan: null, unreportedClaims: 0 });
    });

    it('a store failure is 503, never an empty plan', async () => {
        const { app, cookie } = await boot({
            read: async () => {
                throw new Error('database down');
            },
        });
        const response = await app.inject({ method: 'GET', url: '/api/commerce', headers: { cookie } });
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(response.json().plan).toBeUndefined();
    });

    it('needs a session', async () => {
        const { app } = await boot();
        const response = await app.inject({ method: 'GET', url: '/api/commerce' });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});

describe('PUT /api/commerce/orgs/:orgId/plan', () => {
    it('stores and answers 200 with the version', async () => {
        const { writer, calls } = fakeWriter({ verdict: 'stored' });
        const { app } = await boot({ writer });
        const response = await put(app, BODY);
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({ stored: true, version: 3 });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.orgId).toBe(ORG);
        expect(calls[0]?.push).toEqual({
            plan: 'pro',
            includedMinutes: 3000,
            usedMinutes: 10,
            periodStart: new Date('2026-08-01T00:00:00.000Z'),
            periodEnd: new Date('2026-09-01T00:00:00.000Z'),
            version: 3,
        });
    });

    it('accepts null limits and period', async () => {
        const { writer, calls } = fakeWriter();
        const { app } = await boot({ writer });
        const response = await put(app, {
            ...BODY,
            plan: 'free',
            includedMinutes: null,
            usedMinutes: null,
            periodStart: null,
            periodEnd: null,
        });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(calls[0]?.push).toMatchObject({ includedMinutes: null, periodStart: null, periodEnd: null });
    });

    it('a replay answers 200', async () => {
        const { app } = await boot({ writer: fakeWriter({ verdict: 'replayed' }).writer });
        const response = await put(app, BODY);
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({ stored: true, version: 3 });
    });

    it('stale answers 409 with the current version', async () => {
        const { app } = await boot({ writer: fakeWriter({ verdict: 'stale', currentVersion: 8 }).writer });
        const response = await put(app, BODY);
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json()).toMatchObject({ stored: false, version: 8 });
    });

    it('an unknown org answers 404', async () => {
        const { app } = await boot({ writer: fakeWriter({ verdict: 'unknown_org' }).writer });
        const response = await put(app, BODY);
        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
    });

    const MALFORMED: [string, unknown][] = [
        ['an unknown field', { ...BODY, extra: 1 }],
        ['a plan outside the set', { ...BODY, plan: 'platinum' }],
        ['a missing plan', { ...BODY, plan: undefined }],
        ['negative included minutes', { ...BODY, includedMinutes: -1 }],
        ['fractional used minutes', { ...BODY, usedMinutes: 1.5 }],
        ['string minutes', { ...BODY, usedMinutes: '10' }],
        ['a missing minutes field', { ...BODY, includedMinutes: undefined }],
        ['an unparseable date', { ...BODY, periodStart: 'yesterday' }],
        ['a numeric date', { ...BODY, periodEnd: 1_788_000_000 }],
        ['a period that ends before it starts', { ...BODY, periodStart: BODY.periodEnd, periodEnd: BODY.periodStart }],
        ['version zero', { ...BODY, version: 0 }],
        ['a fractional version', { ...BODY, version: 1.5 }],
        ['a version beyond the safe integers', { ...BODY, version: Number.MAX_SAFE_INTEGER + 2 }],
        ['a string version', { ...BODY, version: '3' }],
        ['an array body', [BODY]],
        ['a null body', null],
    ];
    it.each(MALFORMED)('a malformed body answers 400: %s', async (_name, payload) => {
        const { writer, calls } = fakeWriter();
        const { app } = await boot({ writer });
        const response = await app.inject({
            method: 'PUT',
            url: `/api/commerce/orgs/${ORG}/plan`,
            headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
            payload: JSON.stringify(payload),
        });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(calls).toHaveLength(0);
    });

    it.each(['UPPER', '-lead', '__reserved', `${'a'.repeat(40)}`, 'has.dot'])(
        'a malformed org id answers 400: %s',
        async (org) => {
            const { writer, calls } = fakeWriter();
            const { app } = await boot({ writer });
            const response = await put(app, BODY, {}, org);
            expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
            expect(calls).toHaveLength(0);
        }
    );

    it('a writer failure is 503, never 200', async () => {
        const { app } = await boot({ writer: fakeWriter(new Error('database down')).writer });
        const response = await put(app, BODY);
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
    });

    it.each([['github'], ['none']])('without a bearer, or with a wrong one, is 401 in %s mode', async (mode) => {
        const auth: AuthConfig = mode === 'github' ? githubAuth() : { mode: 'none', ingestToken: null };
        const { writer, calls } = fakeWriter();
        const { app } = await boot({ auth, writer });
        const none = await app.inject({ method: 'PUT', url: `/api/commerce/orgs/${ORG}/plan`, payload: BODY });
        const wrong = await put(app, BODY, { authorization: `Bearer ${TOKEN}x` });
        const short = await put(app, BODY, { authorization: 'Bearer short' });
        expect([none.statusCode, wrong.statusCode, short.statusCode]).toEqual([
            HTTP_UNAUTHORIZED,
            HTTP_UNAUTHORIZED,
            HTTP_UNAUTHORIZED,
        ]);
        expect(calls).toHaveLength(0);
    });

    it('the worker token is not the commerce token', async () => {
        const auth = githubAuth();
        const { app } = await boot({ auth });
        const workerToken = auth.mode === 'github' ? auth.jobBoardToken : '';
        const response = await put(app, BODY, { authorization: `Bearer ${workerToken}` });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('a session cookie and no bearer is 401: a member cannot set a plan', async () => {
        const { app, cookie } = await boot();
        const response = await app.inject({
            method: 'PUT',
            url: `/api/commerce/orgs/${ORG}/plan`,
            payload: BODY,
            headers: { cookie },
        });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});

describe('the credential follows the path the router matches', () => {
    const VARIANTS = [
        `/api/commerce/orgs/${ORG}/pl%61n`,
        `/api/%63ommerce/orgs/${ORG}/plan`,
        `/api/commerce/%6Frgs/${ORG}/plan`,
        `/api/commerce/orgs/%74est-org/plan`,
    ];
    it.each(VARIANTS)('a session cookie cannot push a plan through %s', async (url) => {
        const { writer, calls } = fakeWriter();
        const { app, cookie } = await boot({ writer });
        const response = await app.inject({ method: 'PUT', url, payload: BODY, headers: { cookie } });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
        expect(calls).toHaveLength(0);
    });

    it('a malformed percent-encoding never reaches a weaker credential', async () => {
        const { writer, calls } = fakeWriter();
        const { app, cookie } = await boot({ writer });
        const response = await app.inject({
            method: 'PUT',
            url: `/api/commerce/orgs/${ORG}/plan%ZZ`,
            payload: BODY,
            headers: { cookie },
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(HTTP_BAD_REQUEST);
        expect(calls).toHaveLength(0);
    });
});

describe('with commerce disabled', () => {
    it('neither route is registered', async () => {
        const { app, cookie } = await boot({ enabled: false });
        const read = await app.inject({ method: 'GET', url: '/api/commerce', headers: { cookie } });
        const write = await put(app, BODY);
        expect([read.statusCode, write.statusCode]).toEqual([HTTP_NOT_FOUND, HTTP_NOT_FOUND]);
    });
});
