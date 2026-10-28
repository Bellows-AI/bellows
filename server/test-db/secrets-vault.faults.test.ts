import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createSecretRef } from '../src/secrets/secret-input.js';
import { useTestDb } from './harness.js';
import { createVaultHarness } from './secrets-vault-harness.js';
import {
    VAULT_TEST_MOUNT,
    limitedToken,
    listPaths,
    vaultApi,
    vaultProviderReachable,
} from './secrets-vault-provider.js';
import { createSecret, testIdentity, utf8 } from './secrets-postgres-harness.js';

const SENTINEL = 'sentinel-provider-body';
const databaseEnabled = Boolean(process.env.DATABASE_URL);
const enabled = databaseEnabled && vaultProviderReachable;
const db = useTestDb({ max: 8 });

const refused = { ok: false as const, error: { code: 'invalid-configuration', reason: 'configuration-invalid' } };
const unavailable = { ok: false as const, error: { code: 'unavailable', reason: 'provider-unavailable' } };
const integrity = { ok: false as const, error: { code: 'integrity-failure', reason: 'integrity-check-failed' } };

/** An address nothing listens on: a port that was just free. */
async function closedEndpoint(): Promise<string> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise((resolve) => server.close(resolve));
    return `http://127.0.0.1:${port}`;
}

const create = async (store: ReturnType<ReturnType<typeof createVaultHarness>['open']>) =>
    store.create({
        identity: testIdentity(),
        ref: createSecretRef(),
        operationId: await store.issueOperationId(),
        payload: utf8('x'),
    });

describe.skipIf(!databaseEnabled)('a vault that cannot be reached', () => {
    it('is unavailable for a write, with nothing leaked', async () => {
        const down = createVaultHarness(db.sql, { endpoint: await closedEndpoint(), deadlineMs: 700 });
        const result = await create(down.open());
        expect(result).toEqual(unavailable);
        expect(JSON.stringify([result, down.diagnostics()])).not.toContain(SENTINEL);
    });
});

describe.skipIf(!enabled)('a vault that refuses', () => {
    it('maps a token Vault does not know to invalid-configuration and leaks neither token nor reply', async () => {
        const wrongToken = `hvs.${SENTINEL}`;
        const refusing = createVaultHarness(db.sql, { token: wrongToken });
        const created = await create(refusing.open());
        expect(created).toEqual(refused);
        expect(JSON.stringify([created, refusing.diagnostics()])).not.toContain(SENTINEL);
        expect(JSON.stringify([created, refusing.diagnostics()])).not.toContain('permission denied');
    });

    it('maps a policy-denied token to invalid-configuration for a write, and for a read of an active secret', async () => {
        const good = createVaultHarness(db.sql);
        const identity = testIdentity();
        const { ref } = await createSecret(good.open(), identity, utf8('x'));
        const limited = await limitedToken(`path "${VAULT_TEST_MOUNT}/data/nowhere/*" { capabilities = ["read"] }`);
        const denied = createVaultHarness(db.sql, { prefix: good.prefix, keys: good.keys, token: limited });
        expect(await denied.open().readActive({ identity, ref })).toEqual(refused);
        expect(await create(createVaultHarness(db.sql, { token: limited }).open())).toEqual(refused);
    });

    it('keeps the row of a delete the token may not perform, and collects it with a token that may', async () => {
        const good = createVaultHarness(db.sql);
        const identity = testIdentity();
        const { ref, version } = await createSecret(good.open(), identity, utf8('x'));
        const noDelete = await limitedToken(
            `path "${VAULT_TEST_MOUNT}/data/${good.prefix}/*" { capabilities = ["create", "read", "update"] }`
        );
        const limited = createVaultHarness(db.sql, { prefix: good.prefix, keys: good.keys, token: noDelete });
        const store = limited.open();
        await store.delete({ identity, ref, operationId: await store.issueOperationId(), expectedVersion: version });
        await limited.collect();
        expect(await db.sql`select 1 from secret_version where ref = ${ref}`).toHaveLength(1);
        expect(await listPaths(good.prefix)).toHaveLength(1);
        await good.collect();
        expect(await db.sql`select 1 from secret_version where ref = ${ref}`).toHaveLength(0);
        expect(await listPaths(good.prefix)).toEqual([]);
    });
});

describe.skipIf(!enabled)('a provider object that was deleted or destroyed behind the store', () => {
    it.each(['delete', 'destroy'])(
        'is an integrity failure, never not-found, after a %s of its version',
        async (how) => {
            const harness = createVaultHarness(db.sql);
            const identity = testIdentity();
            const { ref } = await createSecret(harness.open(), identity, utf8('x'));
            const [path] = await listPaths(harness.prefix);
            const done = await vaultApi('POST', `${VAULT_TEST_MOUNT}/${how}/${path}`, { versions: [1] });
            expect(done.status).toBeLessThan(300);
            expect(await harness.open().readActive({ identity, ref })).toEqual(integrity);
        }
    );

    it('is an integrity failure when the whole secret was deleted by metadata', async () => {
        const harness = createVaultHarness(db.sql);
        const identity = testIdentity();
        const { ref } = await createSecret(harness.open(), identity, utf8('x'));
        const [path] = await listPaths(harness.prefix);
        await vaultApi('DELETE', `${VAULT_TEST_MOUNT}/metadata/${path}`);
        expect(await harness.open().readActive({ identity, ref })).toEqual(integrity);
    });
});

/** The provider applies the request, and the answer that comes back is replaced. */
const answered =
    (match: (method: string, url: string) => boolean, status: number, body: string) => (inner: typeof fetch) =>
        (async (url: string | URL, init?: RequestInit) => {
            const real = await inner(url, init);
            if (match(init?.method ?? 'GET', String(url))) {
                await real.body?.cancel();
                return new Response(body, { status });
            }
            return real;
        }) as typeof fetch;

describe.skipIf(!enabled)('a vault whose answer to a mutation cannot be believed', () => {
    it.each(['null', '{}', '{"data":{"version":2}}'])(
        'leaves a create answered %s unknown, never active',
        async (body) => {
            const lying = createVaultHarness(db.sql, {
                wrapFetch: answered((method, url) => method === 'POST' && url.includes('/data/'), 200, body),
            });
            const store = lying.open();
            const identity = testIdentity();
            const ref = createSecretRef();
            const created = await store.create({
                identity,
                ref,
                operationId: await store.issueOperationId(),
                payload: utf8('x'),
            });
            expect(created.ok).toBe(false);
            expect(created).not.toEqual(unavailable);
            expect(
                await createVaultHarness(db.sql, { prefix: lying.prefix, keys: lying.keys })
                    .open()
                    .readActive({ identity, ref })
            ).toMatchObject({ ok: false });
        }
    );

    it.each([
        ['a 200 with null', 200, 'null'],
        ['a 404 that carries metadata', 404, '{"data":{"metadata":{}},"errors":[]}'],
        ['an HTML 404', 404, '<html>'],
    ])(
        'keeps the tracking row of a delete answered with %s, and collects it once the provider confirms',
        async (_label, status, body) => {
            const lying = createVaultHarness(db.sql, {
                wrapFetch: answered((method, url) => method === 'DELETE' && url.includes('/metadata/'), status, body),
            });
            const store = lying.open();
            const identity = testIdentity();
            const { ref, version } = await createSecret(store, identity, utf8('x'));
            await store.delete({
                identity,
                ref,
                operationId: await store.issueOperationId(),
                expectedVersion: version,
            });
            await lying.collect();
            expect(await db.sql`select 1 from secret_version where ref = ${ref}`).toHaveLength(1);
            const honest = createVaultHarness(db.sql, { prefix: lying.prefix, keys: lying.keys });
            await honest.collect();
            expect(await db.sql`select 1 from secret_version where ref = ${ref}`).toHaveLength(0);
        }
    );
});

describe.skipIf(!enabled)('what a vault store keeps where', () => {
    it('keeps a reference and a MAC in PostgreSQL, and the plaintext only at the provider', async () => {
        const harness = createVaultHarness(db.sql);
        const identity = testIdentity();
        const { ref } = await createSecret(harness.open(), identity, utf8('provider-only-plaintext'));
        const rows = await db.sql<
            {
                id: string;
                storage: string;
                key_id: string | null;
                envelope: Buffer | null;
                provider_ref: string;
                provider_version: string;
                payload_mac: string;
            }[]
        >`select id, storage, key_id, envelope, provider_ref, provider_version, payload_mac from secret_version where ref = ${ref}`;
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row).toMatchObject({ storage: 'vault', key_id: null, envelope: null });
        expect(row.provider_ref).toBe(`${harness.prefix}/${ref}/${row.id}`);
        expect(row.provider_version).toBe(row.id);
        expect(row.payload_mac).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify((await harness.durableSnapshot()).db)).not.toContain('provider-only-plaintext');
        const read = await vaultApi<{ data: { data: { payload: string } } }>(
            'GET',
            `${VAULT_TEST_MOUNT}/data/${row.provider_ref}?version=1`
        );
        expect(Buffer.from(read.json.data.data.payload, 'base64').toString()).toBe('provider-only-plaintext');
    });

    it('removes the provider object, every version of it, when the secret is deleted', async () => {
        const harness = createVaultHarness(db.sql);
        const store = harness.open();
        const identity = testIdentity();
        const { ref, version } = await createSecret(store, identity, utf8('gone'));
        expect(((await harness.durableSnapshot()).provider as string[]).length).toBe(1);
        const deleted = await store.delete({
            identity,
            ref,
            operationId: await store.issueOperationId(),
            expectedVersion: version,
        });
        expect(deleted.ok).toBe(true);
        expect((await harness.durableSnapshot()).provider).toEqual([]);
        expect(await db.sql`select 1 from secret_version where ref = ${ref}`).toHaveLength(0);
    });
});
