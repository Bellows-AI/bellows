import type { Sql } from 'postgres';
import * as q from './postgres-secret-sql.js';
import type { PayloadStorage, StoredPayload } from './secret-payloads.js';
import type { SecretErrorCode, SecretErrorReason } from './secret-store.js';

/**
 * The SQL of the PostgreSQL secret store (`091_secret_store.sql`, `092_secret_external.sql`, docs/secrets.md). Each method is one
 * transaction or one statement and each is a fault boundary: the store (`postgres-secret-store.ts`) only
 * sees this interface, so a test wraps it to inject a crash or a database error between any two methods
 * (`server/test-db/secrets-postgres-harness.ts`). Nothing here decides a policy: the store decides what an
 * error, a retry or a missing row means. The last argument of every method is the time budget in
 * milliseconds, applied as the transaction's `statement_timeout`.
 */

export type OperationKind = 'create' | 'replace' | 'delete';
export type OperationState = 'pending' | 'unknown' | 'succeeded' | 'failed';
export type VersionState = 'staged' | 'active' | 'collectable' | 'cleanup-pending' | 'deleting';

export interface OperationRow {
    operationId: string;
    kind: OperationKind;
    ref: string;
    identityKey: string;
    expectedVersion: string | null;
    fingerprint: string;
    state: OperationState;
    versionId: string | null;
    newVersion: string | null;
    errorCode: SecretErrorCode | null;
    errorReason: SecretErrorReason | null;
    issuedAtMs: number;
    completedAtMs: number | null;
}

/** A reference and the logical version its pointer names; null `activeVersion` on a tombstone. */
export interface SecretSummary {
    ref: string;
    identityKey: string;
    state: 'active' | 'tombstoned';
    activeVersion: string | null;
}

export interface VersionRow extends StoredPayload {
    state: VersionState;
    operationId: string | null;
    createdAtMs: number;
}

/** What `readActive` joins: the reference, its pointer and the pointed-at version. */
export interface ActiveRead {
    identityKey: string;
    state: 'active' | 'tombstoned';
    version: StoredPayload | null;
}

export interface RotationRow {
    ref: string;
    identityKey: string;
    versionId: string;
    logicalVersion: string;
    keyId: string;
    envelope: Buffer;
}

export interface NewVersion extends StoredPayload {
    operationId: string | null;
    createdAtMs: number;
}

export type NewOperation = Omit<OperationRow, 'state' | 'errorCode' | 'errorReason' | 'completedAtMs'>;

export interface SecretRepo {
    findSecret(ref: string, budgetMs: number): Promise<SecretSummary | null>;
    findOperation(operationId: string, budgetMs: number): Promise<OperationRow | null>;
    /** True when another operation on the reference is `unknown`. */
    hasUnknownOperation(ref: string, exceptOperationId: string, budgetMs: number): Promise<boolean>;
    findVersion(id: string, budgetMs: number): Promise<VersionRow | null>;
    readActive(ref: string, budgetMs: number): Promise<ActiveRead | null>;
    /** Insert-if-absent, then read back: the row that won is returned, ours or another replica's. */
    insertIntent(op: NewOperation, budgetMs: number): Promise<OperationRow>;
    /** Record a definitive failure that has no intent row yet; the stored row is returned. */
    insertFailure(
        op: NewOperation,
        error: { code: SecretErrorCode; reason: SecretErrorReason },
        completedAtMs: number,
        budgetMs: number
    ): Promise<OperationRow>;
    /**
     * Stage the version row once, under the operation's row lock; for the database store the row is the
     * payload, for an external provider the provider write follows (`secret-payloads.ts`). Returns the
     * stored row (a repeat with the same id changes nothing and may find a row that is not ours), or
     * `'closed'` when the operation already finished: nothing was staged.
     */
    stageVersion(version: NewVersion, budgetMs: number): Promise<VersionRow | 'closed'>;
    markUnknown(operationId: string, budgetMs: number): Promise<void>;
    /**
     * The whole compare-and-set in one transaction. Returns the terminal operation, or `'missing'` when the
     * operation or its staged version is absent (nothing changed).
     */
    activate(
        operationId: string,
        origin: 'request' | 'reconcile',
        nowMs: number,
        budgetMs: number
    ): Promise<OperationRow | 'missing'>;
    /** Versions of a reference waiting for cleanup after a delete, of one storage. */
    listPendingCleanup(ref: string, storage: PayloadStorage, budgetMs: number): Promise<string[]>;
    listCollectable(
        afterId: string | null,
        limit: number,
        storage: PayloadStorage,
        budgetMs: number
    ): Promise<string[]>;
    /**
     * Removal, phase one: one guarded statement that moves the version to `deleting` and returns it; null
     * when the guard refused (active, pointed at, or an unresolved operation). Idempotent on a `deleting` row.
     */
    retireVersion(id: string, storage: PayloadStorage, budgetMs: number): Promise<VersionRow | null>;
    /**
     * Removal of a version whose payload is its row (`PayloadStore.twoPhase` false): the same guard as
     * `retireVersion`, one delete. The row is never `deleting`. Null when the guard refused.
     */
    removeInPlace(id: string, storage: PayloadStorage, budgetMs: number): Promise<VersionRow | null>;
    /** Removal, phase two, after the payload store confirmed its payload gone: drops a `deleting` row. */
    dropVersion(id: string, budgetMs: number): Promise<boolean>;
    pruneOperations(cutoffMs: number, budgetMs: number): Promise<number>;
    listForRotation(
        activeKeyId: string,
        afterRef: string | null,
        limit: number,
        budgetMs: number
    ): Promise<RotationRow[]>;
    /** Swap the pointer to `next` iff `expectedVersionId` is still active; false when the swap was lost. */
    rekeySwap(ref: string, expectedVersionId: string, next: NewVersion, budgetMs: number): Promise<boolean>;
    countByKey(keyId: string, budgetMs: number): Promise<number>;
}

export function createSecretRepo(sql: Sql): SecretRepo {
    /** One transaction whose statements are cut off server-side when the caller's budget is spent. */
    const run = <T>(budgetMs: number, fn: (tx: Sql) => Promise<T>) => q.inTx(sql, budgetMs, fn);
    return {
        findSecret: (ref, b) => run(b, (tx) => q.findSecret(tx, ref)),
        findOperation: (id, b) => run(b, (tx) => q.readOperation(tx, id, false)),
        hasUnknownOperation: (ref, except, b) => run(b, (tx) => q.hasUnknownOperation(tx, ref, except)),
        findVersion: (id, b) => run(b, (tx) => q.findVersion(tx, id)),
        readActive: (ref, b) => run(b, (tx) => q.readActive(tx, ref)),
        insertIntent: (op, b) => run(b, (tx) => q.insertOperation(tx, op, null)),
        insertFailure: (op, error, completedAtMs, b) =>
            run(b, (tx) => q.insertOperation(tx, op, { error, completedAtMs })),
        stageVersion: (version, b) => run(b, (tx) => q.stageVersion(tx, version)),
        markUnknown: (id, b) => run(b, (tx) => q.markUnknown(tx, id)),
        activate: (id, _origin, nowMs, b) => run(b, (tx) => q.activate(tx, id, nowMs)),
        listPendingCleanup: (ref, storage, b) => run(b, (tx) => q.listPendingCleanup(tx, ref, storage)),
        listCollectable: (after, limit, storage, b) => run(b, (tx) => q.listCollectable(tx, after, limit, storage)),
        retireVersion: (id, storage, b) => run(b, (tx) => q.retireVersion(tx, id, storage)),
        removeInPlace: (id, storage, b) => run(b, (tx) => q.removeInPlace(tx, id, storage)),
        dropVersion: (id, b) => run(b, (tx) => q.dropVersion(tx, id)),
        pruneOperations: (cutoffMs, b) => run(b, (tx) => q.pruneOperations(tx, cutoffMs)),
        listForRotation: (activeKeyId, after, limit, b) =>
            run(b, (tx) => q.listForRotation(tx, activeKeyId, after, limit)),
        rekeySwap: (ref, expected, next, b) => run(b, (tx) => q.rekeySwap(tx, ref, expected, next)),
        countByKey: (keyId, b) => run(b, (tx) => q.countByKey(tx, keyId)),
    };
}
