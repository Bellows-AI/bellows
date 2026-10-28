import { randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import * as maintenance from './postgres-secret-maintenance.js';
import { mutate, toResult } from './postgres-secret-mutation.js';
import * as reads from './postgres-secret-read.js';
import { type SecretRepo, createSecretRepo } from './postgres-secret-repo.js';
import type { StoreContext } from './postgres-secret-support.js';
import { DatabasePayloads } from './database-payloads.js';
import { type OperationKeys, type SecretKeys, operationMac } from './secret-keys.js';
import type { PayloadStore } from './secret-payloads.js';
import type {
    CreateSecretInput,
    DeleteSecretInput,
    OperationId,
    ReadSecretInput,
    ReconcileInput,
    ReplaceSecretInput,
    SecretDiagnostic,
    SecretIdentity,
    SecretRef,
    SecretResult,
    SecretStore,
    SecretVersion,
} from './secret-store.js';

/**
 * The PostgreSQL `SecretStore` (docs/secrets.md): the BEL-64 recovery model over `postgres-secret-repo.ts`,
 * with AES-256-GCM envelopes (`secret-envelope.ts`) under keys that live outside the database
 * (`secret-keys.ts`). Where a payload lives is the `PayloadStore` seam (`secret-payloads.ts`); the database
 * store (`database-payloads.ts`) is the one this file composes. The behavioural twin is the test-only reference store (`server/test/secrets-reference-store.ts`).
 * Write path: `postgres-secret-mutation.ts`; read path: `postgres-secret-read.ts`; collector and rotation:
 * `postgres-secret-maintenance.ts`; database error classification and the per-call deadline: `secret-call.ts`.
 */

const DEFAULT_DEADLINE_MS = 10_000;
const OPERATION_NONCE_BYTES = 8;

export type { CollectSummary, RotationSummary } from './postgres-secret-maintenance.js';

/** What every backend gets from the shared coordination code, whatever holds its payloads. */
export interface CoordinatedSecretStore extends SecretStore {
    /** Remove unreferenced versions, then prune completed operations past retention. Safe on every replica. */
    collect(): Promise<maintenance.CollectSummary>;
}

export interface PostgresSecretStore extends CoordinatedSecretStore {
    /** Re-encrypt one active secret under the active key id; the logical version is kept. */
    rekey(identity: SecretIdentity, ref: SecretRef): Promise<void>;
    /** Re-encrypt every active secret that is not on the active key. Resumable: a rerun picks up the rest. */
    rotate(options?: { batchSize?: number; signal?: AbortSignal | undefined }): Promise<maintenance.RotationSummary>;
    /** How many stored versions (staged and collectable included) still name `keyId`, after a collection. */
    verifyRetired(keyId: string): Promise<number>;
}

export interface SecretStoreConfig {
    repo: SecretRepo;
    keys: OperationKeys;
    payloads: PayloadStore;
    clock?: { now(): number } | undefined;
    log?: ((diagnostic: SecretDiagnostic) => void) | undefined;
    deadlineMs?: number | undefined;
    /** Resolves when the schema exists; a call made before that is `unavailable`. */
    ready?: Promise<unknown> | undefined;
}

export interface DatabaseSecretStoreConfig extends Omit<SecretStoreConfig, 'keys' | 'payloads'> {
    keys: SecretKeys;
    /** Test seam: wraps the database payload store to inject a fault between two payload calls. */
    payloads?: ((database: DatabasePayloads) => PayloadStore) | undefined;
}

export interface PostgresSecretStoreConfig extends Omit<DatabaseSecretStoreConfig, 'repo'> {
    sql: Sql;
}

/** Production: the store over the real repo. There is no selector for a faulty one; tests wrap the repo seam. */
export function createPostgresSecretStore(config: PostgresSecretStoreConfig): PostgresSecretStore {
    const { sql, ...rest } = config;
    return createDatabaseSecretStoreOver({ ...rest, repo: createSecretRepo(sql) });
}

/** The database backend over a given repo: the shared store, with the database payload store and rotation. */
export function createDatabaseSecretStoreOver(config: DatabaseSecretStoreConfig): PostgresSecretStore {
    const database = new DatabasePayloads(config.keys);
    const ctx = contextOf({ ...config, payloads: config.payloads?.(database) ?? database });
    return {
        ...coordinated(ctx),
        rekey: (identity, ref) => maintenance.rekey(ctx, database, identity, ref),
        rotate: (options = {}) => maintenance.rotate(ctx, database, options),
        verifyRetired: (keyId) => maintenance.verifyRetired(ctx, keyId),
    };
}

/** The store over any payload store: every mutation, read, reconcile and collection, none of rotation. */
export function createSecretStoreOver(config: SecretStoreConfig): CoordinatedSecretStore {
    return coordinated(contextOf(config));
}

function contextOf(config: SecretStoreConfig): StoreContext {
    return {
        repo: config.repo,
        keys: config.keys,
        payloads: config.payloads,
        clock: config.clock ?? { now: () => Date.now() },
        log: (diagnostic) => config.log?.(diagnostic),
        deadlineMs: config.deadlineMs ?? DEFAULT_DEADLINE_MS,
        ready: config.ready,
    };
}

function coordinated(ctx: StoreContext): CoordinatedSecretStore {
    return {
        async issueOperationId() {
            const issuedAt = ctx.clock.now();
            const nonce = randomBytes(OPERATION_NONCE_BYTES).toString('hex');
            return `op_${issuedAt}_${nonce}_${operationMac(ctx.keys, `${issuedAt}.${nonce}`)}` as OperationId;
        },
        async create(input: CreateSecretInput) {
            return toResult('create', await mutate(ctx, 'create', input)) as SecretResult<{ version: SecretVersion }>;
        },
        async replace(input: ReplaceSecretInput) {
            return toResult('replace', await mutate(ctx, 'replace', input)) as SecretResult<{ version: SecretVersion }>;
        },
        async delete(input: DeleteSecretInput) {
            return toResult('delete', await mutate(ctx, 'delete', input)) as SecretResult;
        },
        readActive: (input: ReadSecretInput) => reads.readActive(ctx, input),
        reconcileOperation: (input: ReconcileInput) => reads.reconcile(ctx, input),
        collect: () => maintenance.collect(ctx),
    };
}
