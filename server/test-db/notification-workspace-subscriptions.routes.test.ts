import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore } from '../src/auth/store.js';
import { createConnectorRegistry } from '../src/notifications/connector.js';
import { createOrgRegistry } from '../src/orgs.js';
import {
    readSubscriptionCredential,
    subscriptionSecretIdentity,
} from '../src/notifications/subscription-credential.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { fakeConnector } from '../test/notifications-fake-connector.js';
import { githubAuth, testConfig } from '../test/helpers-config.js';
import { testSecretStore } from './env-secrets-harness.js';
import { useTestDb } from './harness.js';
import { randomGithubId, testOrg } from './fixtures.js';

/**
 * BEL-177: the personal subscription routes (`/api/workspace/notification-subscriptions`) through the real
 * app, org registry and auth store. A personal row is the caller's own; the org path never sees it.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb();
const PERSONAL = '/api/workspace/notification-subscriptions';
const SHARED_PATH = '/api/org/notification-subscriptions';
const OK = 200;
const CREATED = 201;
const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const NOT_FOUND = 404;

let app: FastifyInstance;
let orgId: string;
let secrets: SecretStore;
let admin: { token: string; userId: string };
let member: { token: string; userId: string };
let orgToken: string;
let fake = fakeConnector('fake');
const ORIGIN = 'http://127.0.0.1:9';

const body = (over: Record<string, unknown> = {}) => ({
    connectorKind: 'fake',
    connectorConfig: { target: 'room-1' },
    eventKinds: ['task.ready'],
    credential: `hook-secret-${randomUUID()}`,
    enabled: true,
    ...over,
});

beforeEach(async () => {
    if (!enabled) return;
    const sql = db.sql;
    secrets = testSecretStore(sql);
    orgId = testOrg();
    await sql`insert into organization (id, name) values (${orgId}, ${`org-${orgId}`})`;
    const auth = createAuthStore({ sql });
    const person = async (): Promise<{ token: string; userId: string }> => {
        const login = `u-${randomUUID().slice(0, 8)}`;
        const caller = await auth.signIn(
            { githubUserId: randomGithubId(), login, displayName: login, avatarUrl: null },
            orgId,
            [{ id: orgId, name: orgId }]
        );
        const token = `fat_${randomUUID()}`;
        await auth.createAccessToken({
            kind: 'personal',
            orgId,
            userId: caller.user.id,
            createdBy: caller.user.id,
            label: 'personal-subscriptions',
            tokenHash: hashToken(token),
        });
        return { token, userId: caller.user.id };
    };
    admin = await person();
    member = await person();
    orgToken = `oat_${randomUUID()}`;
    await auth.createAccessToken({
        kind: 'org',
        orgId,
        userId: null,
        createdBy: admin.userId,
        label: 'org-token',
        tokenHash: hashToken(orgToken),
    });
    fake = fakeConnector('fake');
    const ready = Promise.resolve();
    const config = testConfig({ auth: githubAuth(), integrations: { callbackOrigin: ORIGIN, jira: null } });
    app = await buildApp({
        config,
        orgs: createOrgRegistry({ sql, ready, config, withStores: true, secrets, secretLog: () => {} }),
        auth,
        ready,
        version: '0.0.0',
        notificationConnectors: createConnectorRegistry([fake, fakeConnector('other')]),
    });
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
        text: response.body,
        json: response.json() as Record<string, unknown> & {
            id: string;
            subscriptions: Array<{ id: string }>;
            connectorKinds: string[];
        },
    };
}

const listed = async (token: string, path = PERSONAL) => (await call(token, 'GET', path)).json.subscriptions;

describe.skipIf(!enabled)('personal notification subscription routes', () => {
    it('a member creates, lists, replaces and deletes their own subscription', async () => {
        const created = await call(member.token, 'POST', PERSONAL, body());
        expect(created.status).toBe(CREATED);
        const { id } = created.json;
        const [row] = await db.sql<{ user_id: string }[]>`
            select user_id from notification_subscription where org_id = ${orgId} and id = ${id}
        `;
        expect(row?.user_id).toBe(member.userId);
        expect(await listed(member.token)).toEqual([created.json]);

        const put = await call(member.token, 'PUT', `${PERSONAL}/${id}`, body({ eventKinds: ['task.blocked'] }));
        expect(put.status).toBe(OK);
        expect(put.json).toMatchObject({ id, eventKinds: ['task.blocked'] });

        const removed = await call(member.token, 'DELETE', `${PERSONAL}/${id}`);
        expect(removed.status).toBe(OK);
        expect(await listed(member.token)).toEqual([]);
    });

    it('an admin writes personal rows too, and another member never sees, replaces or deletes them', async () => {
        const created = await call(admin.token, 'POST', PERSONAL, body());
        expect(created.status).toBe(CREATED);
        const { id } = created.json;
        expect(await listed(member.token)).toEqual([]);
        expect((await call(member.token, 'PUT', `${PERSONAL}/${id}`, body())).status).toBe(NOT_FOUND);
        expect((await call(member.token, 'DELETE', `${PERSONAL}/${id}`)).status).toBe(NOT_FOUND);
        expect(await listed(admin.token)).toHaveLength(1);
    });

    it('the org route never lists or touches a personal row, and the personal route never an org row', async () => {
        const mine = (await call(member.token, 'POST', PERSONAL, body())).json.id;
        const orgRow = (await call(admin.token, 'POST', SHARED_PATH, body())).json.id;
        expect((await listed(admin.token, SHARED_PATH)).map((s) => s.id)).toEqual([orgRow]);
        expect((await listed(member.token)).map((s) => s.id)).toEqual([mine]);
        expect((await call(admin.token, 'PUT', `${SHARED_PATH}/${mine}`, body())).status).toBe(NOT_FOUND);
        expect((await call(admin.token, 'DELETE', `${SHARED_PATH}/${mine}`)).status).toBe(NOT_FOUND);
        expect((await call(member.token, 'PUT', `${PERSONAL}/${orgRow}`, body())).status).toBe(NOT_FOUND);
        expect((await call(member.token, 'DELETE', `${PERSONAL}/${orgRow}`)).status).toBe(NOT_FOUND);
        expect(await listed(admin.token, SHARED_PATH)).toHaveLength(1);
    });

    it('an org token is refused on the personal routes', async () => {
        for (const method of ['GET', 'POST'] as const) {
            const response = await call(orgToken, method, PERSONAL, method === 'POST' ? body() : undefined);
            expect(response.status).toBe(FORBIDDEN);
        }
    });

    it('the webhook URL appears in no response and is stored under the user identity', async () => {
        const secret = `hook-secret-${randomUUID()}`;
        const created = await call(member.token, 'POST', PERSONAL, body({ credential: secret }));
        const put = await call(member.token, 'PUT', `${PERSONAL}/${created.json.id}`, body({ credential: secret }));
        const list = await call(member.token, 'GET', PERSONAL);
        for (const response of [created, put, list]) expect(response.text).not.toContain(secret);
        const [row] = await db.sql<{ secret_ref: string; secret_version: string; connector_config: unknown }[]>`
            select secret_ref, secret_version, connector_config from notification_subscription
            where org_id = ${orgId} and id = ${created.json.id}
        `;
        expect(JSON.stringify(row?.connector_config)).not.toContain(secret);
        const read = (userId: string | null) =>
            readSubscriptionCredential(
                secrets,
                {
                    identity: subscriptionSecretIdentity(orgId, created.json.id, userId),
                    ref: row!.secret_ref,
                    version: row!.secret_version,
                },
                AbortSignal.timeout(3000)
            );
        expect(await read(member.userId)).toBe(secret);
        expect(await read(null)).toBeNull();
    });

    it('GET carries connectorKinds on both routes', async () => {
        for (const path of [PERSONAL, SHARED_PATH]) {
            const response = await call(member.token, 'GET', path);
            expect(response.status).toBe(OK);
            expect([...response.json.connectorKinds].sort()).toEqual(['fake', 'other']);
        }
    });

    it('validation and kind-changed mirror the org route', async () => {
        expect((await call(member.token, 'POST', PERSONAL, body({ eventKinds: [] }))).status).toBe(BAD_REQUEST);
        const { credential: _omit, ...noCredential } = body();
        expect((await call(member.token, 'POST', PERSONAL, noCredential)).status).toBe(BAD_REQUEST);
        const { id } = (await call(member.token, 'POST', PERSONAL, body())).json;
        const { credential: _drop, ...rest } = body({ connectorKind: 'other' });
        expect((await call(member.token, 'PUT', `${PERSONAL}/${id}`, rest)).status).toBe(BAD_REQUEST);
        expect((await call(member.token, 'PUT', `${PERSONAL}/not-a-uuid`, body())).status).toBe(NOT_FOUND);
        expect(await listed(member.token)).toHaveLength(1);
    });
    describe('POST /:id/test', () => {
        it('the owner test send is 200 delivered with their credential, linking to the workspace page', async () => {
            const value = `hook-secret-${randomUUID()}`;
            const { id } = (await call(member.token, 'POST', PERSONAL, body({ credential: value }))).json;

            const sent = await call(member.token, 'POST', `${PERSONAL}/${id}/test`);

            expect(sent).toMatchObject({ status: OK, json: { result: { status: 'delivered' } } });
            expect(fake.sent).toHaveLength(1);
            expect(fake.sent[0]).toMatchObject({ credential: value });
            expect(fake.sent[0]!.event.link).toBe(`${ORIGIN}/settings/workspace`);
        });

        it("another member's id is 404 and nothing is sent", async () => {
            const { id } = (await call(member.token, 'POST', PERSONAL, body())).json;

            const refused = await call(admin.token, 'POST', `${PERSONAL}/${id}/test`);

            expect(refused.status).toBe(NOT_FOUND);
            expect(fake.sent).toEqual([]);
        });

        it('an org-row id is 404 on the personal path', async () => {
            const { id } = (await call(admin.token, 'POST', SHARED_PATH, body())).json;

            const refused = await call(admin.token, 'POST', `${PERSONAL}/${id}/test`);

            expect(refused.status).toBe(NOT_FOUND);
            expect(fake.sent).toEqual([]);
        });
    });
});
