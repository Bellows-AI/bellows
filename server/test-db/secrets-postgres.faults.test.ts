import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DatabasePayloads } from '../src/secrets/database-payloads.js';
import type { SecretRepo } from '../src/secrets/postgres-secret-repo.js';
import { type PayloadStore, ProviderFault } from '../src/secrets/secret-payloads.js';
import { useTestDb } from './harness.js';
import {
    createPostgresHarness,
    createSecret,
    dbError,
    externalPayloads,
    testIdentity,
    utf8,
} from './secrets-postgres-harness.js';

const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 8 });

/** A repo whose `stageVersion` is scripted: it sees every attempt and may throw before the real insert. */
function scripted(real: SecretRepo, script: (call: number) => Error | null) {
    const calls: string[] = [];
    const repo: SecretRepo = {
        ...real,
        async stageVersion(version, budgetMs) {
            calls.push(version.operationId ?? '');
            const failure = script(calls.length);
            if (failure) {
                throw failure;
            }
            return real.stageVersion(version, budgetMs);
        },
    };
    return { repo, calls };
}

/** The database payload store with some of its calls replaced: a fault between two payload calls. */
const wrapped =
    (over: Partial<PayloadStore>) =>
    (database: DatabasePayloads): PayloadStore => ({
        storage: database.storage,
        twoPhase: database.twoPhase,
        prepare: (...args) => database.prepare(...args),
        holds: (...args) => database.holds(...args),
        write: () => database.write(),
        read: (row, aad) => database.read(row, aad),
        remove: () => database.remove(),
        ...over,
    });

const versionStates = async (ref: string) =>
    db.sql<{ id: string; state: string; storage: string }[]>`
        select id, state, storage from secret_version where ref = ${ref} order by created_at_ms, id`;

describe.skipIf(!enabled)('payload store faults', () => {
    it('a failed external payload removal leaves the version deleting; never activated, never dropped; the next collect removes it', async () => {
        const h = createPostgresHarness(db.sql, { deadlineMs: 3000 });
        const identity = testIdentity();
        let failing = true;
        const external = externalPayloads({
            async remove() {
                if (failing) {
                    throw new ProviderFault('retry');
                }
            },
        });
        const store = h.openWith(h.faultyRepo, external.factory);
        const seeded = await createSecret(store, identity, utf8('one'));
        const deleted = await store.delete({
            identity,
            ref: seeded.ref,
            operationId: await store.issueOperationId(),
            expectedVersion: seeded.version,
        });
        expect(deleted.ok).toBe(true);
        expect((await versionStates(seeded.ref)).map((v) => v.state)).toEqual(['deleting']);
        const active = await db.sql`select 1 from secret_active where ref = ${seeded.ref}`;
        expect(active).toHaveLength(0);

        // A collection that cannot remove the payload keeps the row; nothing activates a deleting version.
        expect((await store.collect()).removed).toBe(0);
        expect((await versionStates(seeded.ref)).map((v) => v.state)).toEqual(['deleting']);

        failing = false;
        expect((await store.collect()).removed).toBe(1);
        expect(await versionStates(seeded.ref)).toHaveLength(0);
    });

    /** A repo that records the two-phase calls and may crash between them. */
    function spied(real: SecretRepo, crashOnDrop = false) {
        const calls: string[] = [];
        const repo: SecretRepo = {
            ...real,
            async retireVersion(id, storage, budgetMs) {
                calls.push('retire');
                return real.retireVersion(id, storage, budgetMs);
            },
            async dropVersion(id, budgetMs) {
                calls.push('drop');
                if (crashOnDrop) {
                    throw dbError('08006');
                }
                return real.dropVersion(id, budgetMs);
            },
        };
        return { repo, calls };
    }

    it('a database version is removed in one statement and never passes through deleting', async () => {
        const h = createPostgresHarness(db.sql, { deadlineMs: 3000 });
        const identity = testIdentity();
        const { repo, calls } = spied(h.realRepo, true);
        const store = h.openWith(repo);
        const seeded = await createSecret(store, identity, utf8('one'));
        const deleted = await store.delete({
            identity,
            ref: seeded.ref,
            operationId: await store.issueOperationId(),
            expectedVersion: seeded.version,
        });
        expect(deleted.ok).toBe(true);
        expect(await versionStates(seeded.ref)).toHaveLength(0);
        expect(calls).toEqual([]);
    });

    it('a database removal that fails leaves the state 091 knows, so the previous release still collects it', async () => {
        const h = createPostgresHarness(db.sql, { deadlineMs: 3000 });
        const identity = testIdentity();
        const seeded = await createSecret(h.open(), identity, utf8('one'));
        h.faults.providerDelete = 'fail';
        const store = h.open();
        await store.delete({
            identity,
            ref: seeded.ref,
            operationId: await store.issueOperationId(),
            expectedVersion: seeded.version,
        });
        expect((await versionStates(seeded.ref)).map((v) => v.state)).toEqual(['cleanup-pending']);
        const { repo, calls } = spied(h.realRepo, true);
        expect((await h.openWith(repo).collect()).removed).toBe(1);
        expect(calls).toEqual([]);
        expect(await versionStates(seeded.ref)).toHaveLength(0);
    });

    it('a timed-out external removal never drops the row', async () => {
        const h = createPostgresHarness(db.sql, { deadlineMs: 150 });
        const identity = testIdentity();
        let hang = true;
        const external = externalPayloads({ remove: () => (hang ? new Promise<void>(() => {}) : Promise.resolve()) });
        const plain = h.openWith(h.faultyRepo, external.factory);
        const seeded = await createSecret(plain, identity, utf8('one'));
        h.faults.providerDelete = 'fail';
        await plain.delete({
            identity,
            ref: seeded.ref,
            operationId: await plain.issueOperationId(),
            expectedVersion: seeded.version,
        });
        h.faults.providerDelete = 'ok';
        expect((await versionStates(seeded.ref)).map((v) => v.state)).toEqual(['cleanup-pending']);

        const store = plain;
        const started = Date.now();
        expect((await store.collect()).removed).toBe(0);
        expect(Date.now() - started).toBeLessThan(150 + 500);
        expect((await versionStates(seeded.ref)).map((v) => v.state)).toEqual(['deleting']);

        hang = false;
        expect((await store.collect()).removed).toBe(1);
        expect(await versionStates(seeded.ref)).toHaveLength(0);
    });

    it('a write that answers exists is believed only when the object reads back as this payload', async () => {
        const h = createPostgresHarness(db.sql, { deadlineMs: 3000 });
        const identity = testIdentity();
        const ours = h.openWith(h.faultyRepo, wrapped({ write: async () => 'exists' }));
        const created = await createSecret(ours, identity, utf8('same'));
        const read = await ours.readActive({ identity, ref: created.ref });
        expect(read.ok && new TextDecoder().decode(read.value)).toBe('same');

        const foreign = h.openWith(
            h.faultyRepo,
            wrapped({ write: async () => 'exists', read: async () => utf8('someone else') })
        );
        const ref = `sec_${randomUUID()}` as never;
        const result = await foreign.create({
            identity,
            ref,
            operationId: await foreign.issueOperationId(),
            payload: utf8('same'),
        });
        expect(result).toEqual({ ok: false, error: { code: 'integrity-failure', reason: 'integrity-check-failed' } });
    });

    it('a misconfigured payload fault is invalid-configuration on a write and a read, never a failed operation', async () => {
        const h = createPostgresHarness(db.sql, { deadlineMs: 3000 });
        const identity = testIdentity();
        const seeded = await createSecret(h.open(), identity, utf8('one'));
        const invalid = { ok: false, error: { code: 'invalid-configuration', reason: 'configuration-invalid' } };
        const broken = h.openWith(
            h.faultyRepo,
            wrapped({
                async write() {
                    throw new ProviderFault('misconfigured');
                },
                async read() {
                    throw new ProviderFault('misconfigured');
                },
            })
        );
        expect(await broken.readActive({ identity, ref: seeded.ref })).toEqual(invalid);
        const operationId = await broken.issueOperationId();
        expect(
            await broken.replace({
                identity,
                ref: seeded.ref,
                operationId,
                expectedVersion: seeded.version,
                payload: utf8('two'),
            })
        ).toEqual(invalid);
        const [op] = await db.sql<
            { state: string }[]
        >`select state from secret_operation where operation_id = ${operationId}`;
        expect(op?.state).toBe('pending');
    });

    it('a row of another storage reads invalid-configuration and is never collected', async () => {
        const h = createPostgresHarness(db.sql, { deadlineMs: 3000 });
        const identity = testIdentity();
        const seeded = await createSecret(h.open(), identity, utf8('one'));
        const store = h.open();
        const replaced = await store.replace({
            identity,
            ref: seeded.ref,
            operationId: await store.issueOperationId(),
            expectedVersion: seeded.version,
            payload: utf8('two'),
        });
        expect(replaced.ok).toBe(true);
        const rows = await versionStates(seeded.ref);
        expect(rows.map((v) => v.state).sort()).toEqual(['active', 'collectable']);
        await db.sql`
            update secret_version
               set storage = 'aws', key_id = null, envelope = null, provider_ref = 'p/' || id, payload_mac = 'mac'
             where ref = ${seeded.ref}`;

        expect(await store.readActive({ identity, ref: seeded.ref })).toEqual({
            ok: false,
            error: { code: 'invalid-configuration', reason: 'configuration-invalid' },
        });
        expect((await store.collect()).removed).toBe(0);
        expect(await versionStates(seeded.ref)).toHaveLength(2);
    });
});

describe.skipIf(!enabled)('database faults', () => {
    it('a retryable SQLSTATE retries with the same operation id and succeeds', async () => {
        const h = createPostgresHarness(db.sql, { deadlineMs: 3000 });
        const identity = testIdentity();
        const seeded = await createSecret(h.open(), identity, utf8('one'));
        const { repo, calls } = scripted(h.realRepo, (n) => (n <= 2 ? dbError('40001') : null));
        const store = h.openWith(repo);
        const operationId = await store.issueOperationId();
        const result = await store.replace({
            identity,
            ref: seeded.ref,
            operationId,
            expectedVersion: seeded.version,
            payload: utf8('two'),
        });
        expect(result.ok).toBe(true);
        expect(calls).toEqual([operationId, operationId, operationId]);
        const ops = await db.sql`select 1 from secret_operation where operation_id = ${operationId}`;
        expect(ops).toHaveLength(1);
    });

    it('a persistent one is unavailable within deadlineMs + 500 ms of wall clock', async () => {
        const h = createPostgresHarness(db.sql, { deadlineMs: 300 });
        const identity = testIdentity();
        const seeded = await createSecret(h.open(), identity, utf8('one'));
        const { repo } = scripted(h.realRepo, () => dbError('53300'));
        const started = Date.now();
        const result = await h.openWith(repo).replace({
            identity,
            ref: seeded.ref,
            operationId: await h.open().issueOperationId(),
            expectedVersion: seeded.version,
            payload: utf8('two'),
        });
        expect(Date.now() - started).toBeLessThan(300 + 500);
        expect(result).toEqual({ ok: false, error: { code: 'unavailable', reason: 'provider-unavailable' } });
    });

    it('a SQLSTATE outside the transient classes is unavailable without a retry', async () => {
        const h = createPostgresHarness(db.sql, { deadlineMs: 3000 });
        const identity = testIdentity();
        const seeded = await createSecret(h.open(), identity, utf8('one'));
        const { repo, calls } = scripted(h.realRepo, () => dbError('23505'));
        const result = await h.openWith(repo).replace({
            identity,
            ref: seeded.ref,
            operationId: await h.open().issueOperationId(),
            expectedVersion: seeded.version,
            payload: utf8('two'),
        });
        expect(calls).toHaveLength(1);
        expect(result).toEqual({ ok: false, error: { code: 'unavailable', reason: 'provider-unavailable' } });
    });

    it('an ambiguous write is not retried and leaves the operation unknown', async () => {
        const h = createPostgresHarness(db.sql, { deadlineMs: 3000 });
        const identity = testIdentity();
        const seeded = await createSecret(h.open(), identity, utf8('one'));
        const { repo, calls } = scripted(h.realRepo, () => dbError('CONNECTION_CLOSED'));
        const store = h.openWith(repo);
        const operationId = await store.issueOperationId();
        const result = await store.replace({
            identity,
            ref: seeded.ref,
            operationId,
            expectedVersion: seeded.version,
            payload: utf8('two'),
        });
        expect(calls).toHaveLength(1);
        expect(result).toEqual({ ok: false, error: { code: 'outcome-unknown', reason: 'provider-timeout' } });
        const [op] = await db.sql<
            { state: string }[]
        >`select state from secret_operation where operation_id = ${operationId}`;
        expect(op?.state).toBe('unknown');
    });

    it('a code the store does not know is rethrown, never mapped', async () => {
        const h = createPostgresHarness(db.sql, { deadlineMs: 3000 });
        const identity = testIdentity();
        const seeded = await createSecret(h.open(), identity, utf8('one'));
        const { repo } = scripted(h.realRepo, () => new TypeError('a bug'));
        await expect(
            h.openWith(repo).replace({
                identity,
                ref: seeded.ref,
                operationId: await h.open().issueOperationId(),
                expectedVersion: seeded.version,
                payload: utf8('two'),
            })
        ).rejects.toThrow('a bug');
    });

    it('before migrations are ready a call is unavailable, never not-found', async () => {
        const identity = testIdentity();
        const base = createPostgresHarness(db.sql);
        const seeded = await createSecret(base.open(), identity, utf8('one'));
        const keys = base.keys;
        const pending = createPostgresHarness(db.sql, { keys, deadlineMs: 100, ready: new Promise(() => {}) }).open();
        const failed = Promise.reject(new Error('migration failed'));
        failed.catch(() => {});
        const broken = createPostgresHarness(db.sql, { keys, deadlineMs: 100, ready: failed }).open();
        const unavailable = { ok: false, error: { code: 'unavailable', reason: 'provider-unavailable' } };
        for (const store of [pending, broken]) {
            expect(await store.readActive({ identity, ref: seeded.ref })).toEqual(unavailable);
            expect(
                await store.reconcileOperation({ identity, ref: seeded.ref, operationId: seeded.operationId })
            ).toEqual(unavailable);
            expect(
                await store.replace({
                    identity,
                    ref: seeded.ref,
                    operationId: await store.issueOperationId(),
                    expectedVersion: seeded.version,
                    payload: utf8('two'),
                })
            ).toEqual(unavailable);
        }
    });
});
