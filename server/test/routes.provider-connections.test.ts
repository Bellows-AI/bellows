import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_PROVIDER_CONNECTIONS_PER_SCOPE, type ProviderConnectionMeta } from '@factory-ai/core';
import { buildApp } from '../src/app.js';
import type { ProviderKeys } from '../src/provider-keys/verify.js';
import { ProviderConnectionCapError,
    ProviderConnectionReferencedError, type ProviderConnectionStore } from '../src/db/provider-connection-store.js';
import type { AppConfig } from '../src/config.js';
import { githubAuth, memoryAuthStore, signedIn, staticRegistry, testConfig } from './helpers.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_CREATED,
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
const ROTATED = 'sk-ant-route-test-rotated-key';
/** What the double's `remove` refuses with, by connection id: the executors that select it (the SQL store's foreign key). */
const references = new Map<string, { executors: { name: string; scope: 'org' | 'personal' }[]; other: boolean }>();

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
    const owned = (owner: string | null, id: string) => rows.find((row) => row.id === id && row.userId === owner);
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
            const scopeCount = rows.filter((row) =>
                input.scope === 'org' ? row.userId === null : row.userId === input.userId
            ).length;
            // The real store refuses inside its own transaction; the double mirrors the refusal.
            if (scopeCount >= MAX_PROVIDER_CONNECTIONS_PER_SCOPE) throw new ProviderConnectionCapError();
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
            const refs = references.get(id);
            if (refs) throw new ProviderConnectionReferencedError(refs.executors, refs.other);
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
        async claimCredentialFor() {
            // The route contract never claims; the claim's read is covered against PostgreSQL.
            throw new Error('claimCredentialFor is not part of the route contract');
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
    /** The injected request a signed-in cookie drives: app-bound, so a call names only the caller. */
    const inject = (cookie: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
        app.inject({
            method,
            url,
            headers: { cookie, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(payload === undefined
                ? {}
                : { payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
        });
    return {
        admin: await signedIn(auth, admin),
        member: await signedIn(auth, member),
        inject,
    };
}

describe('POST /api/provider-connections', () => {
    it('a member creates a personal connection; an org write is admin-gated', async () => {
        const { member, admin, inject } = await boot();
        const personal = await inject(member, 'POST', BASE, {
            scope: 'personal',
            name: 'mine',
            provider: 'anthropic',
            key: KEY,
        });
        expect(personal.statusCode).toBe(201);
        expect(personal.json()).toMatchObject({ scope: 'personal', name: 'mine', provider: 'anthropic', hasKey: true });
        expect((personal.json() as { id: string }).id).toBeTruthy();

        const refused = await inject(member, 'POST', BASE, {
            scope: 'org',
            name: 'team',
            provider: 'anthropic',
            key: KEY,
        });
        expect(refused.statusCode).toBe(HTTP_FORBIDDEN);
        expect(refused.json()).toMatchObject({ code: 'FORBIDDEN' });

        const byAdmin = await inject(admin, 'POST', BASE, {
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
        [
            'a base URL that is not a URL',
            { scope: 'personal', name: 'x', provider: 'litellm', key: KEY, baseUrl: 'not a url' },
        ],
        [
            'a base URL with userinfo',
            { scope: 'personal', name: 'x', provider: 'litellm', key: KEY, baseUrl: 'https://u:p@proxy.example.test' },
        ],
        ['litellm without a base URL', { scope: 'personal', name: 'x', provider: 'litellm', key: KEY }],
        [
            'a base URL for a subscription',
            {
                scope: 'personal',
                name: 'x',
                provider: 'subscription',
                key: 'sk-ant-oat01-a',
                baseUrl: 'http://127.0.0.1:1',
            },
        ],
        ['an unknown provider', { scope: 'personal', name: 'x', provider: 'mistral', key: KEY }],
        ['an unknown field', { scope: 'personal', name: 'x', provider: 'anthropic', key: KEY, extra: 1 }],
    ])('refuses %s as BAD_BODY', async (_label, payload) => {
        const { member, inject } = await boot();
        const res = await inject(member, 'POST', BASE, payload);
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json()).toMatchObject({ code: 'BAD_BODY' });
        expect(res.body).not.toContain(KEY);
    });

    it('cloud refuses a subscription connection', async () => {
        const { member, inject } = await boot({ deploymentMode: 'cloud' });
        const res = await inject(member, 'POST', BASE, {
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
    it('a rotation replaces the stored key: the checker sees the replacement, and the omitted key keeps the old one', async () => {
        const seen: string[] = [];
        const echoChecker: ProviderKeys = {
            verify: async (input) => {
                seen.push(input.key);
                return { ok: true, models: [input.key] };
            },
        };
        const { member, inject } = await boot({}, echoChecker);
        const made = await inject(member, 'POST', BASE, {
            scope: 'personal',
            name: 'x',
            provider: 'anthropic',
            key: KEY,
        });
        const id = (made.json() as { id: string }).id;
        expect(await inject(member, 'GET', `${BASE}/${id}/models`)).toMatchObject({
            statusCode: HTTP_OK,
        });
        expect(seen).toEqual([KEY]);

        const rotated = await inject(member, 'PUT', `${BASE}/${id}`, { key: ROTATED });
        expect(rotated.statusCode).toBe(HTTP_OK);
        await inject(member, 'GET', `${BASE}/${id}/models`);
        expect(seen).toEqual([KEY, ROTATED]);

        // An edit without a key keeps the stored one: no rotation is minted.
        await inject(member, 'PUT', `${BASE}/${id}`, { name: 'renamed' });
        await inject(member, 'GET', `${BASE}/${id}/models`);
        expect(seen).toEqual([KEY, ROTATED, ROTATED]);
    });

    it('edits metadata; provider and scope are immutable', async () => {
        const { member, inject } = await boot();
        const made = await inject(member, 'POST', BASE, {
            scope: 'personal',
            name: 'before',
            provider: 'anthropic',
            key: KEY,
        });
        const id = (made.json() as { id: string }).id;

        const edited = await inject(member, 'PUT', `${BASE}/${id}`, {
            name: 'after',
            baseUrl: 'https://proxy.example.test',
        });
        expect(edited.statusCode).toBe(HTTP_OK);
        expect(edited.json()).toMatchObject({ id, name: 'after', baseUrl: 'https://proxy.example.test', hasKey: true });

        const providerMove = await inject(member, 'PUT', `${BASE}/${id}`, { provider: 'openai' });
        expect(providerMove.statusCode).toBe(HTTP_BAD_REQUEST);
        const scopeMove = await inject(member, 'PUT', `${BASE}/${id}`, { scope: 'org' });
        expect(scopeMove.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(scopeMove.json()).toMatchObject({ code: 'BAD_SCOPE' });

        const listed = await inject(member, 'GET', BASE);
        expect((listed.json() as { connections: { id: string; name: string }[] }).connections).toEqual([
            {
                id,
                name: 'after',
                provider: 'anthropic',
                scope: 'personal',
                baseUrl: 'https://proxy.example.test',
                hasKey: true,
            },
        ]);
    });

    it('the create over the per-scope cap answers the cap refusal, not an internal error', async () => {
        const { member, inject } = await boot();
        for (let i = 0; i < MAX_PROVIDER_CONNECTIONS_PER_SCOPE; i += 1) {
            const made = await inject(member, 'POST', BASE, {
                scope: 'personal',
                name: `cap-${i}`,
                provider: 'anthropic',
                key: KEY,
            });
            expect(made.statusCode).toBe(HTTP_CREATED);
        }
        const over = await inject(member, 'POST', BASE, {
            scope: 'personal',
            name: 'over',
            provider: 'anthropic',
            key: KEY,
        });
        expect(over.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(over.json()).toMatchObject({ code: 'TOO_MANY_CONNECTIONS' });
    });

    it('refuses to delete a connection executors still select, naming what the caller may see', async () => {
        const { member, inject } = await boot();
        const made = await inject(member, 'POST', BASE, {
            scope: 'personal',
            name: 'busy',
            provider: 'anthropic',
            key: KEY,
        });
        const id = (made.json() as { id: string }).id;
        references.set(id, { executors: [{ name: 'my-exec', scope: 'personal' }], other: true });

        const refused = await inject(member, 'DELETE', `${BASE}/${id}`);

        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toMatchObject({
            code: 'PROVIDER_CONNECTION_IN_USE',
            executors: [{ name: 'my-exec', scope: 'personal' }],
            otherReferences: true,
        });
        references.delete(id);
        expect((await inject(member, 'DELETE', `${BASE}/${id}`)).statusCode).toBe(HTTP_OK);
    });

    it('a member may delete a personal row but not an org row; an unknown id is 404', async () => {
        const { admin, member, inject } = await boot();
        const orgRow = await inject(admin, 'POST', BASE, {
            scope: 'org',
            name: 'team',
            provider: 'anthropic',
            key: KEY,
        });
        const orgId = (orgRow.json() as { id: string }).id;
        const refused = await inject(member, 'DELETE', `${BASE}/${orgId}`);
        expect(refused.statusCode).toBe(HTTP_FORBIDDEN);

        const personal = await inject(member, 'POST', BASE, {
            scope: 'personal',
            name: 'mine',
            provider: 'anthropic',
            key: KEY,
        });
        const personalId = (personal.json() as { id: string }).id;
        const foreign = await inject(admin, 'DELETE', `${BASE}/${personalId}`);
        expect(foreign.statusCode).toBe(HTTP_NOT_FOUND);
        const removed = await inject(member, 'DELETE', `${BASE}/${personalId}`);
        expect(removed.statusCode).toBe(HTTP_OK);
        const gone = await inject(member, 'GET', `${BASE}/${personalId}/models`);
        expect(gone.statusCode).toBe(HTTP_NOT_FOUND);
    });
});

describe('GET /api/provider-connections/:id/models', () => {
    it('answers discovery through the stored key and never echoes it', async () => {
        const { member, inject } = await boot();
        const made = await inject(member, 'POST', BASE, {
            scope: 'personal',
            name: 'x',
            provider: 'anthropic',
            key: KEY,
        });
        const id = (made.json() as { id: string }).id;
        const res = await inject(member, 'GET', `${BASE}/${id}/models`);
        expect(res.statusCode).toBe(HTTP_OK);
        expect(res.json()).toEqual({ state: 'listed', models: ['stub-model'] });
        expect(res.body).not.toContain(KEY);
    });

    it("another member's personal connection is not discoverable", async () => {
        const { admin, member, inject } = await boot();
        const made = await inject(member, 'POST', BASE, {
            scope: 'personal',
            name: 'x',
            provider: 'anthropic',
            key: KEY,
        });
        const id = (made.json() as { id: string }).id;
        const res = await inject(admin, 'GET', `${BASE}/${id}/models`);
        expect(res.statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('is rate-limited per member', async () => {
        const { member, inject } = await boot();
        const made = await inject(member, 'POST', BASE, {
            scope: 'personal',
            name: 'x',
            provider: 'anthropic',
            key: KEY,
        });
        const id = (made.json() as { id: string }).id;
        for (let i = 0; i < 10; i += 1) {
            const res = await inject(member, 'GET', `${BASE}/${id}/models`);
            expect(res.statusCode).toBe(HTTP_OK);
        }
        const limited = await inject(member, 'GET', `${BASE}/${id}/models`);
        expect(limited.statusCode).toBe(HTTP_TOO_MANY_REQUESTS);
        expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
        clock += 61_000;
        const recovered = await inject(member, 'GET', `${BASE}/${id}/models`);
        expect(recovered.statusCode).toBe(HTTP_OK);
    });

    it('a malformed JSON body that carries the key is refused with fixed text, on create and on edit', async () => {
        const { member, inject } = await boot();
        const post = await inject(member, 'POST', BASE, `{"provider":"anthropic","key":"${KEY}",`);
        expect(post.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(post.json()).toMatchObject({
            code: 'BAD_BODY',
            error: 'The connection body could not be read',
        });
        expect(post.body).not.toContain(KEY);

        const made = await inject(member, 'POST', BASE, {
            scope: 'personal',
            name: 'x',
            provider: 'anthropic',
            key: KEY,
        });
        const id = (made.json() as { id: string }).id;
        const put = await inject(member, 'PUT', `${BASE}/${id}`, `{"key":"${KEY}",`);
        expect(put.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(put.json()).toMatchObject({ code: 'BAD_BODY', error: 'The connection body could not be read' });
        expect(put.body).not.toContain(KEY);
    });
});
