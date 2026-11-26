import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore } from '../src/auth/store.js';
import { createProviderKeys } from '../src/provider-keys/verify.js';
import { createOrgRegistry } from '../src/orgs.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import {
    type FakeProvider,
    modelList,
    openRouterKey,
    serverError,
    startFakeProvider,
} from '../test/fake-provider.js';
import { githubAuth, testConfig } from '../test/helpers-config.js';
import { testSecretStore } from './env-secrets-harness.js';
import { useTestDb } from './harness.js';
import { randomGithubId, testOrg } from './fixtures.js';

/**
 * The provider connection routes through the real app, org registry, store and secret store, with the
 * provider HTTP faked (docs/api.md): discovery runs the real checker against the sealed stored key, and
 * no answer carries the key or its reference.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb();
const BASE = '/api/provider-connections';
const OK = 200;
const CREATED = 201;
const NOT_FOUND = 404;
const KEY = 'sk-ant-routes-test-0123456789abcdef';

let app: FastifyInstance;
let admin: string;
let member: string;
let outsider: string;
let orgId: string;
let secrets: SecretStore;
let fake: FakeProvider;

beforeAll(async () => {
    if (!enabled) return;
    fake = await startFakeProvider();
});

afterEach(async () => {
    if (enabled) await app?.close();
});

const boot = async () => {
    const sql = db.sql;
    secrets = testSecretStore(sql);
    const [firstOrg, otherOrg] = [testOrg(), testOrg()];
    for (const id of [firstOrg, otherOrg]) {
        await sql`insert into organization (id, name) values (${id}, ${`org-${id}`})`;
    }
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
            label: 'provider connections',
            tokenHash: hashToken(token),
        });
        return token;
    };
    orgId = firstOrg;
    admin = await tokenFor(firstOrg);
    member = await tokenFor(firstOrg);
    outsider = await tokenFor(otherOrg);

    const ready = Promise.resolve();
    const config = testConfig({ auth: githubAuth(), integrations: { callbackOrigin: null, jira: null, linear: null } });
    app = await buildApp({
        config,
        orgs: createOrgRegistry({ sql, ready, config, withStores: true, secrets, secretLog: () => {} }),
        auth,
        ready,
        version: '0.0.0',
        providerKeys: createProviderKeys({
            deploymentMode: 'self-hosted',
            endpoints: { anthropic: fake.origin, openai: fake.origin, openrouter: `${fake.origin}/api` },
        }),
    });
};

const call = async (
    token: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown
): Promise<{ status: number; json: ReturnType<JSON['parse']>; body: string }> => {
    const response = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: response.statusCode, json: response.json(), body: response.body };
};

const createConnection = (
    token: string,
    over: Record<string, unknown> = {}
): Promise<{ status: number; json: { id?: string }; body: string }> =>
    call(token, 'POST', BASE, {
        scope: 'personal',
        name: `conn-${randomUUID().slice(0, 8)}`,
        provider: 'anthropic',
        key: KEY,
        ...over,
    });

describe.skipIf(!enabled)('the provider connection routes', () => {
    it('discovers models through the stored sealed credential, the key riding one header alone', async () => {
        await boot();
        fake.reply('/v1/models', modelList('claude-sonnet-4-5', 'claude-opus-4-5'));
        const made = await createConnection(admin);
        expect(made.status).toBe(CREATED);
        const listed = await call(admin, 'GET', `${BASE}/${made.json.id}/models`);
        expect(listed.status).toBe(OK);
        expect(listed.json).toEqual({ state: 'listed', models: ['claude-sonnet-4-5', 'claude-opus-4-5'] });
        expect(fake.requests).toHaveLength(1);
        expect(fake.requests[0]!.headers['x-api-key']).toBe(KEY);
        expect(listed.body).not.toContain(KEY);
        expect(listed.body).not.toContain('sec_');
    });

    it('a successful empty catalog is listed with no models, never unsupported', async () => {
        await boot();
        fake.reply('/v1/models', modelList());
        const made = await createConnection(admin);
        const listed = await call(admin, 'GET', `${BASE}/${made.json.id}/models`);
        expect(listed.status).toBe(OK);
        expect(listed.json).toEqual({ state: 'listed', models: [] });
    });

    it('openrouter verifies the credit and answers unsupported, with no model catalog', async () => {
        await boot();
        fake.reply('/api/v1/key', openRouterKey(4.5));
        const made = await createConnection(admin, { provider: 'openrouter', name: 'or' });
        const listed = await call(admin, 'GET', `${BASE}/${made.json.id}/models`);
        expect(listed.status).toBe(OK);
        expect(listed.json).toEqual({
            state: 'unsupported',
            creditUsd: 4.5,
            budget: { limitUsd: 10, usedUsd: 2.5 },
        });
    });

    it('a subscription connection has no discovery and asks no provider', async () => {
        await boot();
        const made = await createConnection(admin, {
            provider: 'subscription',
            name: 'sub',
            key: 'sk-ant-oat01-routes-test',
        });
        const listed = await call(admin, 'GET', `${BASE}/${made.json.id}/models`);
        expect(listed.status).toBe(OK);
        expect(listed.json).toEqual({ state: 'unsupported' });
        expect(fake.requests).toEqual([]);
    });

    it('an upstream failure is a failed answer, never an authoritative empty list', async () => {
        await boot();
        fake.reply('/v1/models', serverError);
        const made = await createConnection(admin);
        const listed = await call(admin, 'GET', `${BASE}/${made.json.id}/models`);
        expect(listed.status).toBe(OK);
        expect(listed.json).toMatchObject({ state: 'failed' });
        expect(listed.json.models).toBeUndefined();
    });

    it('a member discovers through an org connection but not through another member\'s personal one', async () => {
        await boot();
        fake.reply('/v1/models', modelList('shared-model'));
        const orgRow = await createConnection(admin, { scope: 'org', name: 'team' });
        const personal = await createConnection(member, { name: 'mine' });
        const throughOrg = await call(member, 'GET', `${BASE}/${orgRow.json.id}/models`);
        expect(throughOrg.status).toBe(OK);
        expect(throughOrg.json).toEqual({ state: 'listed', models: ['shared-model'] });
        const foreign = await call(admin, 'GET', `${BASE}/${personal.json.id}/models`);
        expect(foreign.status).toBe(NOT_FOUND);
    });

    it('the list answers safe metadata alone: no key material and no secret reference', async () => {
        await boot();
        await createConnection(admin, { name: 'alpha' });
        await createConnection(admin, { scope: 'org', name: 'beta' });
        const list = await call(member, 'GET', BASE);
        expect(list.status).toBe(OK);
        const connections = list.json.connections as { name: string; baseUrl: string | null; hasKey: boolean }[];
        // The member's own rows first, then the organization's.
        expect(connections.map((c) => c.name)).toEqual(['alpha', 'beta']);
        expect(connections.every((c) => c.hasKey)).toBe(true);
        expect(list.body).not.toContain(KEY);
        expect(list.body).not.toContain('sec_');
        expect(Object.keys(connections[0]!).sort()).toEqual(['baseUrl', 'hasKey', 'id', 'name', 'provider', 'scope']);
    });
});
