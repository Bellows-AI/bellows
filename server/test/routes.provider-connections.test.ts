import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProviderConnectionMeta } from '@factory-ai/core';
import { buildApp } from '../src/app.js';
import type { ProviderKeys } from '../src/provider-keys/verify.js';
import type { ProviderConnectionStore } from '../src/db/provider-connection-store.js';
import type { AppConfig } from '../src/config.js';
import { githubAuth, memoryAuthStore, signedIn, staticRegistry, testConfig } from './helpers.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_FORBIDDEN,
    HTTP_NOT_FOUND,
    HTTP_OK,
    HTTP_TOO_MANY_REQUESTS,
    trackApps,
} from './helpers-http.js';

/**
 * Offline: the HTTP contract of the provider connection routes against an in-memory store double.
 * The store's own rules — sealing, identity, retirement — are covered by server/test-db, which
 * needs a container. This file pins who may write which scope, the body rules, and that a stored
 * key never rides an answer or a log line.
 */

const track = trackApps();
const BASE = '/api/provider-connections';
const KEY = 'sk-ant-route-test-0123456789';

/** An in-memory ProviderConnectionStore, for the route contract only. */
function memoryProviderConnectionStore(): ProviderConnectionStore {
    interface Row {
        id: string;
        userId: string | null;
        name: string;
        provider: string;
        baseUrl: string | null;
        key: string;
    }
    const rows: Row[] = [];
    const metaOf = (row: Row): ProviderConnectionMeta => ({
        id: row.id,
        name: row.name,
        provider: row.provider as ProviderConnectionMeta['provider'],
        scope: row.userId === null ? 'org' : 'personal',
        baseUrl: row.baseUrl,
        hasKey: true,
    });
    const visible = (userId: string) => rows.filter((row) => row.userId === null || row.userId === userId);
    const owned = (owner: string | null, id: string) =>
        rows.find((row) => row.id === id && row.userId === owner);
    return {
        async listFor(userId) {
            return visible(userId).map(metaOf);
        },
        async forUser(userId, id) {
            const row = visible(userId).find((row) => row.id === id);
            return row ? metaOf(row) : null;
        },
        async count(scope, userId) {
            return rows.filter((row) => (scope === 'org' ? row.userId === null : row.userId === userId)).length;
        },
        async create(input) {
            const row: Row = {
                id: randomUUID(),
                userId: input.scope === 'org' ? null : input.userId,
                name: input.name,
                provider: input.provider,
                baseUrl: input.baseUrl,
                key: input.key,
            };
            rows.push(row);
            return metaOf(row);
        },
        async update(owner, id, patch) {
            const row = owned(owner, id);
            if (!row) return null;
            if (patch.name !== undefined) row.name = patch.name;
            if (patch.baseUrl !== undefined) row.baseUrl = patch.baseUrl;
            if (patch.key !== undefined) row.key = patch.key;
            return metaOf(row);
        },
        async remove(owner, id) {
            const index = rows.findIndex((row) => row.id === id && row.userId === owner);
            if (index === -1) return false;
            rows.splice(index, 1);
            return true;
        },
        async credentialFor(userId, id) {
            const row = visible(userId).find((row) => row.id === id);
            if (!row) return null;
            return { connection: metaOf(row), key: row.key };
        },
    };
}

const okChecker: ProviderKeys = { verify: async () => ({ ok: true, models: ['stub-model'] }) };

let clock = 0;

async function boot(overrides: Partial<AppConfig> = {}, checker: ProviderKeys | undefined = okChecker) {
    const auth = memoryAuthStore();
    const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
    const member = auth.seedMember('test-org', 'octocat');
    const store = memoryProviderConnectionStore();
    const config = testConfig({ auth: githubAuth(), ...overrides });
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, providerConnections: store }),
        auth,
        ...(checker ? { providerKeys: checker } : {}),
        now: () => clock,
    });
    track(app);
    return {
        app,
        store,
        admin: await signedIn(auth, admin),
        member: await signedIn(auth, member),
    };
}

type Booted = Awaited<ReturnType<typeof boot>>;

const call = (
    app: Booted['app'],
    cookie: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown
) =>
    app.inject({
        method,
        url,
        headers: { cookie, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(payload === undefined
            ? {}
            : { payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
    });

describe('POST /api/provider-connections', () => {
    it('a member creates a personal connection; an org write is admin-gated', async () => {
        const { app, member, admin } = await boot();
        const personal = await call(app, member, 'POST', BASE, {
            scope: 'personal',
            name: 'mine',
            provider: 'anthropic',
            key: KEY,
        });
        expect(personal.statusCode).toBe(201);
        expect(personal.json()).toMatchObject({ scope: 'personal', name: 'mine', provider: 'anthropic', hasKey: true });
        expect((personal.json() as { id: string }).id).toBeTruthy();

        const refused = await call(app, member, 'POST', BASE, {
            scope: 'org',
            name: 'team',
            provider: 'anthropic',
            key: KEY,
        });
        expect(refused.statusCode).toBe(HTTP_FORBIDDEN);
        expect(refused.json()).toMatchObject({ code: 'FORBIDDEN' });

        const byAdmin = await call(app, admin, 'POST', BASE, {
            scope: 'org',
            name: 'team',
            provider: 'anthropic',
            key: KEY,
        });
        expect(byAdmin.statusCode).toBe(201);
        expect(byAdmin.json()).toMatchObject({ scope: 'org' });
    });

    it.each([
        ['a key with whitespace', { scope: 'personal', name: 'x', provider: 'anthropic', key: `${KEY}\r\nx-evil: 1` }],
        ['a base URL that is not a URL', { scope: 'personal', name: 'x', provider: 'litellm', key: KEY, baseUrl: 'not a url' }],
        ['a base URL with userinfo', { scope: 'personal', name: 'x', provider: 'litellm', key: KEY, baseUrl: 'https://u:p@proxy.example.test' }],
        ['litellm without a base URL', { scope: 'personal', name: 'x', provider: 'litellm', key: KEY }],
        ['a base URL for a subscription', { scope: 'personal', name: 'x', provider: 'subscription', key: 'sk-ant-oat01-a', baseUrl: 'http://127.0.0.1:1' }],
        ['an unknown provider', { scope: 'personal', name: 'x', provider: 'mistral', key: KEY }],
        ['an unknown field', { scope: 'personal', name: 'x', provider: 'anthropic', key: KEY, extra: 1 }],
    ])('refuses %s as BAD_BODY', async (_label, payload) => {
        const { app, member } = await boot();
        const res = await call(app, member, 'POST', BASE, payload);
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json()).toMatchObject({ code: 'BAD_BODY' });
        expect(res.body).not.toContain(KEY);
    });

    it('cloud refuses a subscription connection', async () => {
        const { app, member } = await boot({ deploymentMode: 'cloud' });
        const res = await call(app, member, 'POST', BASE, {
            scope: 'personal',
            name: 'x',
            provider: 'subscription',
            key: 'sk-ant-oat01-a',
        });
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json()).toMatchObject({ code: 'CLOUD_CREDENTIAL_REFUSED' });
    });
});

describe('PUT and DELETE /api/provider-connections/:id', () => {
    it('edits metadata; an omitted key retains it; provider and scope are immutable', async () => {
        const { app, store, member } = await boot();
        const made = await call(app, member, 'POST', BASE, {
            scope: 'personal',
            name: 'before',
            provider: 'anthropic',
            key: KEY,
        });
        const id = (made.json() as { id: string }).id;

        const edited = await call(app, member, 'PUT', `${BASE}/${id}`, { name: 'after', baseUrl: 'https://proxy.example.test' });
        expect(edited.statusCode).toBe(HTTP_OK);
        expect(edited.json()).toMatchObject({ id, name: 'after', baseUrl: 'https://proxy.example.test', hasKey: true });

        const providerMove = await call(app, member, 'PUT', `${BASE}/${id}`, { provider: 'openai' });
        expect(providerMove.statusCode).toBe(HTTP_BAD_REQUEST);
        const scopeMove = await call(app, member, 'PUT', `${BASE}/${id}`, { scope: 'org' });
        expect(scopeMove.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(scopeMove.json()).toMatchObject({ code: 'BAD_SCOPE' });

        const listed = await call(app, member, 'GET', BASE);
        expect((listed.json() as { connections: { id: string; name: string }[] }).connections).toEqual([
            { id, name: 'after', provider: 'anthropic', scope: 'personal', baseUrl: 'https://proxy.example.test', hasKey: true },
        ]);
    });

    it('a member may delete a personal row but not an org row; an unknown id is 404', async () => {
        const { app, admin, member } = await boot();
        const orgRow = await call(app, admin, 'POST', BASE, { scope: 'org', name: 'team', provider: 'anthropic', key: KEY });
        const orgId = (orgRow.json() as { id: string }).id;
        const refused = await call(app, member, 'DELETE', `${BASE}/${orgId}`);
        expect(refused.statusCode).toBe(HTTP_FORBIDDEN);

        const personal = await call(app, member, 'POST', BASE, { scope: 'personal', name: 'mine', provider: 'anthropic', key: KEY });
        const personalId = (personal.json() as { id: string }).id;
        const foreign = await call(app, admin, 'DELETE', `${BASE}/${personalId}`);
        expect(foreign.statusCode).toBe(HTTP_NOT_FOUND);
        const removed = await call(app, member, 'DELETE', `${BASE}/${personalId}`);
        expect(removed.statusCode).toBe(HTTP_OK);
        const gone = await call(app, member, 'GET', `${BASE}/${personalId}/models`);
        expect(gone.statusCode).toBe(HTTP_NOT_FOUND);
    });
});

describe('GET /api/provider-connections/:id/models', () => {
    it('answers discovery through the stored key and never echoes it', async () => {
        const { app, member } = await boot();
        const made = await call(app, member, 'POST', BASE, { scope: 'personal', name: 'x', provider: 'anthropic', key: KEY });
        const id = (made.json() as { id: string }).id;
        const res = await call(app, member, 'GET', `${BASE}/${id}/models`);
        expect(res.statusCode).toBe(HTTP_OK);
        expect(res.json()).toEqual({ state: 'listed', models: ['stub-model'] });
        expect(res.body).not.toContain(KEY);
    });

    it('another member\'s personal connection is not discoverable', async () => {
        const { app, admin, member } = await boot();
        const made = await call(app, member, 'POST', BASE, { scope: 'personal', name: 'x', provider: 'anthropic', key: KEY });
        const id = (made.json() as { id: string }).id;
        const res = await call(app, admin, 'GET', `${BASE}/${id}/models`);
        expect(res.statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('is rate-limited per member', async () => {
        const { app, member } = await boot();
        const made = await call(app, member, 'POST', BASE, { scope: 'personal', name: 'x', provider: 'anthropic', key: KEY });
        const id = (made.json() as { id: string }).id;
        for (let i = 0; i < 10; i += 1) {
            const res = await call(app, member, 'GET', `${BASE}/${id}/models`);
            expect(res.statusCode).toBe(HTTP_OK);
        }
        const limited = await call(app, member, 'GET', `${BASE}/${id}/models`);
        expect(limited.statusCode).toBe(HTTP_TOO_MANY_REQUESTS);
        expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
        clock += 61_000;
        const recovered = await call(app, member, 'GET', `${BASE}/${id}/models`);
        expect(recovered.statusCode).toBe(HTTP_OK);
    });

    it('a malformed JSON body that carries the key is refused without echoing it', async () => {
        const { app, member } = await boot();
        const res = await call(app, member, 'POST', BASE, `{"provider":"anthropic","key":"${KEY}",`);
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.body).not.toContain(KEY);
    });
});
