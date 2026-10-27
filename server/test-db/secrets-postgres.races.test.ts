import postgres from 'postgres';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SecretRepo } from '../src/secrets/postgres-secret-repo.js';
import type { SecretRef } from '../src/secrets/secret-store.js';
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

function replicas() {
    const keys = new MutableKeys();
    const a = createPostgresHarness(db.sql, { keys, deadlineMs: 5000 });
    const b = createPostgresHarness(poolB, { keys, deadlineMs: 5000 });
    return { a, b, keys };
}

/** A repo whose operation lookup answers first and then waits: the answer is stale when the wait ends. */
function staleLookup(real: SecretRepo) {
    let looked!: () => void;
    let release!: () => void;
    const lookedUp = new Promise<void>((resolve) => {
        looked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const repo: SecretRepo = {
        ...real,
        async findOperation(operationId, budgetMs) {
            const row = await real.findOperation(operationId, budgetMs);
            looked();
            await gate;
            return row;
        },
    };
    return { repo, lookedUp, release };
}

const versionRows = async (ref: string) =>
    await db.sql<{ id: string; state: string; key_id: string }[]>`
        select id, state, key_id from secret_version where ref = ${ref}`;

describe.skipIf(!enabled)('operation-id races between replicas', () => {
    it('two deletes sharing one operation id on different references: one wins, the other conflicts and keeps its secret', async () => {
        const { a, b } = replicas();
        const identity = testIdentity();
        const first = await createSecret(a.open(), identity, utf8('first'));
        const second = await createSecret(a.open(), identity, utf8('second'));
        const operationId = await a.open().issueOperationId();

        const stale = staleLookup(b.realRepo);
        const loser = b.openWith(stale.repo).delete({
            identity,
            ref: second.ref,
            operationId,
            expectedVersion: second.version,
        });
        await stale.lookedUp;
        const winner = await a.open().delete({ identity, ref: first.ref, operationId, expectedVersion: first.version });
        stale.release();

        expect(winner.ok).toBe(true);
        expect(await loser).toEqual({ ok: false, error: { code: 'conflict', reason: 'operation-id-reused' } });
        const read = await a.open().readActive({ identity, ref: second.ref });
        expect(read.ok && new TextDecoder().decode(read.value)).toBe('second');
    });

    it('an identical create completed by another replica between lookup and preflight answers both callers the same', async () => {
        const { a, b } = replicas();
        const identity = testIdentity();
        const ref = `sec_${crypto.randomUUID()}` as SecretRef;
        const operationId = await a.open().issueOperationId();
        const input = { identity, ref, operationId, payload: utf8('same') };

        const stale = staleLookup(b.realRepo);
        const late = b.openWith(stale.repo).create(input);
        await stale.lookedUp;
        const first = await a.open().create(input);
        stale.release();

        expect(first.ok).toBe(true);
        expect(await late).toEqual(first);
    });
});

describe.skipIf(!enabled)('a staged envelope found on replay', () => {
    it('is authenticated before activation: a tampered one is an integrity failure and the old value stays', async () => {
        const { a } = replicas();
        const identity = testIdentity();
        const s = await createSecret(a.open(), identity, utf8('old'));
        const operationId = await a.open().issueOperationId();
        a.faults.onStep = (event) => {
            if (event.step === 'after-stage' && event.operationId === operationId) {
                throw new SimulatedCrash('after-stage');
            }
        };
        const input = { identity, ref: s.ref, operationId, expectedVersion: s.version, payload: utf8('new') };
        await expect(a.open().replace(input)).rejects.toBeInstanceOf(SimulatedCrash);
        a.faults.onStep = undefined;

        const staged = await db.sql<{ id: string; envelope: Buffer }[]>`
            select id, envelope from secret_version where ref = ${s.ref} and state = 'staged'`;
        const row = staged[0];
        if (!row) {
            throw new Error('no staged row to corrupt');
        }
        const flipped = Buffer.from(row.envelope);
        const at = 2 + (flipped[1] ?? 0) + 12;
        flipped[at] = (flipped[at] ?? 0) ^ 0xff;
        await db.sql`update secret_version set envelope = ${flipped} where id = ${row.id}`;

        const replay = await a.open().replace(input);
        expect(replay).toEqual({ ok: false, error: { code: 'integrity-failure', reason: 'integrity-check-failed' } });
        const read = await a.open().readActive({ identity, ref: s.ref });
        expect(read.ok && new TextDecoder().decode(read.value)).toBe('old');
        const op = await db.sql<
            { state: string }[]
        >`select state from secret_operation where operation_id = ${operationId}`;
        expect(op[0]?.state).not.toBe('succeeded');
        expect((await versionRows(s.ref)).find((v) => v.state === 'active')).toBeDefined();
    });
});

describe.skipIf(!enabled)('staging against a finished operation', () => {
    it('a replay paused before staging cannot recreate the version of a create that completed and was deleted', async () => {
        const { a, b, keys } = replicas();
        const identity = testIdentity();
        const ref = `sec_${crypto.randomUUID()}` as SecretRef;
        const createId = await a.open().issueOperationId();
        const input = { identity, ref, operationId: createId, payload: utf8('v') };

        let arrive!: () => void;
        let release!: () => void;
        const arrived = new Promise<void>((resolve) => {
            arrive = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        a.faults.onStep = async (event) => {
            if (event.step === 'after-intent' && event.operationId === createId) {
                arrive();
                await gate;
            }
        };
        const paused = a.open().create(input);
        await arrived;

        const done = await b.open().create(input);
        if (!done.ok) {
            throw new Error('replay refused');
        }
        const deleted = await b.open().delete({
            identity,
            ref,
            operationId: await b.open().issueOperationId(),
            expectedVersion: done.version,
        });
        expect(deleted.ok).toBe(true);
        expect(await versionRows(ref)).toHaveLength(0);

        release();
        expect((await paused).ok).toBe(true);
        await b.open().collect();
        expect(await versionRows(ref)).toHaveLength(0);
        expect(await b.open().verifyRetired(keys.activeKeyId)).toBe(0);
    });

    it('the collector removes a staged row owned by a finished operation and keeps one owned by an unresolved operation', async () => {
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
        a.faults.onStep = undefined;

        await a.open().collect();
        expect((await versionRows(s.ref)).map((v) => v.state).sort()).toEqual(['active', 'staged']);

        await db.sql`update secret_operation set state = 'failed', completed_at_ms = ${a.now()},
                            error_code = 'conflict', error_reason = 'stale-version'
                      where operation_id = ${operationId}`;
        await a.open().collect();
        expect((await versionRows(s.ref)).map((v) => v.state)).toEqual(['active']);
    });
});
