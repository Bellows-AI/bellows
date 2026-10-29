import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AttemptCheck, AttemptOfLease, PairMatches } from '../src/db/attempt-of-lease.js';
import type { LiveConnection } from '../src/db/connection-bindings.js';
import type { BeginInput, OperationReceipts, Receipt } from '../src/db/operation-receipts.js';
import { githubAuth, memoryAuthStore, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_CONFLICT,
    HTTP_FORBIDDEN,
    HTTP_OK,
    HTTP_SERVICE_UNAVAILABLE,
    HTTP_UNAUTHORIZED,
    trackApps,
} from './helpers-http.js';

/**
 * Offline: the runner seam's HTTP contract (docs/connections.md): the operation receipt routes and the
 * connection list, against stub checks and a stub store. The SQL is pinned by
 * server/test-db/operation-receipts.test.ts and server/test-db/connection-credential.test.ts.
 */

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const ROOT_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = '66666666-6666-4666-8666-666666666666';
const RECEIPT_ID = '77777777-7777-4777-8777-777777777777';
const PAIR = { 'x-factory-job-id': JOB_ID, 'x-factory-job-lease-token': LEASE };
const FINGERPRINT = 'c'.repeat(64);
const OPERATIONS = `/api/jobs/${JOB_ID}/operations`;
const RECEIPT_URL = `${OPERATIONS}/${RECEIPT_ID}`;
const LIST_URL = `/api/jobs/${JOB_ID}/credentials/connections`;

const LIVE: AttemptCheck = {
    ok: true,
    orgId: 'local',
    jobId: JOB_ID,
    rootJobId: ROOT_ID,
    repo: 'acme/widgets',
    rootRepo: 'acme/widgets',
    executionUserId: USER_ID,
    claimSeq: 3,
};

const RECEIPT: Receipt = { id: RECEIPT_ID, status: 'started', result: null, dispatchedAt: null };
const BODY = {
    connectionId: CONNECTION_ID,
    provider: 'jira',
    operation: 'addComment',
    key: 'k-1',
    fingerprint: FINGERPRINT,
};

const track = trackApps();

interface Boot {
    attempt?: AttemptCheck | (() => never);
    pair?: boolean | (() => never);
    bound?: boolean | (() => never);
    begin?: Awaited<ReturnType<OperationReceipts['begin']>> | (() => never);
    transition?: Receipt | null | (() => never);
    read?: Receipt | null | (() => never);
    connections?: LiveConnection[] | (() => never);
    apiBase?: (provider: string, resource: string) => string | null;
}

const run = <T>(value: T | (() => never)): T => (typeof value === 'function' ? (value as () => never)() : value);

async function boot(over: Boot = {}) {
    const calls = { begin: [] as BeginInput[], transition: [] as Record<string, unknown>[], attempts: 0 };
    const attemptOfLease: AttemptOfLease = async (jobId, leaseToken) => {
        calls.attempts += 1;
        const answer = run(over.attempt ?? LIVE);
        return jobId === JOB_ID && leaseToken === LEASE ? answer : { ok: false };
    };
    const pairMatches: PairMatches = async (jobId, leaseToken) =>
        run(over.pair ?? true) && jobId === JOB_ID && leaseToken === LEASE
            ? { ok: true, orgId: 'local' }
            : { ok: false };
    const operationReceipts: OperationReceipts = {
        isBound: async () => run(over.bound ?? true),
        begin: async (input) => {
            calls.begin.push(input);
            return run(over.begin ?? { receipt: RECEIPT, created: true });
        },
        transition: async (input) => {
            calls.transition.push({ ...input });
            return run(over.transition === undefined ? { ...RECEIPT, status: 'succeeded' } : over.transition);
        },
        read: async () => run(over.read === undefined ? RECEIPT : over.read),
    };
    const config = testConfig({ auth: githubAuth() });
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
        auth: memoryAuthStore(),
        attemptOfLease,
        pairMatches,
        operationReceipts,
        connectionListing: {
            connectionsOf: async () => run(over.connections ?? []),
            apiBaseOf:
                over.apiBase ??
                ((provider, resource) =>
                    provider === 'jira' ? `https://api.example.test/ex/jira/${resource}/rest/api/3` : null),
        },
        integrations: {
            resolverOf: () =>
                ({ resolveCredential: async () => ({ ok: false, outcome: { outcome: 'unavailable' } }) }) as never,
        },
        logger: false,
    });
    track(app);
    return { app, calls };
}

const post = (app: Awaited<ReturnType<typeof boot>>['app'], payload: unknown = BODY, headers = PAIR) =>
    app.inject({ method: 'POST', url: OPERATIONS, headers, payload: payload as never });
const put = (app: Awaited<ReturnType<typeof boot>>['app'], payload: unknown, headers = PAIR) =>
    app.inject({ method: 'PUT', url: RECEIPT_URL, headers, payload: payload as never });

describe('POST /api/jobs/:id/operations', () => {
    it('begins the receipt under the live attempt for the root it names, never cached', async () => {
        const { app, calls } = await boot();
        const res = await post(app);
        expect(res.statusCode).toBe(HTTP_OK);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.json()).toEqual({ receipt: RECEIPT, created: true });
        expect(calls.begin).toEqual([{ orgId: 'local', rootJobId: ROOT_ID, jobId: JOB_ID, ...BODY }]);
    });

    it('needs a live lease: a reviewer row, a finished or cancelled attempt, a stale pair is 403', async () => {
        const { app, calls } = await boot({ attempt: { ok: false } });
        const res = await post(app);
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(res.json().code).toBe('CONNECTION_NOT_AUTHORIZED');
        const wrong = await post(app, BODY, {
            ...PAIR,
            'x-factory-job-lease-token': '33333333-3333-4333-8333-333333333333',
        });
        expect(wrong.statusCode).toBe(HTTP_FORBIDDEN);
        expect(calls.begin).toEqual([]);
    });

    it('without the pair headers is 401', async () => {
        const { app } = await boot();
        expect((await post(app, BODY, {} as never)).statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('for a connection the root has no binding for is 403 and begins nothing', async () => {
        const { app, calls } = await boot({ bound: false });
        const res = await post(app);
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(res.json().code).toBe('CONNECTION_NOT_AUTHORIZED');
        expect(calls.begin).toEqual([]);
    });

    it('a reused key with another fingerprint is 409 OPERATION_KEY_REUSED', async () => {
        const { app } = await boot({ begin: 'key-reused' });
        const res = await post(app);
        expect(res.statusCode).toBe(HTTP_CONFLICT);
        expect(res.json().code).toBe('OPERATION_KEY_REUSED');
    });

    it.each([
        ['a missing field', { ...BODY, key: undefined }],
        ['a key with a space', { ...BODY, key: 'a b' }],
        ['a key past 128 characters', { ...BODY, key: 'k'.repeat(129) }],
        ['a fingerprint that is not sha256 hex', { ...BODY, fingerprint: 'xyz' }],
        ['a connection id that is no uuid', { ...BODY, connectionId: 'nope' }],
        ['an extra field', { ...BODY, status: 'succeeded' }],
    ])('rejects %s as BAD_BODY before any check', async (_name, payload) => {
        const { app, calls } = await boot();
        const res = await post(app, payload);
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json().code).toBe('BAD_BODY');
        expect(calls.begin).toEqual([]);
    });

    it.each([
        [
            'the lease query',
            {
                attempt: (() => {
                    throw new Error('db down');
                }) as () => never,
            },
        ],
        [
            'the binding query',
            {
                bound: (() => {
                    throw new Error('db down');
                }) as () => never,
            },
        ],
        [
            'the receipt insert',
            {
                begin: (() => {
                    throw new Error('db down');
                }) as () => never,
            },
        ],
    ])('a throwing %s is 503, never 403 or "no receipt"', async (_name, over) => {
        const { app } = await boot(over);
        const res = await post(app);
        expect(res.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(res.json().code).toBe('UNAVAILABLE');
        expect(res.body).not.toContain('db down');
    });
});

describe('PUT /api/jobs/:id/operations/:receiptId', () => {
    it('after the attempt was stopped (pair matches, not live) still records succeeded', async () => {
        const { app, calls } = await boot({ attempt: { ok: false } });
        const res = await put(app, { from: ['dispatched'], to: 'succeeded', result: { commentId: '10042' } });
        expect(res.statusCode).toBe(HTTP_OK);
        expect(res.json()).toEqual({ receipt: { ...RECEIPT, status: 'succeeded' } });
        expect(calls.transition).toEqual([
            {
                orgId: 'local',
                jobId: JOB_ID,
                receiptId: RECEIPT_ID,
                from: ['dispatched'],
                to: 'succeeded',
                result: { commentId: '10042' },
            },
        ]);
        expect(calls.attempts).toBe(0);
    });

    it('a pair that names no attempt row is 403', async () => {
        const { app, calls } = await boot({ pair: false });
        const res = await put(app, { from: ['started'], to: 'dispatched' });
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(calls.transition).toEqual([]);
    });

    it('a refused move is 409 with the current receipt', async () => {
        const { app } = await boot({ transition: null, read: { ...RECEIPT, status: 'dispatched' } });
        const res = await put(app, { from: ['started'], to: 'dispatched' });
        expect(res.statusCode).toBe(HTTP_CONFLICT);
        expect(res.json().receipt).toMatchObject({ id: RECEIPT_ID, status: 'dispatched' });
    });

    it("a receipt that is not this root's is a 409 with no receipt", async () => {
        const { app } = await boot({ transition: null, read: null });
        const res = await put(app, { from: ['started'], to: 'dispatched' });
        expect(res.statusCode).toBe(HTTP_CONFLICT);
        expect(res.json().receipt).toBeNull();
    });

    it.each([
        ['an unknown status', { from: ['started'], to: 'done' }],
        ['an empty from', { from: [], to: 'dispatched' }],
        ['a commentId that is not digits', { from: ['dispatched'], to: 'succeeded', result: { commentId: 'abc' } }],
        ['a result with another key', { from: ['dispatched'], to: 'succeeded', result: { commentId: '1', body: 'x' } }],
    ])('rejects %s as BAD_BODY', async (_name, payload) => {
        const { app, calls } = await boot();
        const res = await put(app, payload);
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json().code).toBe('BAD_BODY');
        expect(calls.transition).toEqual([]);
    });

    it.each([
        [
            'the pair query',
            {
                pair: (() => {
                    throw new Error('db down');
                }) as () => never,
            },
        ],
        [
            'the transition',
            {
                transition: (() => {
                    throw new Error('db down');
                }) as () => never,
            },
        ],
        [
            'the read of the current row',
            {
                transition: null,
                read: (() => {
                    throw new Error('db down');
                }) as () => never,
            },
        ],
    ])('a throwing %s is 503', async (_name, over) => {
        const { app } = await boot(over);
        const res = await put(app, { from: ['started'], to: 'dispatched' });
        expect(res.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
    });
});

describe('GET /api/jobs/:id/credentials/connections', () => {
    const CONNECTION: LiveConnection = {
        id: CONNECTION_ID,
        provider: 'jira',
        site: 'example.atlassian.net',
        resource: 'cloud-1',
        access: 'read',
    };
    const get = (app: Awaited<ReturnType<typeof boot>>['app'], headers = PAIR) =>
        app.inject({ method: 'GET', url: LIST_URL, headers });

    it("lists the root's live connections with their apiBase, never cached, and nothing else", async () => {
        const { app } = await boot({ connections: [CONNECTION] });
        const res = await get(app);
        expect(res.statusCode).toBe(HTTP_OK);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.json()).toEqual({
            connections: [
                {
                    id: CONNECTION_ID,
                    provider: 'jira',
                    site: 'example.atlassian.net',
                    resource: 'cloud-1',
                    access: 'read',
                    apiBase: 'https://api.example.test/ex/jira/cloud-1/rest/api/3',
                },
            ],
        });
    });

    it('omits a connection whose provider is not configured', async () => {
        const { app } = await boot({ connections: [CONNECTION], apiBase: () => null });
        expect((await get(app)).json()).toEqual({ connections: [] });
    });

    it('a lease refusal is 403 and a throwing lease or listing is 503', async () => {
        expect((await get((await boot({ attempt: { ok: false } })).app)).statusCode).toBe(HTTP_FORBIDDEN);
        const down = (): never => {
            throw new Error('db down');
        };
        expect((await get((await boot({ attempt: down })).app)).statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect((await get((await boot({ connections: down })).app)).statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
    });

    it('without the pair headers is 401', async () => {
        const { app } = await boot({ connections: [CONNECTION] });
        expect((await get(app, {} as never)).statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});
