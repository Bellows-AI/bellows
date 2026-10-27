import { describe, expect, it } from 'vitest';
import type { SecretRepo } from '../src/secrets/postgres-secret-repo.js';
import type { SecretIdentity, SecretRef } from '../src/secrets/secret-store.js';
import { SimulatedCrash } from '../test/secrets-conformance.js';
import { useTestDb } from './harness.js';
import { MutableKeys, createPostgresHarness, createSecret, testIdentity, utf8 } from './secrets-postgres-harness.js';

const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 8 });

interface Seeded {
    identity: SecretIdentity;
    ref: SecretRef;
    version: string;
    value: string;
}

async function seedFive(h: ReturnType<typeof createPostgresHarness>): Promise<Seeded[]> {
    const out: Seeded[] = [];
    for (let i = 0; i < 5; i += 1) {
        const identity = testIdentity();
        const value = `payload-${i}`;
        const s = await createSecret(h.open(), identity, utf8(value));
        out.push({ identity, ref: s.ref, version: s.version, value });
    }
    return out;
}

const activeKeys = async () =>
    await db.sql<{ ref: string; key_id: string; logical_version: string }[]>`
        select a.ref, v.key_id, a.logical_version
          from secret_active a join secret_version v on v.id = a.version_id order by a.ref`;

describe.skipIf(!enabled)('key rotation', () => {
    it('rotation interrupted mid-run resumes', async () => {
        const h = createPostgresHarness(db.sql);
        const seeded = await seedFive(h);
        h.keys.addActive();

        let swaps = 0;
        const crashing: SecretRepo = {
            ...h.realRepo,
            async rekeySwap(ref, expectedVersionId, next, budgetMs) {
                swaps += 1;
                if (swaps === 3) {
                    throw new SimulatedCrash('before-activate');
                }
                return h.realRepo.rekeySwap(ref, expectedVersionId, next, budgetMs);
            },
        };
        await expect(h.openWith(crashing).rotate({ batchSize: 2 })).rejects.toBeInstanceOf(SimulatedCrash);
        const midway = await activeKeys();
        expect(midway.filter((r) => r.key_id === h.keys.activeKeyId)).toHaveLength(2);
        expect(midway.filter((r) => r.key_id === 'k1')).toHaveLength(3);

        const summary = await h.open().rotate({ batchSize: 2 });
        expect(summary).toEqual({ rekeyed: 3, skipped: 0, failed: 0 });
        const done = await activeKeys();
        expect(done.every((r) => r.key_id === h.keys.activeKeyId)).toBe(true);
        for (const s of seeded) {
            expect(done.find((r) => r.ref === s.ref)?.logical_version).toBe(s.version);
        }
        expect(await h.open().verifyRetired('k1')).toBe(0);

        const retired = createPostgresHarness(db.sql, {
            keys: new MutableKeys({ keys: h.keys, only: [h.keys.activeKeyId] }),
        });
        for (const s of seeded) {
            const read = await retired.open().readActive({ identity: s.identity, ref: s.ref });
            expect(read.ok && new TextDecoder().decode(read.value)).toBe(s.value);
            expect(read.ok && read.version).toBe(s.version);
        }
    });

    it('rotation racing a replace skips the lost swap and never resurrects the old value', async () => {
        const h = createPostgresHarness(db.sql);
        const [target] = await seedFive(h);
        h.keys.addActive();
        const s = target as Seeded;

        let raced = false;
        const racing: SecretRepo = {
            ...h.realRepo,
            async rekeySwap(ref, expectedVersionId, next, budgetMs) {
                if (!raced && ref === s.ref) {
                    raced = true;
                    const replaced = await h.open().replace({
                        identity: s.identity,
                        ref: s.ref,
                        operationId: await h.open().issueOperationId(),
                        expectedVersion: s.version as never,
                        payload: utf8('replaced meanwhile'),
                    });
                    expect(replaced.ok).toBe(true);
                }
                return h.realRepo.rekeySwap(ref, expectedVersionId, next, budgetMs);
            },
        };
        const summary = await h.openWith(racing).rotate();
        expect(summary.skipped).toBe(1);
        expect(summary.failed).toBe(0);
        const read = await h.open().readActive({ identity: s.identity, ref: s.ref });
        expect(read.ok && new TextDecoder().decode(read.value)).toBe('replaced meanwhile');
        expect(read.ok && read.version).not.toBe(s.version);
        const rows = await activeKeys();
        expect(rows.every((r) => r.key_id === h.keys.activeKeyId)).toBe(true);
    });

    it('verifyRetired counts a staged version of an unresolved operation', async () => {
        const h = createPostgresHarness(db.sql);
        const identity = testIdentity();
        const s = await createSecret(h.open(), identity, utf8('one'));
        const operationId = await h.open().issueOperationId();
        h.faults.onStep = (event) => {
            if (event.step === 'after-stage' && event.operationId === operationId) {
                throw new SimulatedCrash('after-stage');
            }
        };
        await expect(
            h.open().replace({ identity, ref: s.ref, operationId, expectedVersion: s.version, payload: utf8('two') })
        ).rejects.toBeInstanceOf(SimulatedCrash);
        h.faults.onStep = undefined;
        h.keys.addActive();
        expect(await h.open().rotate()).toEqual({ rekeyed: 1, skipped: 0, failed: 0 });
        expect(await h.open().verifyRetired('k1')).toBe(1);
        const status = await h.open().reconcileOperation({ identity, ref: s.ref, operationId });
        expect(status.ok && status.status.state).toBe('succeeded');
    });
});
