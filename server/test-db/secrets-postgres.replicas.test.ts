import postgres from 'postgres';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatedCrash } from '../test/secrets-conformance.js';
import { useTestDb } from './harness.js';
import { MutableKeys, createPostgresHarness, createSecret, testIdentity, utf8 } from './secrets-postgres-harness.js';

const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 8 });

let poolB: Sql;
beforeAll(() => {
    if (enabled) {
        poolB = postgres(process.env.DATABASE_URL as string, { max: 4 });
    }
});
afterAll(async () => {
    await poolB?.end({ timeout: 5 });
});

/** Two store instances over two pools and one database stand in for two dashboard replicas. */
function replicas() {
    const keys = new MutableKeys();
    const a = createPostgresHarness(db.sql, { keys, deadlineMs: 5000 });
    const b = createPostgresHarness(poolB, { keys, deadlineMs: 5000 });
    return { a, b, keys };
}

const versionCount = async (ref: string) =>
    Number((await db.sql`select count(*)::int as n from secret_version where ref = ${ref}`)[0]?.n);

describe.skipIf(!enabled)('two replicas over one database', () => {
    it('replace/replace: one winner', async () => {
        const { a, b } = replicas();
        const identity = testIdentity();
        const s = await createSecret(a.open(), identity, utf8('one'));
        const attempt = async (h: typeof a, value: string) =>
            h.open().replace({
                identity,
                ref: s.ref,
                operationId: await h.open().issueOperationId(),
                expectedVersion: s.version,
                payload: utf8(value),
            });
        const [ra, rb] = await Promise.all([attempt(a, 'from a'), attempt(b, 'from b')]);
        expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
        const loser = ra.ok ? rb : ra;
        expect(loser).toEqual({ ok: false, error: { code: 'conflict', reason: 'stale-version' } });
        const winner = ra.ok ? ra : rb;
        const read = await a.open().readActive({ identity, ref: s.ref });
        expect(read.ok && read.version).toBe(winner.ok && winner.version);
        expect(read.ok && new TextDecoder().decode(read.value)).toBe(ra.ok ? 'from a' : 'from b');
    });

    it('replace/delete: one winner', async () => {
        const { a, b } = replicas();
        const identity = testIdentity();
        const s = await createSecret(a.open(), identity, utf8('one'));
        const [replaced, deleted] = await Promise.all([
            a.open().replace({
                identity,
                ref: s.ref,
                operationId: await a.open().issueOperationId(),
                expectedVersion: s.version,
                payload: utf8('two'),
            }),
            b.open().delete({
                identity,
                ref: s.ref,
                operationId: await b.open().issueOperationId(),
                expectedVersion: s.version,
            }),
        ]);
        expect([replaced.ok, deleted.ok].filter(Boolean)).toHaveLength(1);
        const read = await a.open().readActive({ identity, ref: s.ref });
        if (deleted.ok) {
            expect(replaced).toEqual({ ok: false, error: { code: 'conflict', reason: 'stale-version' } });
            expect(read).toEqual({ ok: false, error: { code: 'not-found', reason: 'reference-not-found' } });
        } else {
            expect(deleted).toEqual({ ok: false, error: { code: 'conflict', reason: 'stale-version' } });
            expect(read.ok && new TextDecoder().decode(read.value)).toBe('two');
        }
    });

    it('the collector on replica B never removes a version replica A is about to activate', async () => {
        const { a, b } = replicas();
        const identity = testIdentity();
        const s = await createSecret(a.open(), identity, utf8('one'));
        const operationId = await a.open().issueOperationId();
        let release!: () => void;
        let arrive!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const arrived = new Promise<void>((resolve) => {
            arrive = resolve;
        });
        a.faults.onStep = async (event) => {
            if (event.step === 'before-activate' && event.operationId === operationId) {
                arrive();
                await gate;
            }
        };
        const paused = a.open().replace({
            identity,
            ref: s.ref,
            operationId,
            expectedVersion: s.version,
            payload: utf8('two'),
        });
        await arrived;
        expect(await versionCount(s.ref)).toBe(2);
        await b.open().collect();
        expect(await versionCount(s.ref)).toBe(2);
        release();
        expect((await paused).ok).toBe(true);
        const read = await b.open().readActive({ identity, ref: s.ref });
        expect(read.ok && new TextDecoder().decode(read.value)).toBe('two');
    });

    it('the guarded delete refuses an active version and the staged version of an unresolved operation', async () => {
        const { a } = replicas();
        const identity = testIdentity();
        const s = await createSecret(a.open(), identity, utf8('one'));
        const operationId = await a.open().issueOperationId();
        a.faults.onStep = (event) => {
            if (event.step === 'after-stage' && event.operationId === operationId) {
                throw new SimulatedCrash('after-stage');
            }
        };
        await expect(
            a.open().replace({ identity, ref: s.ref, operationId, expectedVersion: s.version, payload: utf8('two') })
        ).rejects.toBeInstanceOf(SimulatedCrash);
        const rows = await db.sql<
            { id: string; state: string }[]
        >`select id, state from secret_version where ref = ${s.ref}`;
        expect(rows.map((r) => r.state).sort()).toEqual(['active', 'staged']);
        for (const row of rows) {
            expect(await a.realRepo.retireVersion(row.id, 'database', 1000), row.state).toBeNull();
        }
        expect(await versionCount(s.ref)).toBe(2);
    });

    it('two concurrent collectors converge without error', async () => {
        const { a, b } = replicas();
        const identity = testIdentity();
        const refs: string[] = [];
        for (let i = 0; i < 4; i += 1) {
            const s = await createSecret(a.open(), identity, utf8('v0'));
            refs.push(s.ref);
            let version = s.version;
            for (let n = 1; n <= 3; n += 1) {
                const next = await a.open().replace({
                    identity,
                    ref: s.ref,
                    operationId: await a.open().issueOperationId(),
                    expectedVersion: version,
                    payload: utf8(`v${n}`),
                });
                if (!next.ok) {
                    throw new Error('replace refused');
                }
                version = next.version;
            }
        }
        await expect(Promise.all([a.open().collect(), b.open().collect()])).resolves.toBeDefined();
        for (const ref of refs) {
            expect(await versionCount(ref)).toBe(1);
        }
    });
});
