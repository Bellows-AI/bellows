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
import {
    readSubscriptionCredential,
    subscriptionSecretIdentity,
} from '../src/notifications/subscription-credential.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { faultySecrets, testSecretStore } from './env-secrets-harness.js';
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
let orgOfAdmin: string;
let secrets: SecretStore;

const credential = () => `hook-secret-${randomUUID()}`;

const body = (over: Record<string, unknown> = {}) => ({
    connectorKind: 'fake',
    connectorConfig: { target: 'room-1' },
    eventKinds: ['task.ready'],
    credential: credential(),
    enabled: true,
    ...over,
});

const registryOf = () => createConnectorRegistry([fakeConnector('fake'), fakeConnector('other')]);

async function boot(connectors?: ReturnType<typeof createConnectorRegistry>, wrap?: (s: SecretStore) => SecretStore) {
    const sql = db.sql;
    secrets = testSecretStore(sql);
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
    orgOfAdmin = orgId;
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
            secrets: wrap ? wrap(secrets) : secrets,
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
    await boot(registryOf());
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

const rowOf = async (id: string) => {
    const [row] = await db.sql<{ secret_ref: string; secret_version: string; connector_kind: string }[]>`
        select secret_ref, secret_version, connector_kind from notification_subscription
        where org_id = ${orgOfAdmin} and id = ${id}
    `;
    return row;
};

const storedValue = async (id: string) => {
    const row = await rowOf(id);
    return readSubscriptionCredential(
        secrets,
        { identity: subscriptionSecretIdentity(orgOfAdmin, id), ref: row!.secret_ref, version: row!.secret_version },
        AbortSignal.timeout(3000)
    );
};

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

    it('POST without credential is 400', async () => {
        const { credential: _omitted, ...withoutCredential } = body();

        const refused = await call(admin, 'POST', PATH, withoutCredential);

        expect(refused).toMatchObject({ status: BAD_REQUEST, json: { code: 'BAD_BODY' } });
        expect(await listed(admin)).toEqual([]);
    });

    it('PUT without credential keeps the URL: a later read still returns the original secret', async () => {
        const original = credential();
        const created = await call(admin, 'POST', PATH, body({ credential: original }));
        const { id } = created.json;
        const before = await rowOf(id);
        const { credential: _omitted, ...withoutCredential } = body({ enabled: false });

        const replaced = await call(admin, 'PUT', `${PATH}/${id}`, withoutCredential);

        expect(replaced.status).toBe(OK);
        expect(await rowOf(id)).toEqual(before);
        expect(await storedValue(id)).toBe(original);
    });

    it('PUT with a credential rotates it', async () => {
        const created = await call(admin, 'POST', PATH, body());
        const { id } = created.json;
        const next = credential();

        expect((await call(admin, 'PUT', `${PATH}/${id}`, body({ credential: next }))).status).toBe(OK);

        expect(await storedValue(id)).toBe(next);
    });

    it('PUT changing connectorKind without credential is 400 BAD_BODY and the row is unchanged', async () => {
        const created = await call(admin, 'POST', PATH, body());
        const { id } = created.json;
        const before = await rowOf(id);
        const { credential: _omitted, ...withoutCredential } = body({ connectorKind: 'other' });

        const refused = await call(admin, 'PUT', `${PATH}/${id}`, withoutCredential);

        expect(refused).toMatchObject({ status: BAD_REQUEST, json: { code: 'BAD_BODY' } });
        expect(await rowOf(id)).toEqual(before);
        expect(await listed(admin)).toEqual([created.json]);
    });

    it('the webhook URL appears in no response (POST, PUT, GET as admin and member) and not in connector_config', async () => {
        const first = credential();
        const second = credential();
        const created = await call(admin, 'POST', PATH, body({ credential: first }));
        const { id } = created.json;
        const replaced = await call(admin, 'PUT', `${PATH}/${id}`, body({ credential: second }));
        const responses = [
            created.json,
            replaced.json,
            (await call(admin, 'GET', PATH)).json,
            (await call(member, 'GET', PATH)).json,
        ];
        const row = await rowOf(id);

        for (const response of responses) {
            const wire = JSON.stringify(response);
            for (const needle of [first, second, row!.secret_ref]) expect(wire).not.toContain(needle);
        }
        const [stored] = await db.sql<{ connector_config: unknown }[]>`
            select connector_config from notification_subscription where id = ${id}
        `;
        for (const needle of [first, second]) expect(JSON.stringify(stored!.connector_config)).not.toContain(needle);
    });

    it('a refused credential answers BAD_CONNECTOR_CONFIG without the value and stores nothing', async () => {
        const refused = await call(admin, 'POST', PATH, body({ credential: 5 }));

        expect(refused).toMatchObject({ status: BAD_REQUEST, json: { code: 'BAD_CONNECTOR_CONFIG' } });
        expect(await listed(admin)).toEqual([]);
    });

    it('secret store unavailable → 503 and no row', async () => {
        await app.close();
        await boot(registryOf(), (store) =>
            faultySecrets(store, {
                create: async () => ({ ok: false, error: { code: 'unavailable', reason: 'provider-unavailable' } }),
            })
        );
        const value = credential();

        const refused = await call(admin, 'POST', PATH, body({ credential: value }));

        expect(refused.status).toBe(503);
        expect(JSON.stringify(refused.json)).not.toContain(value);
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
