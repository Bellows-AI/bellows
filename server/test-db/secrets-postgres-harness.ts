import { randomBytes, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createSecretRepo, type NewVersion, type SecretRepo } from '../src/secrets/postgres-secret-repo.js';
import { createDatabaseSecretStoreOver, type PostgresSecretStore } from '../src/secrets/postgres-secret-store.js';
import type { PayloadStore } from '../src/secrets/secret-payloads.js';
import type { DatabasePayloads } from '../src/secrets/database-payloads.js';
import type { SecretKeys } from '../src/secrets/secret-keys.js';
import type { SecretDiagnostic, SecretIdentity, SecretRef, SecretStore } from '../src/secrets/secret-store.js';
import {
    type FaultStep,
    type SecretStoreFaults,
    type SecretStoreHarness,
    createFaults,
} from '../test/secrets-conformance.js';

/**
 * TEST-ONLY: the conformance harness over the PostgreSQL secret store, and the fault-injecting wrapper
 * around its repo seam. Fault injection lives here and nowhere in `server/src`: production builds the
 * store over the real repo (`createPostgresSecretStore`) and has no selector for any of this.
 */

/** A key ring a test can rotate: `activeKeyId` is read on every use. */
export class MutableKeys implements SecretKeys {
    readonly dataKeys = new Map<string, Buffer>();
    readonly operationKey: Buffer;
    readonly fingerprintKey: Buffer;
    private active: string;
    private counter = 1;

    constructor(from?: { keys: MutableKeys; only: string[] }) {
        this.operationKey = from?.keys.operationKey ?? randomBytes(32);
        this.fingerprintKey = from?.keys.fingerprintKey ?? randomBytes(32);
        if (from) {
            for (const id of from.only) {
                this.dataKeys.set(id, from.keys.dataKeys.get(id) as Buffer);
            }
            this.active = from.keys.activeKeyId;
        } else {
            this.active = 'k1';
            this.dataKeys.set('k1', randomBytes(32));
        }
    }

    get activeKeyId(): string {
        return this.active;
    }

    /** Adds a fresh key, makes it the active one and returns its id. */
    addActive(): string {
        this.counter += 1;
        this.active = `k${this.counter}`;
        this.dataKeys.set(this.active, randomBytes(32));
        return this.active;
    }
}

/** A database error as the store classifies it: only `code` matters. */
export function dbError(code: string, message = 'simulated database error'): Error {
    return Object.assign(new Error(message), { code });
}

type StepHook = (step: FaultStep, operationId: string) => Promise<void>;

/**
 * Wraps a repo so the harness can stop an operation between two steps (`faults.onStep`); nothing else changes.
 * `after-stage` fires once the version row is staged, which for the database store is also when its payload is
 * durable; a store whose payload is written afterwards fires that step itself (`afterStage: false`).
 */
export function steppedRepo(real: SecretRepo, faults: SecretStoreFaults, afterStage = true): SecretRepo {
    const step: StepHook = async (name, operationId) => {
        await faults.onStep?.({ step: name, operationId: operationId as never });
    };
    return {
        ...real,
        async insertIntent(op, budgetMs) {
            const row = await real.insertIntent(op, budgetMs);
            await step('after-intent', op.operationId);
            return row;
        },
        async stageVersion(version: NewVersion, budgetMs) {
            const stored = await real.stageVersion(version, budgetMs);
            if (afterStage && version.operationId) {
                await step('after-stage', version.operationId);
            }
            return stored;
        },
        async activate(operationId, origin, nowMs, budgetMs) {
            if (origin !== 'request') {
                return real.activate(operationId, origin, nowMs, budgetMs);
            }
            await step('before-activate', operationId);
            const result = await real.activate(operationId, origin, nowMs, budgetMs);
            await step('after-activate', operationId);
            return result;
        },
    };
}

/** Wraps a repo with the harness faults (docs/secrets.md); every other method passes straight through. */
export function faultyRepo(real: SecretRepo, faults: SecretStoreFaults): SecretRepo {
    return steppedRepo(
        {
            ...real,
            async stageVersion(version: NewVersion, budgetMs) {
                faults.providerWriteCount += 1;
                if (faults.providerWrite === 'timeout-lost') {
                    throw dbError('CONNECTION_CLOSED');
                }
                if (faults.providerWrite === 'unavailable-with-body') {
                    throw dbError('53300', faults.providerErrorBody);
                }
                const stored = await real.stageVersion(version, budgetMs);
                if (faults.providerWrite === 'timeout-applied') {
                    throw dbError('CONNECTION_CLOSED');
                }
                return stored;
            },
            async readActive(ref, budgetMs) {
                if (faults.providerRead === 'unavailable') {
                    throw dbError('08006');
                }
                return real.readActive(ref, budgetMs);
            },
            // The first step of a removal: a failure leaves the version exactly where it was.
            async retireVersion(id, storage, budgetMs) {
                if (faults.providerDelete === 'fail') {
                    throw dbError('08006');
                }
                return real.retireVersion(id, storage, budgetMs);
            },
            async removeInPlace(id, storage, budgetMs) {
                if (faults.providerDelete === 'fail') {
                    throw dbError('08006');
                }
                return real.removeInPlace(id, storage, budgetMs);
            },
        },
        faults
    );
}

const TABLES = ['secret', 'secret_version', 'secret_active', 'secret_operation'] as const;
const ORDER: Record<(typeof TABLES)[number], string> = {
    secret: 'ref',
    secret_version: 'id',
    secret_active: 'ref',
    secret_operation: 'operation_id',
};

/** What PostgreSQL holds of the secret store, table by table, in a stable order. */
export async function databaseSnapshot(sql: Sql): Promise<Record<string, unknown[]>> {
    const db: Record<string, unknown[]> = {};
    for (const table of TABLES) {
        const rows = await sql.unsafe(`select to_jsonb(t) as j from ${table} t order by ${ORDER[table]}`);
        db[table] = rows.map((r) => r.j);
    }
    return db;
}

export interface PostgresHarness extends SecretStoreHarness {
    keys: MutableKeys;
    /**
     * The store the conformance suite drives, built over `repo` instead of the default faulty one, and
     * optionally over a payload store that wraps the database one.
     */
    openWith(repo: SecretRepo, payloads?: (database: DatabasePayloads) => PayloadStore): PostgresSecretStore;
    realRepo: SecretRepo;
    faultyRepo: SecretRepo;
    now(): number;
    open(): PostgresSecretStore;
    reopen(): PostgresSecretStore;
}

export interface PostgresHarnessOptions {
    deadlineMs?: number;
    ready?: Promise<unknown>;
    keys?: MutableKeys;
    /** Another pool over the same database, for a second replica. */
    sql?: Sql;
}

/**
 * A call a case holds at a fault step spends its own absolute deadline while held, so the default must outlast
 * the longest hold a conformance case needs; cases that test expiry pass their own `deadlineMs`.
 */
const HELD_CALL_DEADLINE_MS = 3000;

export function createPostgresHarness(sql: Sql, options: PostgresHarnessOptions = {}): PostgresHarness {
    const keys = options.keys ?? new MutableKeys();
    let now = Date.UTC(2026, 0, 1);
    const clock = { now: () => now };
    const faults = createFaults();
    const diagnostics: unknown[] = [];
    const realRepo = createSecretRepo(options.sql ?? sql);
    const wrapped = faultyRepo(realRepo, faults);
    const log = (d: SecretDiagnostic) => diagnostics.push(d);
    const openWith = (repo: SecretRepo, payloads?: (database: DatabasePayloads) => PayloadStore) =>
        createDatabaseSecretStoreOver({
            repo,
            keys,
            payloads,
            clock,
            log,
            deadlineMs: options.deadlineMs ?? HELD_CALL_DEADLINE_MS,
            ready: options.ready,
        });
    const open = () => openWith(wrapped);
    return {
        keys,
        realRepo,
        faultyRepo: wrapped,
        openWith,
        now: () => now,
        open,
        // A restart over a database loses nothing: a new store over the same tables is the whole story.
        reopen: open,
        clock: {
            advance(ms) {
                now += ms;
            },
        },
        faults,
        async rekey(identity: SecretIdentity, ref: SecretRef) {
            keys.addActive();
            await open().rekey(identity, ref);
        },
        async collect() {
            await open().collect();
        },
        async tamper(ref: SecretRef) {
            const rows = await sql<{ id: string; envelope: Buffer }[]>`
                select v.id, v.envelope from secret_active a join secret_version v on v.id = a.version_id
                 where a.ref = ${ref}`;
            const row = rows[0];
            if (!row) {
                throw new Error('tamper: nothing to corrupt');
            }
            const idLength = row.envelope[1] ?? 0;
            const at = 2 + idLength + 12;
            const flipped = Buffer.from(row.envelope);
            flipped[at] = (flipped[at] ?? 0) ^ 0xff;
            await sql`update secret_version set envelope = ${flipped} where id = ${row.id}`;
        },
        async durableSnapshot() {
            return { db: await databaseSnapshot(sql) };
        },
        diagnostics: () => structuredClone(diagnostics),
    };
}

const unique = (prefix: string) => `${prefix}-${randomUUID()}`;

/** A fresh organization-owned identity; every id is unique to the call. */
export function testIdentity(): SecretIdentity {
    return {
        owner: { kind: 'organization', orgId: unique('org') },
        scope: { type: 'workspace', id: unique('ws') },
        purpose: 'environment-secret',
        owningRecord: { type: 'env_var', id: unique('row') },
    };
}

/**
 * A two-phase payload store standing in for an external provider (`aws`): the plaintext lives in `objects`,
 * the row keeps a reference and a MAC. `over` replaces calls to script a fault between two steps.
 */
export function externalPayloads(over: Partial<PayloadStore> = {}) {
    const objects = new Map<string, Uint8Array>();
    const build = (): PayloadStore => ({
        storage: 'aws',
        twoPhase: true,
        prepare: (_aad, versionId) => ({
            storage: 'aws',
            keyId: null,
            envelope: null,
            providerRef: `obj/${versionId}`,
            providerVersion: null,
            payloadMac: 'mac',
        }),
        holds: () => true,
        async write(row, payload) {
            objects.set(row.providerRef as string, payload);
            return 'written';
        },
        async read(row) {
            return objects.get(row.providerRef as string) ?? 'absent';
        },
        async remove(row) {
            objects.delete(row.providerRef as string);
        },
        ...over,
    });
    return { objects, factory: (_database: DatabasePayloads): PayloadStore => build() };
}

export const utf8 = (value: string) => new TextEncoder().encode(value);

/** Creates a secret through the store, failing the test on any refusal. */
export async function createSecret(
    store: SecretStore,
    identity: SecretIdentity,
    payload: Uint8Array,
    ref = `sec_${randomUUID()}` as SecretRef
) {
    const operationId = await store.issueOperationId();
    const created = await store.create({ identity, ref, operationId, payload });
    if (!created.ok) {
        throw new Error(`create refused: ${created.error.code}/${created.error.reason}`);
    }
    return { ref, version: created.version, operationId };
}
