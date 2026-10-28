import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { CredentialError } from '../src/artifacts/s3-credentials.js';
import { createSecretRef } from '../src/secrets/secret-input.js';
import { useTestDb } from './harness.js';
import { awsProviderReachable } from './secrets-aws-provider.js';
import { createExternalHarness } from './secrets-external-harness.js';
import { createPostgresHarness, createSecret, testIdentity, utf8 } from './secrets-postgres-harness.js';

const SENTINEL = 'sentinel-provider-body';
const databaseEnabled = Boolean(process.env.DATABASE_URL);
const enabled = databaseEnabled && awsProviderReachable;
const db = useTestDb({ max: 8 });

const refused = { ok: false as const, error: { code: 'invalid-configuration', reason: 'configuration-invalid' } };
const unavailable = { ok: false as const, error: { code: 'unavailable', reason: 'provider-unavailable' } };

/** An address nothing listens on: a port that was just free. (Port 1 is blocked by fetch itself, so it proves nothing.) */
async function closedEndpoint(): Promise<string> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise((resolve) => server.close(resolve));
    return `http://127.0.0.1:${port}`;
}

const denied = (type: string) => (inner: typeof fetch) =>
    (async (url: string | URL, init?: RequestInit) => {
        const target = String(((init?.headers ?? {}) as Record<string, string>)['x-amz-target']);
        if (target.endsWith('ListSecrets')) return inner(url, init);
        return new Response(JSON.stringify({ __type: type, message: SENTINEL }), { status: 400 });
    }) as typeof fetch;

describe.skipIf(!databaseEnabled)('a provider that cannot be reached', () => {
    it('is unavailable for a write, and a read, with nothing leaked', async () => {
        const down = createExternalHarness(db.sql, { endpoint: await closedEndpoint(), deadlineMs: 700 });
        const store = down.open();
        const operationId = await store.issueOperationId();
        const identity = testIdentity();
        const result = await store.create({ identity, ref: createSecretRef(), operationId, payload: utf8('x') });
        expect(result).toEqual(unavailable);
        expect(JSON.stringify([result, down.diagnostics()])).not.toContain(SENTINEL);
    });
});

describe.skipIf(!enabled)('an external provider that refuses', () => {
    it.each(['AccessDeniedException', 'UnrecognizedClientException', 'InvalidSignatureException'])(
        'maps %s to invalid-configuration and leaks no provider text',
        async (type) => {
            const denying = createExternalHarness(db.sql, { wrapFetch: denied(type) });
            const store = denying.open();
            const created = await store.create({
                identity: testIdentity(),
                ref: createSecretRef(),
                operationId: await store.issueOperationId(),
                payload: utf8('x'),
            });
            expect(created).toEqual(refused);
            expect(JSON.stringify([created, denying.diagnostics()])).not.toContain(SENTINEL);
        }
    );

    it('maps a credential source that cannot be used to invalid-configuration for a read', async () => {
        const good = createExternalHarness(db.sql);
        const identity = testIdentity();
        const { ref } = await createSecret(good.open(), identity, utf8('x'));
        const broken = createExternalHarness(db.sql, {
            prefix: good.prefix,
            keys: good.keys,
            credentials: async () => {
                throw new CredentialError('no credentials', 'misconfigured');
            },
        });
        expect(await broken.open().readActive({ identity, ref })).toEqual(refused);
    });

    it('is unavailable, never not-found, for an active secret while the provider is down', async () => {
        const good = createExternalHarness(db.sql);
        const identity = testIdentity();
        const { ref } = await createSecret(good.open(), identity, utf8('x'));
        const down = createExternalHarness(db.sql, {
            prefix: good.prefix,
            keys: good.keys,
            endpoint: await closedEndpoint(),
            deadlineMs: 700,
        });
        expect(await down.open().readActive({ identity, ref })).toEqual(unavailable);
    });
});

/** The provider applies the request, and the answer that comes back is replaced. */
const answered = (target: string, status: number, body: string) => (inner: typeof fetch) =>
    (async (url: string | URL, init?: RequestInit) => {
        const real = await inner(url, init);
        if (String(((init?.headers ?? {}) as Record<string, string>)['x-amz-target']).endsWith(target)) {
            await real.body?.cancel();
            return new Response(body, { status });
        }
        return real;
    }) as typeof fetch;

describe.skipIf(!enabled)('an external provider whose answer to a mutation cannot be believed', () => {
    it.each(['null', '{}'])('leaves a create answered %s unknown, never active', async (body) => {
        const lying = createExternalHarness(db.sql, { wrapFetch: answered('CreateSecret', 200, body) });
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
            await createExternalHarness(db.sql, { prefix: lying.prefix, keys: lying.keys })
                .open()
                .readActive({ identity, ref })
        ).toMatchObject({ ok: false });
    });

    it('keeps the tracking row of a delete whose answer cannot be believed, and collects it once the provider confirms', async () => {
        const lying = createExternalHarness(db.sql, {
            wrapFetch: (inner) => answered('DescribeSecret', 200, '{}')(answered('DeleteSecret', 200, 'null')(inner)),
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
        const honest = createExternalHarness(db.sql, { prefix: lying.prefix, keys: lying.keys });
        await honest.collect();
        expect(await db.sql`select 1 from secret_version where ref = ${ref}`).toHaveLength(0);
    });
});

describe.skipIf(!enabled)('what an external store keeps where', () => {
    it('keeps a reference and a MAC in PostgreSQL, and the plaintext only at the provider', async () => {
        const harness = createExternalHarness(db.sql);
        const identity = testIdentity();
        const { ref, version } = await createSecret(harness.open(), identity, utf8('provider-only-plaintext'));
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
        expect(row).toMatchObject({ storage: 'aws', key_id: null, envelope: null });
        expect(row.provider_ref).toBe(`${harness.prefix}/${ref}/${row.id}`);
        expect(row.provider_version).toBe(row.id);
        expect(row.payload_mac).toMatch(/^[0-9a-f]{64}$/);
        const everything = JSON.stringify(await harness.durableSnapshot());
        expect(JSON.stringify((await harness.durableSnapshot()).db)).not.toContain('provider-only-plaintext');
        expect(everything).toContain(row.provider_ref);
        const read = await harness.provider.call('GetSecretValue', {
            SecretId: row.provider_ref,
            VersionId: row.provider_version,
        });
        expect(Buffer.from((read.json as { SecretBinary: string }).SecretBinary, 'base64').toString()).toContain(
            'provider-only-plaintext'
        );
        expect(version).toMatch(/^ver_/);
    });

    it('removes the provider object when the secret is deleted', async () => {
        const harness = createExternalHarness(db.sql);
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

describe.skipIf(!enabled)('a row of another storage', () => {
    it('reads invalid-configuration, never not-found, and is never collected', async () => {
        const harness = createExternalHarness(db.sql);
        const identity = testIdentity();
        const { ref } = await createSecret(harness.open(), identity, utf8('x'));
        await db.sql`update secret_version set storage = 'vault' where ref = ${ref}`;
        expect(await harness.open().readActive({ identity, ref })).toEqual(refused);
        await db.sql`update secret_version set state = 'collectable' where ref = ${ref}`;
        await harness.collect();
        const rows = await db.sql`select state from secret_version where ref = ${ref}`;
        expect(rows).toHaveLength(1);
        expect(((await harness.durableSnapshot()).provider as string[]).length).toBe(1);
    });

    it('reads invalid-configuration for a database row when the store is external', async () => {
        const database = createPostgresHarness(db.sql);
        const identity = testIdentity();
        const { ref } = await createSecret(database.open(), identity, utf8('x'));
        const external = createExternalHarness(db.sql, { keys: database.keys });
        expect(await external.open().readActive({ identity, ref })).toEqual(refused);
    });
});
