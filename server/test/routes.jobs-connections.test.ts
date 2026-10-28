import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ConnectionRefusedError } from '../src/db/connection-bindings.js';
import type { JobActionStore } from '../src/db/jobs/job-store-actions.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import { githubAuth, memoryAuthStore, signedIn, staticRegistry, jobStoreSlice, testConfig } from './helpers.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_CONFLICT,
    HTTP_CREATED,
    HTTP_FORBIDDEN,
    HTTP_NOT_FOUND,
    HTTP_OK,
    trackApps,
} from './helpers-http.js';

/**
 * Offline: how the job routes carry a task's `connections` (BEL-59) — the create and follow-up
 * fields, the idempotency fingerprint, and the owner route that satisfies a requirement. Who may
 * bind what is the store's (server/test-db/job-store.connection-bindings.test.ts).
 */

const track = trackApps();
const ID = '11111111-1111-4111-8111-111111111111';
const CONN_A = '22222222-2222-4222-8222-222222222222';
const CONN_B = '33333333-3333-4333-8333-333333333333';

type CreateTarget = { connectionIds?: string[]; idempotency?: { fingerprint: string } | undefined };

async function boot(overrides: Record<string, unknown> = {}) {
    const auth = memoryAuthStore();
    const member = auth.seedMember('test-org', 'octocat');
    const creates: CreateTarget[] = [];
    const followUps: { connectionIds: string[] | undefined }[] = [];
    const binds: { id: string; connectionId: string; bindingRevision: number; userId: string }[] = [];
    const jobs = jobStoreSlice<JobActionStore>({
        async create(_command: string, _by: string | null, target: CreateTarget) {
            creates.push(target);
            return { id: crypto.randomUUID() };
        },
        async createFollowUp(...args: unknown[]) {
            followUps.push({ connectionIds: args[4] as string[] | undefined });
            return { id: crypto.randomUUID() };
        },
        async bindConnection(id: string, input: { connectionId: string; bindingRevision: number }, userId: string) {
            binds.push({ id, ...input, userId });
            return { ok: true, revision: input.bindingRevision + 1 };
        },
        ...overrides,
    });
    const config = testConfig({ auth: githubAuth() });
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, repos: staticRepoSource([{ owner: 'Bellows-AI', name: 'bellows.ai' }]), jobs }),
        auth,
    });
    track(app);
    return { instance: app, creates, followUps, binds, cookie: await signedIn(auth, member) };
}

const create = (instance: FastifyInstance, cookie: string, extra: Record<string, unknown>, key?: string) =>
    instance.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
        payload: { repo: 'Bellows-AI/bellows.ai', command: 'look at ABC-1', ...extra },
    });

describe('POST /api/jobs connections', () => {
    it('hands the store the ids, or an empty list when none is named', async () => {
        const { instance, cookie, creates } = await boot();
        expect((await create(instance, cookie, { connections: [CONN_A, CONN_B] })).statusCode).toBe(HTTP_CREATED);
        expect((await create(instance, cookie, {})).statusCode).toBe(HTTP_CREATED);
        expect(creates.map((c) => c.connectionIds)).toEqual([[CONN_A, CONN_B], []]);
    });

    it.each([
        ['a string', CONN_A],
        ['an object', { id: CONN_A }],
        ['a non-uuid member', ['not-a-uuid']],
        ['a non-string member', [7]],
        ['more than eight', Array.from({ length: 9 }, () => crypto.randomUUID())],
    ])('refuses %s with BAD_CONNECTION and creates nothing', async (_name, connections) => {
        const { instance, cookie, creates } = await boot();
        const res = await create(instance, cookie, { connections });
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json()).toMatchObject({ code: 'BAD_CONNECTION' });
        expect(creates).toEqual([]);
    });

    it('refuses duplicate ids', async () => {
        const { instance, cookie, creates } = await boot();
        const res = await create(instance, cookie, { connections: [CONN_A, CONN_A] });
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json()).toMatchObject({ code: 'BAD_CONNECTION' });
        expect(creates).toEqual([]);
    });

    it('ignores the retired jiraConnection field like any unknown body field', async () => {
        const { instance, cookie, creates } = await boot();
        const res = await create(instance, cookie, { jiraConnection: CONN_A });
        expect(res.statusCode).toBe(HTTP_CREATED);
        expect(creates.map((c) => c.connectionIds)).toEqual([[]]);
    });

    it('answers a store refusal as 403 CONNECTION_NOT_AUTHORIZED', async () => {
        const { instance, cookie } = await boot({
            async create() {
                throw new ConnectionRefusedError('not-authorized');
            },
        });
        const res = await create(instance, cookie, { connections: [CONN_A] });
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(res.json()).toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED' });
    });

    it('fingerprints the connections: the same key with another list is a different request', async () => {
        const { instance, cookie, creates } = await boot();
        await create(instance, cookie, { connections: [CONN_A] }, 'attempt-0001-abcd');
        await create(instance, cookie, { connections: [CONN_B] }, 'attempt-0001-abcd');
        await create(instance, cookie, { connections: [CONN_A] }, 'attempt-0001-abcd');
        const [first, second, third] = creates.map((c) => c.idempotency?.fingerprint);
        expect(first).toMatch(/^[0-9a-f]{64}$/);
        expect(second).not.toBe(first);
        expect(third).toBe(first);
    });
});

describe('POST /api/jobs/:id/follow-up connections', () => {
    it('passes the ids and refuses a malformed list', async () => {
        const { instance, cookie, followUps } = await boot();
        const send = (connections: unknown) =>
            instance.inject({
                method: 'POST',
                url: `/api/jobs/${ID}/follow-up`,
                headers: { cookie },
                payload: { command: 'again', ...(connections === undefined ? {} : { connections }) },
            });
        expect((await send([CONN_A])).statusCode).toBe(HTTP_CREATED);
        expect((await send(undefined)).statusCode).toBe(HTTP_CREATED);
        expect(followUps.map((f) => f.connectionIds ?? [])).toEqual([[CONN_A], []]);
        const bad = await send('nope');
        expect(bad.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(bad.json()).toMatchObject({ code: 'BAD_CONNECTION' });
    });
});

describe('POST /api/jobs/:id/connections', () => {
    const bind = (instance: FastifyInstance, cookie: string, payload: unknown) =>
        instance.inject({
            method: 'POST',
            url: `/api/jobs/${ID}/connections`,
            headers: { cookie },
            payload: payload as object,
        });

    it('binds and answers the new revision', async () => {
        const { instance, cookie, binds } = await boot();
        const res = await bind(instance, cookie, { connectionId: CONN_A, bindingRevision: 3 });
        expect(res.statusCode).toBe(HTTP_OK);
        expect(res.json()).toEqual({ bindingRevision: 4 });
        expect(binds).toMatchObject([{ id: ID, connectionId: CONN_A, bindingRevision: 3 }]);
    });

    it.each([
        [{ connectionId: 'x', bindingRevision: 0 }],
        [{ connectionId: CONN_A, bindingRevision: -1 }],
        [{ connectionId: CONN_A, bindingRevision: 1.5 }],
        [{ connectionId: CONN_A }],
    ])('refuses a malformed body %j', async (payload) => {
        const { instance, cookie, binds } = await boot();
        expect((await bind(instance, cookie, payload)).statusCode).toBe(HTTP_BAD_REQUEST);
        expect(binds).toEqual([]);
    });

    it.each([
        ['stale-revision', HTTP_CONFLICT, 'BINDING_REVISION_STALE'],
        ['not-authorized', HTTP_FORBIDDEN, 'CONNECTION_NOT_AUTHORIZED'],
        ['missing', HTTP_NOT_FOUND, 'NOT_FOUND'],
    ])('answers the store refusal %s as %i %s', async (reason, status, code) => {
        const { instance, cookie } = await boot({
            async bindConnection() {
                return { ok: false, reason };
            },
        });
        const res = await bind(instance, cookie, { connectionId: CONN_A, bindingRevision: 0 });
        expect(res.statusCode).toBe(status);
        expect(res.json()).toMatchObject({ code });
    });
});
