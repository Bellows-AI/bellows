import { describe, expect, it } from 'vitest';
import type { SecretRef } from '../src/secrets/secret-store.js';
import { useTestDb } from './harness.js';
import { MutableKeys, createPostgresHarness, createSecret, testIdentity, utf8 } from './secrets-postgres-harness.js';

const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 8 });

const INTEGRITY = { ok: false, error: { code: 'integrity-failure', reason: 'integrity-check-failed' } };
const HEADER = (idLength: number) => 2 + idLength;
const NONCE_AT = HEADER(2);
const CIPHERTEXT_AT = NONCE_AT + 12;

async function envelopeOf(ref: string) {
    const rows = await db.sql<{ id: string; envelope: Buffer; key_id: string }[]>`
        select v.id, v.envelope, v.key_id from secret_active a join secret_version v on v.id = a.version_id
         where a.ref = ${ref}`;
    return rows[0] as { id: string; envelope: Buffer; key_id: string };
}

async function setEnvelope(id: string, envelope: Buffer) {
    await db.sql`update secret_version set envelope = ${envelope} where id = ${id}`;
}

describe.skipIf(!enabled)('the secret envelope in PostgreSQL', () => {
    it('a tampered tag, nonce, ciphertext or header key id is integrity-failure', async () => {
        const h = createPostgresHarness(db.sql);
        const store = h.open();
        const identity = testIdentity();
        const spots: Array<[string, (envelope: Buffer) => number]> = [
            ['header key id', () => 2],
            ['nonce', () => NONCE_AT],
            ['ciphertext', () => CIPHERTEXT_AT],
            ['tag', (envelope) => envelope.length - 1],
        ];
        for (const [name, position] of spots) {
            const s = await createSecret(
                store,
                identity,
                utf8('top secret'),
                `sec_${crypto.randomUUID()}` as SecretRef
            );
            const stored = await envelopeOf(s.ref);
            const flipped = Buffer.from(stored.envelope);
            const at = position(flipped);
            flipped[at] = (flipped[at] ?? 0) ^ 0x01;
            await setEnvelope(stored.id, flipped);
            expect(await store.readActive({ identity, ref: s.ref }), name).toEqual(INTEGRITY);
        }
    });

    it('a key id column that differs from the header is integrity-failure', async () => {
        const h = createPostgresHarness(db.sql);
        const store = h.open();
        const identity = testIdentity();
        const s = await createSecret(store, identity, utf8('top secret'));
        const stored = await envelopeOf(s.ref);
        h.keys.dataKeys.set('k9', h.keys.dataKeys.get('k1') as Buffer);
        await db.sql`update secret_version set key_id = 'k9' where id = ${stored.id}`;
        expect(await store.readActive({ identity, ref: s.ref })).toEqual(INTEGRITY);
    });

    it('the same key id with other bytes is integrity-failure', async () => {
        const h = createPostgresHarness(db.sql);
        const identity = testIdentity();
        const s = await createSecret(h.open(), identity, utf8('top secret'));
        const other = createPostgresHarness(db.sql, { keys: new MutableKeys() });
        expect(other.keys.activeKeyId).toBe(h.keys.activeKeyId);
        expect(await other.open().readActive({ identity, ref: s.ref })).toEqual(INTEGRITY);
    });

    it('a key id missing from the ring is integrity-failure', async () => {
        const h = createPostgresHarness(db.sql);
        const identity = testIdentity();
        const s = await createSecret(h.open(), identity, utf8('top secret'));
        const keys = new MutableKeys();
        keys.dataKeys.delete('k1');
        keys.addActive();
        const retired = createPostgresHarness(db.sql, { keys });
        expect(await retired.open().readActive({ identity, ref: s.ref })).toEqual(INTEGRITY);
    });

    it('an envelope copied to another identity, another ref or another logical version is integrity-failure', async () => {
        const h = createPostgresHarness(db.sql);
        const store = h.open();
        const payload = utf8('the very same payload');
        const alice = testIdentity();
        const bob = testIdentity();
        const a = await createSecret(store, alice, payload);
        const b = await createSecret(store, bob, payload);
        const sameIdentity = await createSecret(store, alice, payload);
        const a1 = await envelopeOf(a.ref);

        await setEnvelope((await envelopeOf(b.ref)).id, a1.envelope);
        expect(await store.readActive({ identity: bob, ref: b.ref }), 'another identity').toEqual(INTEGRITY);

        await setEnvelope((await envelopeOf(sameIdentity.ref)).id, a1.envelope);
        expect(await store.readActive({ identity: alice, ref: sameIdentity.ref }), 'another ref').toEqual(INTEGRITY);

        const replaced = await store.replace({
            identity: alice,
            ref: a.ref,
            operationId: await store.issueOperationId(),
            expectedVersion: a.version,
            payload,
        });
        expect(replaced.ok).toBe(true);
        await setEnvelope((await envelopeOf(a.ref)).id, a1.envelope);
        expect(await store.readActive({ identity: alice, ref: a.ref }), 'another logical version').toEqual(INTEGRITY);
    });

    it('two versions of the same payload carry distinct nonces and ciphertexts', async () => {
        const h = createPostgresHarness(db.sql);
        const store = h.open();
        const identity = testIdentity();
        const payload = utf8('same bytes every time');
        const s = await createSecret(store, identity, payload);
        let version = s.version;
        for (let i = 0; i < 3; i += 1) {
            const next = await store.replace({
                identity,
                ref: s.ref,
                operationId: await store.issueOperationId(),
                expectedVersion: version,
                payload,
            });
            if (!next.ok) {
                throw new Error('replace refused');
            }
            version = next.version;
        }
        const rows = await db.sql<{ envelope: Buffer }[]>`select envelope from secret_version where ref = ${s.ref}`;
        expect(rows).toHaveLength(4);
        const nonces = new Set(rows.map((r) => r.envelope.subarray(NONCE_AT, CIPHERTEXT_AT).toString('hex')));
        const bodies = new Set(rows.map((r) => r.envelope.subarray(CIPHERTEXT_AT).toString('hex')));
        expect(nonces.size).toBe(4);
        expect(bodies.size).toBe(4);
    });

    it('a full catalog dump of every public table holds no sentinel form', async () => {
        const h = createPostgresHarness(db.sql);
        const store = h.open();
        const sentinel = `SENTINEL-${crypto.randomUUID()}-payload`;
        const identity = testIdentity();
        const s = await createSecret(store, identity, utf8(sentinel));
        await store.replace({
            identity,
            ref: s.ref,
            operationId: await store.issueOperationId(),
            expectedVersion: s.version,
            payload: utf8(sentinel),
        });
        const raw = Buffer.from(sentinel);
        const forms = [sentinel, raw.toString('hex'), raw.toString('base64'), raw.toString('base64url')];
        const tables = await db.sql<
            { tablename: string }[]
        >`select tablename from pg_tables where schemaname = 'public'`;
        expect(tables.map((t) => t.tablename)).toEqual(expect.arrayContaining(['secret', 'secret_version']));
        for (const { tablename } of tables) {
            const rows = await db.sql.unsafe(`select to_jsonb(t)::text as row from "${tablename}" t`);
            const dump = rows.map((r) => r.row).join('\n');
            for (const form of forms) {
                expect(dump.includes(form), `${tablename} holds ${form.slice(0, 12)}`).toBe(false);
            }
        }
    });
});
