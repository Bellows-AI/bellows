import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { MAX_PROVIDER_CONNECTIONS_PER_SCOPE } from '@factory-ai/core';
import { EnvSecretError, readConnectionCredential } from '../src/db/provider-connection-secrets.js';
import {
    ProviderConnectionCapError,
    createProviderConnectionStore,
    type ProviderConnectionStore,
} from '../src/db/provider-connection-store.js';
import { failingPoolQuery, spySecrets, testSecretStore } from './env-secrets-harness.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import type { SecretStore } from '../src/secrets/secret-store.js';

/**
 * The provider connection store against Postgres and the real secret store (docs/secrets.md): a
 * connection row holds only its sealed reference, the identity is rebuilt from the row's slot on
 * every call, and a stored key survives every metadata edit until a committed deletion retires it.
 */
const enabled = Boolean(process.env.DATABASE_URL);

const ORG = testOrg();
const OTHER_ORG = testOrg();
const ALICE_USER = testUser('alice');
const BOB_USER = testUser('bob');
const ALICE = ALICE_USER.id;
const BOB = BOB_USER.id;
const KEY = 'sk-ant-provider-connection-store-test-0123456789';
const ROTATED = 'sk-ant-provider-connection-store-test-rotated-key';

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [ALICE_USER, BOB_USER] });

let sql: Sql;
let healthy: SecretStore;
let store: ProviderConnectionStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    healthy = testSecretStore(sql);
    store = createProviderConnectionStore({ sql, orgId: ORG, secrets: healthy, secretLog: () => {} });
});

type CreateInput = Parameters<ProviderConnectionStore['create']>[0];

const create = (over: Partial<CreateInput> = {}): CreateInput => ({
    scope: 'personal',
    userId: ALICE,
    provider: 'anthropic',
    name: 'main',
    baseUrl: null,
    key: KEY,
    ...over,
});

const rowOf = async (id: string) => {
    const [row] = await sql<{
        secret_ref: string;
        secret_version: string;
        user_id: string | null;
        provider: string;
        base_url: string | null;
        name: string;
    }[]>`select secret_ref, secret_version, user_id, provider, base_url, name
         from provider_connection where org_id = ${ORG} and id = ${id}`;
    return row;
};

describe.skipIf(!enabled)('the provider connection store', () => {
    it('stores only sealed references, the row carrying no key material', async () => {
        const made = await store.create(create());
        expect(made).toEqual({
            id: made.id,
            name: 'main',
            provider: 'anthropic',
            scope: 'personal',
            baseUrl: null,
            hasKey: true,
        });
        const row = (await rowOf(made.id))!;
        expect(row.secret_ref).toMatch(/^sec_[0-9a-f-]{36}$/);
        expect(row.secret_version).toBeTruthy();
        expect(JSON.stringify(row)).not.toContain(KEY);
        expect(row.user_id).toBe(ALICE);
        expect((await store.credentialFor(ALICE, made.id)).key).toBe(KEY);
    });

    it('a reference copied to another connection reads as identity-mismatch, never the key', async () => {
        const made = await store.create(create({ name: 'origin' }));
        const copied = randomUUID();
        await sql`
            insert into provider_connection (org_id, id, user_id, name, provider, secret_ref, secret_version)
            values (${ORG}, ${copied}, ${ALICE}, 'copy', 'anthropic',
                    (select secret_ref from provider_connection where org_id = ${ORG} and id = ${made.id}),
                    (select secret_version from provider_connection where org_id = ${ORG} and id = ${made.id}))
        `;
        try {
            await store.credentialFor(ALICE, copied);
            expect.unreachable('the copied reference read another connection\'s key');
        } catch (error) {
            expect(error).toBeInstanceOf(EnvSecretError);
            expect((error as EnvSecretError).code).toBe('identity-mismatch');
        }
    });

    it('a reference copied across organizations reads as identity-mismatch', async () => {
        const made = await store.create(create({ name: 'cross-org-origin' }));
        const copied = randomUUID();
        const origin = (await rowOf(made.id))!;
        await sql`
            insert into provider_connection (org_id, id, user_id, name, provider, secret_ref, secret_version)
            values (${OTHER_ORG}, ${copied}, null, 'copied', 'anthropic', ${origin.secret_ref}, ${origin.secret_version})
        `;
        const elsewhere = createProviderConnectionStore({
            sql,
            orgId: OTHER_ORG,
            secrets: healthy,
            secretLog: () => {},
        });
        try {
            await elsewhere.credentialFor(BOB, copied);
            expect.unreachable('the cross-organization copy read the key');
        } catch (error) {
            expect(error).toBeInstanceOf(EnvSecretError);
            expect((error as EnvSecretError).code).toBe('identity-mismatch');
        }
    });

    it('lists the member\'s own and the organization\'s, never another member\'s personal rows', async () => {
        const orgRow = await store.create(create({ scope: 'org', userId: ALICE, name: 'team' }));
        const own = await store.create(create({ name: 'mine' }));
        await store.create(create({ userId: BOB, name: 'bobs' }));

        const forAlice = await store.listFor(ALICE);
        expect(forAlice.map((c) => [c.scope, c.name])).toEqual([
            ['personal', 'mine'],
            ['org', 'team'],
        ]);
        expect(forAlice.map((c) => c.hasKey)).toEqual([true, true]);

        const forBob = await store.listFor(BOB);
        expect(forBob.map((c) => [c.scope, c.name])).toEqual([
            ['personal', 'bobs'],
            ['org', 'team'],
        ]);
        expect(forBob.map((c) => c.id)).not.toContain(own.id);
        expect((await store.forUser(ALICE, orgRow.id))?.scope).toBe('org');
        expect(await store.forUser(ALICE, randomUUID())).toBeNull();
    });

    it('holds several separately named connections for the same provider', async () => {
        const first = await store.create(create({ name: 'work' }));
        const second = await store.create(create({ name: 'personal-laptop' }));
        expect(first.id).not.toBe(second.id);
        expect(first.provider).toBe(second.provider);
        expect((await store.listFor(ALICE)).map((c) => c.name).sort()).toEqual(['personal-laptop', 'work']);
    });

    it('refuses a duplicate name within a scope and allows it across scopes', async () => {
        await store.create(create({ name: 'dup' }));
        await expect(store.create(create({ name: 'dup' }))).rejects.toMatchObject({ code: '23505' });
        const orgRow = await store.create(create({ name: 'dup', scope: 'org' }));
        expect(orgRow.scope).toBe('org');
        const bobRow = await store.create(create({ name: 'dup', userId: BOB }));
        expect(bobRow.scope).toBe('personal');
    });

    it('serializes a duplicate-name race to one winner', async () => {
        const settled = await Promise.allSettled(
            Array.from({ length: 6 }, () => store.create(create({ name: 'race' })))
        );
        expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(5);
    });

    it('caps a scope at MAX_PROVIDER_CONNECTIONS_PER_SCOPE under concurrency', async () => {
        expect(MAX_PROVIDER_CONNECTIONS_PER_SCOPE).toBe(20);
        const settled = await Promise.allSettled(
            Array.from({ length: MAX_PROVIDER_CONNECTIONS_PER_SCOPE + 5 }, (_, index) =>
                store.create(create({ name: `cap-${index}` }))
            )
        );
        const fulfilled = settled.filter((r) => r.status === 'fulfilled');
        expect(fulfilled).toHaveLength(MAX_PROVIDER_CONNECTIONS_PER_SCOPE);
        const refused = settled.filter(
            (r) => r.status === 'rejected' && r.reason instanceof ProviderConnectionCapError
        );
        expect(refused).toHaveLength(5);
        expect(await store.count('personal', ALICE)).toBe(MAX_PROVIDER_CONNECTIONS_PER_SCOPE);
    });

    it('a rename keeps the id and the sealed secret; a rotation reseals under the same id', async () => {
        const made = await store.create(create({ name: 'before' }));
        const before = (await rowOf(made.id))!;

        const renamed = await store.update(ALICE, made.id, { name: 'after' });
        expect(renamed).toMatchObject({ id: made.id, name: 'after', hasKey: true });
        expect((await rowOf(made.id))!.secret_ref).toBe(before.secret_ref);

        const rotated = await store.update(ALICE, made.id, { key: ROTATED });
        expect(rotated).toMatchObject({ id: made.id, name: 'after' });
        const after = (await rowOf(made.id))!;
        expect(after.secret_ref).not.toBe(before.secret_ref);
        expect(after.secret_version).not.toBe(before.secret_version);
        expect((await store.credentialFor(ALICE, made.id)).key).toBe(ROTATED);

        // The superseded secret is retired after the commit: reading it is an error, never the old key.
        try {
            await readConnectionCredential(healthy, {
                orgId: ORG,
                userId: ALICE,
                connectionId: made.id,
                name: made.name,
                ref: before.secret_ref,
                version: before.secret_version,
            });
            expect.unreachable('the retired secret read');
        } catch (error) {
            expect(error).toBeInstanceOf(EnvSecretError);
        }
    });

    it('a metadata edit keeps the credential', async () => {
        const made = await store.create(create({ name: 'keep' }));
        await store.update(ALICE, made.id, { name: 'kept', baseUrl: 'https://proxy.example.test' });
        expect(await store.forUser(ALICE, made.id)).toMatchObject({
            name: 'kept',
            baseUrl: 'https://proxy.example.test',
            hasKey: true,
        });
        expect((await store.credentialFor(ALICE, made.id)).key).toBe(KEY);
    });

    it('publishes the endpoint and the credential version together, and a stale reader fails closed', async () => {
        const made = await store.create(create({ name: 'atomic', baseUrl: 'https://old.example.test' }));
        const before = (await rowOf(made.id))!;
        await store.update(ALICE, made.id, { key: ROTATED, baseUrl: 'https://new.example.test' });
        const after = (await rowOf(made.id))!;
        // One statement wrote all three: a reader never sees the new endpoint beside the old version.
        expect(after.base_url).toBe('https://new.example.test');
        expect(after.secret_ref).not.toBe(before.secret_ref);
        try {
            await readConnectionCredential(healthy, {
                orgId: ORG,
                userId: ALICE,
                connectionId: made.id,
                name: made.name,
                ref: before.secret_ref,
                version: before.secret_version,
            });
            expect.unreachable('the superseded credential read');
        } catch (error) {
            expect(error).toBeInstanceOf(EnvSecretError);
        }
    });

    it('a failed rotation keeps the stored key and releases the fresh one', async () => {
        const spy = spySecrets(healthy);
        const spied = createProviderConnectionStore({ sql, orgId: ORG, secrets: spy.store, secretLog: () => {} });
        const made = await spied.create(create({ name: 'compensate' }));
        await spied.create(create({ name: 'taken' }));
        const createsBefore = spy.calls.creates.length;

        await expect(spied.update(ALICE, made.id, { name: 'taken', key: ROTATED })).rejects.toMatchObject({
            code: '23505',
        });

        expect((await spied.credentialFor(ALICE, made.id)).key).toBe(KEY);
        expect(spy.calls.creates).toHaveLength(createsBefore + 1);
        expect(spy.calls.deletes).toHaveLength(1);
    });

    it('a failed delete keeps the row and the secret; a committed one retires the secret', async () => {
        const made = await store.create(create({ name: 'doomed' }));
        const failing = failingPoolQuery(sql, 'delete from provider_connection');
        const broken = createProviderConnectionStore({ sql: failing, orgId: ORG, secrets: healthy, secretLog: () => {} });
        await expect(broken.remove(ALICE, made.id)).rejects.toThrow();
        expect(await store.forUser(ALICE, made.id)).not.toBeNull();
        expect((await store.credentialFor(ALICE, made.id)).key).toBe(KEY);

        expect(await broken.remove(BOB, made.id)).toBe(false);
        expect(await store.remove(ALICE, made.id)).toBe(true);
        expect(await store.forUser(ALICE, made.id)).toBeNull();
        const row = (await rowOf(made.id)) ?? { secret_ref: '', secret_version: '' };
        try {
            await readConnectionCredential(healthy, {
                orgId: ORG,
                userId: ALICE,
                connectionId: made.id,
                name: made.name,
                ref: row.secret_ref,
                version: row.secret_version,
            });
            expect.unreachable('the deleted connection\'s secret read');
        } catch (error) {
            expect(error).toBeInstanceOf(EnvSecretError);
        }
    });

    it('the org scope is owned by the organization and written through either door', async () => {
        const made = await store.create(create({ scope: 'org', name: 'org-owned' }));
        expect((await rowOf(made.id))!.user_id).toBeNull();
        // A member reads and uses it; only the org owner door (owner null) edits it.
        expect((await store.forUser(BOB, made.id))?.scope).toBe('org');
        expect((await store.credentialFor(BOB, made.id)).key).toBe(KEY);
        expect(await store.update(ALICE, made.id, { name: 'renamed-by-member' })).toBeNull();
        const renamed = await store.update(null, made.id, { name: 'renamed-by-org' });
        expect(renamed).toMatchObject({ id: made.id, scope: 'org' });
        expect(await store.count('org', ALICE)).toBe(1);
        expect(await store.count('personal', BOB)).toBe(0);
    });
});
