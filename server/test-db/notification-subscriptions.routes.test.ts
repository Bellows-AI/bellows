import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore } from '../src/auth/store.js';
import { createConnectorRegistry } from '../src/notifications/connector.js';
import { createOrgRegistry } from '../src/orgs.js';
import { fakeConnector } from '../test/notifications-fake-connector.js';
import { githubAuth, testConfig } from '../test/helpers-config.js';
import { testSecretStore } from './env-secrets-harness.js';
import { useTestDb } from './harness.js';
import { randomGithubId, testOrg } from './fixtures.js';

/**
 * BEL-131: the subscription routes through the real app, org registry and auth store. Two orgs, so
 * isolation is shown by the real per-org resolution, not by a double. The first sign-in into an org
 * is its admin; the next is a member.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb();
const PATH = '/api/org/notification-subscriptions';
const OK = 200;
const CREATED = 201;
const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const NOT_FOUND = 404;

let app: FastifyInstance;
let admin: string;
let member: string;
let outsider: string;

const body = (over: Record<string, unknown> = {}) => ({
    connectorKind: 'fake',
    connectorConfig: { target: 'room-1' },
    eventKinds: ['task.ready'],
    enabled: true,
    ...over,
});

async function boot(connectors?: ReturnType<typeof createConnectorRegistry>) {
    const sql = db.sql;
    const [orgId, otherOrgId] = [testOrg(), testOrg()];
    for (const id of [orgId, otherOrgId]) await sql`insert into organization (id, name) values (${id}, ${`org-${id}`})`;
    const auth = createAuthStore({ sql });
    const tokenFor = async (org: string): Promise<string> => {
        const login = `u-${randomUUID().slice(0, 8)}`;
        const caller = await auth.signIn(
            { githubUserId: randomGithubId(), login, displayName: login, avatarUrl: null },
            org,
            [{ id: org, name: org }]
        );
        const token = `fat_${randomUUID()}`;
        await auth.createAccessToken({
            kind: 'personal',
            orgId: org,
            userId: caller.user.id,
            createdBy: caller.user.id,
            label: 'subscriptions',
            tokenHash: hashToken(token),
        });
        return token;
    };
    admin = await tokenFor(orgId);
    member = await tokenFor(orgId);
    outsider = await tokenFor(otherOrgId);

    const ready = Promise.resolve();
    const config = testConfig({ auth: githubAuth() });
    app = await buildApp({
        config,
        orgs: createOrgRegistry({
            sql,
            ready,
            config,
            withStores: true,
            secrets: testSecretStore(sql),
            secretLog: () => {},
        }),
        auth,
        ready,
        version: '0.0.0',
        ...(connectors ? { notificationConnectors: connectors } : {}),
    });
}

beforeEach(async () => {
    if (!enabled) return;
    await boot(createConnectorRegistry([fakeConnector('fake')]));
});

afterEach(async () => {
    if (enabled) await app?.close();
});

async function call(token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
    const response = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return {
        status: response.statusCode,
        json: response.json() as Record<string, unknown> & { id: string; subscriptions: Array<{ id: string }> },
    };
}

const listed = async (token: string) => (await call(token, 'GET', PATH)).json.subscriptions;

describe('notification subscription routes', () => {
    it('an admin creates, lists, replaces and deletes a subscription', async () => {
        const created = await call(admin, 'POST', PATH, body());
        expect(created.status).toBe(CREATED);
        expect(created.json).toMatchObject({ connectorKind: 'fake', eventKinds: ['task.ready'], enabled: true });
        const { id } = created.json;
        expect(await listed(admin)).toEqual([created.json]);

        const replaced = await call(admin, 'PUT', `${PATH}/${id}`, body({ enabled: false, repos: ['acme/api'] }));
        expect(replaced.status).toBe(OK);
        expect(replaced.json).toMatchObject({ id, enabled: false, repos: ['acme/api'] });
        expect(await listed(admin)).toEqual([replaced.json]);

        const removed = await call(admin, 'DELETE', `${PATH}/${id}`);
        expect(removed).toMatchObject({ status: OK, json: { id, removed: true } });
        expect(await listed(admin)).toEqual([]);
        expect((await call(admin, 'DELETE', `${PATH}/${id}`)).status).toBe(NOT_FOUND);
    });

    it('a member lists but every write is 403 FORBIDDEN', async () => {
        const created = await call(admin, 'POST', PATH, body());
        const { id } = created.json;

        expect((await call(member, 'GET', PATH)).json.subscriptions).toHaveLength(1);
        for (const [method, url, payload] of [
            ['POST', PATH, body()],
            ['PUT', `${PATH}/${id}`, body()],
            ['DELETE', `${PATH}/${id}`, undefined],
        ] as const) {
            const refused = await call(member, method, url, payload);
            expect(refused.status, method).toBe(FORBIDDEN);
            expect(refused.json.code, method).toBe('FORBIDDEN');
        }
        expect(await listed(admin)).toEqual([created.json]);
    });

    it('another org’s admin cannot see, replace or delete it', async () => {
        const created = await call(admin, 'POST', PATH, body());
        const { id } = created.json;

        expect(await listed(outsider)).toEqual([]);
        expect((await call(outsider, 'PUT', `${PATH}/${id}`, body({ enabled: false }))).status).toBe(NOT_FOUND);
        expect((await call(outsider, 'DELETE', `${PATH}/${id}`)).status).toBe(NOT_FOUND);
        expect(await listed(admin)).toEqual([created.json]);
    });

    it('a non-uuid id is 404, not 503', async () => {
        expect((await call(admin, 'PUT', `${PATH}/not-a-uuid`, body())).status).toBe(NOT_FOUND);
        expect((await call(admin, 'DELETE', `${PATH}/not-a-uuid`)).status).toBe(NOT_FOUND);
    });

    it('validation reaches the wire and stores nothing', async () => {
        const unknown = await call(admin, 'POST', PATH, body({ connectorKind: 'nope' }));
        expect(unknown).toMatchObject({ status: BAD_REQUEST, json: { code: 'UNKNOWN_CONNECTOR' } });

        const rejected = await call(admin, 'POST', PATH, body({ connectorConfig: {} }));
        expect(rejected).toMatchObject({
            status: BAD_REQUEST,
            json: { code: 'BAD_CONNECTOR_CONFIG', problems: ['target must be a non-empty string'] },
        });

        const kind = await call(admin, 'POST', PATH, body({ eventKinds: ['task.exploded'] }));
        expect(kind).toMatchObject({ status: BAD_REQUEST, json: { code: 'BAD_BODY' } });

        expect(await listed(admin)).toEqual([]);
    });

    it('with no connectors registered every create is UNKNOWN_CONNECTOR', async () => {
        await app.close();
        await boot();

        const refused = await call(admin, 'POST', PATH, body());

        expect(refused).toMatchObject({ status: BAD_REQUEST, json: { code: 'UNKNOWN_CONNECTOR' } });
        expect(await listed(admin)).toEqual([]);
    });
});
