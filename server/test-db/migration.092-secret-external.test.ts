import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { DatabasePayloads } from '../src/secrets/database-payloads.js';
import { createPostgresSecretStore } from '../src/secrets/postgres-secret-store.js';
import { identityKey } from '../src/secrets/secret-input.js';
import type { SecretRef } from '../src/secrets/secret-store.js';
import { assertTestDatabase } from './harness.js';
import { MutableKeys, testIdentity, utf8 } from './secrets-postgres-harness.js';

/** BEL-137: 092 upgrades a database that stops at 091 and already holds secret versions. */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '092_secret_external.sql';
const DIR = new URL('../migrations/', import.meta.url);
let admin: Sql;
let pool: Sql;
let schema: string;

beforeAll(async () => {
    if (!enabled) return;
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    schema = `mig_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`create schema ${schema}`);
    pool = postgres(url as string, { max: 2, onnotice: () => {}, connection: { search_path: schema } });
});

afterAll(async () => {
    if (!enabled) return;
    await pool.end();
    await admin.unsafe(`drop schema ${schema} cascade`);
    await admin.end();
});

/** The schema exactly as a database that ran every migration before 092 has it. */
async function applyThrough091(): Promise<void> {
    await pool`create table schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
    const versioned = readdirSync(DIR)
        .filter((name) => name.endsWith('.sql') && !name.endsWith('.repeatable.sql') && name < VERSION)
        .sort();
    for (const name of versioned) {
        await pool.unsafe(readFileSync(new URL(name, DIR), 'utf8'));
        await pool`insert into schema_migrations (version) values (${name})`;
    }
}

describe.skipIf(!enabled)('092_secret_external', () => {
    it('keeps what 091 stored readable, activatable and collectable as database storage', async () => {
        await applyThrough091();
        expect(
            await pool`select 1 from information_schema.columns where table_schema = ${schema} and table_name = 'secret_version' and column_name = 'storage'`
        ).toHaveLength(0);

        const keys = new MutableKeys();
        const payloads = new DatabasePayloads(keys);
        const identity = testIdentity();
        const key = identityKey(identity);
        const store = createPostgresSecretStore({ sql: pool, keys, deadlineMs: 3000 });
        const now = Date.now();
        const sealed = (ref: string, logicalVersion: string, text: string) => {
            const out = payloads.seal({ identityKey: key, ref, logicalVersion }, utf8(text));
            if (!out) throw new Error('no active key');
            return out;
        };
        const refs = { active: `sec_${randomUUID()}`, staged: `sec_${randomUUID()}`, deleted: `sec_${randomUUID()}` };
        const ids = { active: randomUUID(), staged: randomUUID(), cleanup: randomUUID() };
        const insertVersion = async (v: { id: string; ref: string; version: string; state: string; text: string }) => {
            const { id, ref, version, state } = v;
            const { keyId, envelope } = sealed(ref, version, v.text);
            await pool`
                insert into secret_version (id, ref, logical_version, key_id, envelope, state, operation_id, created_at_ms)
                values (${id}, ${ref}, ${version}, ${keyId}, ${envelope}, ${state}, null, ${now})`;
        };
        const insertSecret = (ref: string, state: string) =>
            pool`insert into secret (ref, identity_key, state, created_at_ms, updated_at_ms) values (${ref}, ${key}, ${state}, ${now}, ${now})`;

        // An active secret.
        await insertSecret(refs.active, 'active');
        await insertVersion({ id: ids.active, ref: refs.active, version: 'ver_active', state: 'active', text: 'one' });
        await pool`insert into secret_active (ref, version_id, logical_version) values (${refs.active}, ${ids.active}, 'ver_active')`;
        // A create that staged its version and stopped before activation.
        const operationId = await store.issueOperationId();
        await insertVersion({ id: ids.staged, ref: refs.staged, version: 'ver_staged', state: 'staged', text: 'two' });
        await pool`
            insert into secret_operation (operation_id, kind, ref, identity_key, expected_version, fingerprint, state,
                                          version_id, new_version, issued_at_ms)
            values (${operationId}, 'create', ${refs.staged}, ${key}, null, 'fingerprint', 'pending', ${ids.staged},
                    'ver_staged', ${now})`;
        await pool`update secret_version set operation_id = ${operationId} where id = ${ids.staged}`;
        // A deleted secret whose version waits for cleanup.
        await insertSecret(refs.deleted, 'tombstoned');
        await insertVersion({
            id: ids.cleanup,
            ref: refs.deleted,
            version: 'ver_deleted',
            state: 'cleanup-pending',
            text: 'three',
        });

        await migrate(pool, { attempts: 1, log: () => {} });

        const stored = await pool<
            { id: string; storage: string; provider_ref: string | null; payload_mac: string | null }[]
        >`
            select id, storage, provider_ref, payload_mac from secret_version`;
        expect(stored).toHaveLength(3);
        expect(stored.map((row) => [row.storage, row.provider_ref, row.payload_mac])).toEqual([
            ['database', null, null],
            ['database', null, null],
            ['database', null, null],
        ]);

        const active = await store.readActive({ identity, ref: refs.active as SecretRef });
        expect(active.ok && new TextDecoder().decode(active.value)).toBe('one');

        const reconciled = await store.reconcileOperation({ identity, ref: refs.staged as SecretRef, operationId });
        expect(reconciled).toEqual({ ok: true, status: { state: 'succeeded', result: { version: 'ver_staged' } } });
        const activated = await store.readActive({ identity, ref: refs.staged as SecretRef });
        expect(activated.ok && new TextDecoder().decode(activated.value)).toBe('two');

        expect((await store.collect()).removed).toBe(1);
        const left = await pool<{ id: string; state: string }[]>`select id, state from secret_version order by state`;
        expect(left.map((row) => row.state)).toEqual(['active', 'active']);
        expect(left.map((row) => row.id)).not.toContain(ids.cleanup);
    });

    it('requires the columns of the version’s storage, and a second application changes nothing', async () => {
        const file = readFileSync(new URL(VERSION, DIR), 'utf8');
        await migrate(pool, { attempts: 1, log: () => {} });
        await pool.unsafe(file);
        await pool.unsafe(file);

        const insert = (columns: Record<string, unknown>) =>
            pool`insert into secret_version ${pool({ id: randomUUID(), ref: 'sec_shape', logical_version: 'v', state: 'staged', created_at_ms: 1, ...columns })}`;
        const envelope = Buffer.from([1, 2, 3]);
        await expect(insert({ storage: 'database', key_id: 'k1' })).rejects.toThrow();
        await expect(insert({ storage: 'database', key_id: 'k1', envelope, payload_mac: 'm' })).rejects.toThrow();
        await expect(insert({ storage: 'aws', provider_ref: 'p/x' })).rejects.toThrow();
        await expect(insert({ storage: 'aws', provider_ref: 'p/x', payload_mac: 'm', envelope })).rejects.toThrow();
        await expect(insert({ storage: 'elsewhere', provider_ref: 'p/x', payload_mac: 'm' })).rejects.toThrow();
        await insert({ storage: 'database', key_id: 'k1', envelope });
        await insert({ storage: 'aws', provider_ref: 'p/x', provider_version: '1', payload_mac: 'm' });
        await insert({ storage: 'vault', provider_ref: 'p/y', payload_mac: 'm', state: 'deleting' });
        // `deleting` is a two-phase state only an external version can be in: 091's collector cannot see it.
        await expect(insert({ storage: 'database', key_id: 'k1', envelope, state: 'deleting' })).rejects.toThrow();
        const [count] = await pool<
            { n: number }[]
        >`select count(*)::int as n from secret_version where ref = 'sec_shape'`;
        expect(count?.n).toBe(3);
    });

    it('keeps every removable database row visible to 091’s collector query', async () => {
        await migrate(pool, { attempts: 1, log: () => {} });
        const envelope = Buffer.from([1, 2, 3]);
        const ids = new Map<string, string>();
        for (const state of ['staged', 'collectable', 'cleanup-pending']) {
            const id = randomUUID();
            ids.set(state, id);
            await pool`
                insert into secret_version (id, ref, logical_version, key_id, envelope, state, created_at_ms)
                values (${id}, 'sec_collect', ${state}, 'k1', ${envelope}, ${state}, 1)`;
        }
        // `listCollectable` exactly as 091 shipped it (server/src/secrets/postgres-secret-sql.ts at 249015a0).
        const found = await pool<{ id: string }[]>`
            select id from secret_version
             where (state in ('collectable', 'cleanup-pending')
                    or (state = 'staged' and not exists (select 1 from secret_operation o
                                                          where o.version_id = secret_version.id
                                                            and o.state in ('pending', 'unknown'))))
               and (${null}::uuid is null or id > ${null})
             order by id limit ${100}`;
        expect(
            found
                .map((row) => row.id)
                .filter((id) => [...ids.values()].includes(id))
                .sort()
        ).toEqual([...ids.values()].sort());
    });

    it('accepts the insert an older pod still sends, which names no storage, as database storage', async () => {
        await migrate(pool, { attempts: 1, log: () => {} });
        const id = randomUUID();
        // The column list 091's backend writes: a rolling deploy or a rollback runs it against 092.
        await pool`
            insert into secret_version (id, ref, logical_version, key_id, envelope, state, operation_id, created_at_ms)
            values (${id}, 'sec_old_pod', 'v1', 'k1', ${Buffer.from([1, 2, 3])}, 'staged', null, 1)`;
        const [row] = await pool<{ storage: string }[]>`select storage from secret_version where id = ${id}`;
        expect(row?.storage).toBe('database');
    });
});
