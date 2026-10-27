import { describe, expect, it } from 'vitest';
import type { SecretRepo } from '../src/secrets/postgres-secret-repo.js';
import { useTestDb } from './harness.js';
import { createPostgresHarness, createSecret, dbError, testIdentity, utf8 } from './secrets-postgres-harness.js';

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
