import type { Sql } from 'postgres';
import type {
    ActiveRead,
    NewOperation,
    NewVersion,
    OperationKind,
    OperationRow,
    OperationState,
    RotationRow,
    SecretSummary,
    VersionRow,
    VersionState,
} from './postgres-secret-repo.js';
import type { PayloadColumns, PayloadStorage } from './secret-payloads.js';
import type { SecretErrorCode, SecretErrorReason } from './secret-store.js';

/**
 * The statements behind `postgres-secret-repo.ts` (`091_secret_store.sql`). Each function takes the
 * transaction it runs in; `inTx` opens it and applies the caller's time budget as `statement_timeout`.
 * No policy lives here: what an error or a missing row means is the store's call.
 */

type Row = Record<string, unknown>;
type Failure = { code: SecretErrorCode; reason: SecretErrorReason };

const text = (value: unknown) => value as string;
const textOrNull = (value: unknown) => (value === null || value === undefined ? null : (value as string));

export async function inTx<T>(sql: Sql, budgetMs: number, fn: (tx: Sql) => Promise<T>): Promise<T> {
    const result = await sql.begin(async (tx) => {
        await tx`select set_config('statement_timeout', ${String(Math.max(1, Math.floor(budgetMs)))}, true)`;
        return fn(tx as unknown as Sql);
    });
    return result as T;
}

function operationOf(row: Row): OperationRow {
    return {
        operationId: text(row.operation_id),
        kind: row.kind as OperationKind,
        ref: text(row.ref),
        identityKey: text(row.identity_key),
        expectedVersion: textOrNull(row.expected_version),
        fingerprint: text(row.fingerprint),
        state: row.state as OperationState,
        versionId: textOrNull(row.version_id),
        newVersion: textOrNull(row.new_version),
        errorCode: textOrNull(row.error_code) as SecretErrorCode | null,
        errorReason: textOrNull(row.error_reason) as SecretErrorReason | null,
        issuedAtMs: Number(row.issued_at_ms),
        completedAtMs: row.completed_at_ms === null ? null : Number(row.completed_at_ms),
    };
}

function payloadOf(row: Row): PayloadColumns {
    return {
        storage: row.storage as PayloadStorage,
        keyId: textOrNull(row.key_id),
        envelope: (row.envelope ?? null) as Buffer | null,
        providerRef: textOrNull(row.provider_ref),
        providerVersion: textOrNull(row.provider_version),
        payloadMac: textOrNull(row.payload_mac),
    };
}

function versionOf(row: Row): VersionRow {
    return {
        id: text(row.id),
        ref: text(row.ref),
        logicalVersion: text(row.logical_version),
        ...payloadOf(row),
        state: row.state as VersionState,
        operationId: textOrNull(row.operation_id),
        createdAtMs: Number(row.created_at_ms),
    };
}

export async function readOperation(tx: Sql, operationId: string, lock: boolean): Promise<OperationRow | null> {
    const rows: Row[] = lock
        ? await tx`select * from secret_operation where operation_id = ${operationId} for update`
        : await tx`select * from secret_operation where operation_id = ${operationId}`;
    return rows[0] ? operationOf(rows[0]) : null;
}

/** Insert-if-absent, then read back: the stored row is returned, ours or whoever won the race. */
export async function insertOperation(
    tx: Sql,
    op: NewOperation,
    failure: { error: Failure; completedAtMs: number } | null
): Promise<OperationRow> {
    await tx`
        insert into secret_operation
            (operation_id, kind, ref, identity_key, expected_version, fingerprint, state, version_id,
             new_version, error_code, error_reason, issued_at_ms, completed_at_ms)
        values
            (${op.operationId}, ${op.kind}, ${op.ref}, ${op.identityKey}, ${op.expectedVersion},
             ${op.fingerprint}, ${failure ? 'failed' : 'pending'}, ${op.versionId}, ${op.newVersion},
             ${failure?.error.code ?? null}, ${failure?.error.reason ?? null}, ${op.issuedAtMs},
             ${failure?.completedAtMs ?? null})
        on conflict (operation_id) do nothing`;
    const stored = await readOperation(tx, op.operationId, false);
    if (!stored) {
        throw new Error('secret operation vanished after insert');
    }
    return stored;
}

export async function findSecret(tx: Sql, ref: string): Promise<SecretSummary | null> {
    const rows: Row[] = await tx`
        select s.ref, s.identity_key, s.state, a.logical_version
          from secret s left join secret_active a on a.ref = s.ref
         where s.ref = ${ref}`;
    const row = rows[0];
    if (!row) {
        return null;
    }
    return {
        ref: text(row.ref),
        identityKey: text(row.identity_key),
        state: row.state as SecretSummary['state'],
        activeVersion: textOrNull(row.logical_version),
    };
}

export async function hasUnknownOperation(tx: Sql, ref: string, exceptOperationId: string): Promise<boolean> {
    const rows: Row[] = await tx`
        select 1 from secret_operation
         where ref = ${ref} and state = 'unknown' and operation_id <> ${exceptOperationId}
         limit 1`;
    return rows.length > 0;
}

export async function findVersion(tx: Sql, id: string): Promise<VersionRow | null> {
    const rows: Row[] = await tx`select * from secret_version where id = ${id}`;
    return rows[0] ? versionOf(rows[0]) : null;
}

export async function readActive(tx: Sql, ref: string): Promise<ActiveRead | null> {
    const rows: Row[] = await tx`
        select s.identity_key, s.state, v.id as version_id, v.ref as version_ref, v.logical_version,
               v.storage, v.key_id, v.envelope, v.provider_ref, v.provider_version, v.payload_mac
          from secret s
          left join secret_active a on a.ref = s.ref
          left join secret_version v on v.id = a.version_id
         where s.ref = ${ref}`;
    const row = rows[0];
    if (!row) {
        return null;
    }
    const version =
        row.version_id === null
            ? null
            : {
                  id: text(row.version_id),
                  ref: text(row.version_ref),
                  logicalVersion: text(row.logical_version),
                  ...payloadOf(row),
              };
    return { identityKey: text(row.identity_key), state: row.state as ActiveRead['state'], version };
}

/**
 * Stage under the operation's row lock, so it cannot interleave with that operation's activation: a
 * finished operation stages nothing (`'closed'`). Insert-if-absent, then read back the stored row, which
 * the caller authenticates: a row that was already there is not trusted because it carries our id.
 */
export async function stageVersion(tx: Sql, version: NewVersion): Promise<VersionRow | 'closed'> {
    const op = version.operationId ? await readOperation(tx, version.operationId, true) : null;
    if (!op || (op.state !== 'pending' && op.state !== 'unknown')) {
        return 'closed';
    }
    await tx`
        insert into secret_version
            (id, ref, logical_version, storage, key_id, envelope, provider_ref, provider_version, payload_mac,
             state, operation_id, created_at_ms)
        values (${version.id}, ${version.ref}, ${version.logicalVersion}, ${version.storage}, ${version.keyId},
                ${version.envelope}, ${version.providerRef}, ${version.providerVersion}, ${version.payloadMac},
                'staged', ${version.operationId}, ${version.createdAtMs})
        on conflict (id) do nothing`;
    const stored = await findVersion(tx, version.id);
    if (!stored) {
        throw new Error('secret version vanished after staging');
    }
    return stored;
}

export async function markUnknown(tx: Sql, operationId: string): Promise<void> {
    await tx`update secret_operation set state = 'unknown' where operation_id = ${operationId} and state = 'pending'`;
}

/** Ends an operation inside the activation transaction; a failed one releases its staged version. */
async function finish(tx: Sql, op: OperationRow, nowMs: number, error: Failure | null): Promise<OperationRow> {
    const rows: Row[] = await tx`
        update secret_operation
           set state = ${error ? 'failed' : 'succeeded'}, completed_at_ms = ${nowMs},
               error_code = ${error?.code ?? null}, error_reason = ${error?.reason ?? null}
         where operation_id = ${op.operationId}
     returning *`;
    if (error && op.versionId) {
        await tx`update secret_version set state = 'collectable' where id = ${op.versionId} and state = 'staged'`;
    }
    return operationOf(rows[0] as Row);
}

const STALE: Failure = { code: 'conflict', reason: 'stale-version' };
const EXISTS: Failure = { code: 'conflict', reason: 'reference-exists' };

async function activateCreate(tx: Sql, op: OperationRow, nowMs: number): Promise<OperationRow> {
    const inserted: Row[] = await tx`
        insert into secret (ref, identity_key, state, created_at_ms, updated_at_ms)
        values (${op.ref}, ${op.identityKey}, 'active', ${nowMs}, ${nowMs})
        on conflict (ref) do nothing
        returning ref`;
    if (inserted.length === 0) {
        return finish(tx, op, nowMs, EXISTS);
    }
    await tx`update secret_version set state = 'active' where id = ${op.versionId}`;
    await tx`insert into secret_active (ref, version_id, logical_version) values (${op.ref}, ${op.versionId}, ${op.newVersion})`;
    return finish(tx, op, nowMs, null);
}

/** The compare-and-set of a replace or a delete: the pointer must still name the expected logical version. */
async function activateChange(tx: Sql, op: OperationRow, nowMs: number): Promise<OperationRow> {
    const secrets: Row[] = await tx`select state from secret where ref = ${op.ref} for update`;
    const pointers: Row[] =
        await tx`select version_id, logical_version from secret_active where ref = ${op.ref} for update`;
    const pointer = pointers[0];
    if (secrets[0]?.state !== 'active' || !pointer || pointer.logical_version !== op.expectedVersion) {
        return finish(tx, op, nowMs, STALE);
    }
    const previous = text(pointer.version_id);
    if (op.kind === 'delete') {
        await tx`delete from secret_active where ref = ${op.ref}`;
        await tx`update secret_version set state = 'cleanup-pending' where id = ${previous}`;
        await tx`update secret set state = 'tombstoned', updated_at_ms = ${nowMs} where ref = ${op.ref}`;
        return finish(tx, op, nowMs, null);
    }
    await tx`update secret_version set state = 'collectable' where id = ${previous}`;
    await tx`update secret_version set state = 'active' where id = ${op.versionId}`;
    await tx`update secret_active set version_id = ${op.versionId}, logical_version = ${op.newVersion} where ref = ${op.ref}`;
    await tx`update secret set updated_at_ms = ${nowMs} where ref = ${op.ref}`;
    return finish(tx, op, nowMs, null);
}

/** True when a create or replace has its staged version to activate; a delete has none. */
async function hasStagedVersion(tx: Sql, op: OperationRow): Promise<boolean> {
    if (op.kind === 'delete') {
        return true;
    }
    const staged: Row[] = await tx`select state from secret_version where id = ${op.versionId} for update`;
    return staged[0]?.state === 'staged' && op.newVersion !== null;
}

/**
 * The whole compare-and-set in one transaction. Everything is re-read under lock; nothing read before the
 * transaction is trusted. `'missing'` means the operation or its staged version is absent: nothing changed.
 */
export async function activate(tx: Sql, operationId: string, nowMs: number): Promise<OperationRow | 'missing'> {
    const op = await readOperation(tx, operationId, true);
    if (!op) {
        return 'missing';
    }
    if (op.state === 'succeeded' || op.state === 'failed') {
        return op;
    }
    if (!(await hasStagedVersion(tx, op))) {
        return 'missing';
    }
    return op.kind === 'create' ? activateCreate(tx, op, nowMs) : activateChange(tx, op, nowMs);
}

export async function listPendingCleanup(tx: Sql, ref: string, storage: PayloadStorage): Promise<string[]> {
    const rows: Row[] = await tx`
        select id from secret_version
         where ref = ${ref} and state = 'cleanup-pending' and storage = ${storage}`;
    return rows.map((row) => text(row.id));
}

export async function listCollectable(
    tx: Sql,
    afterId: string | null,
    limit: number,
    storage: PayloadStorage
): Promise<string[]> {
    const rows: Row[] = await tx`
        select id from secret_version
         where storage = ${storage}
           and (state in ('collectable', 'cleanup-pending', 'deleting')
                or (state = 'staged' and not exists (select 1 from secret_operation o
                                                      where o.version_id = secret_version.id
                                                        and o.state in ('pending', 'unknown'))))
           and (${afterId}::uuid is null or id > ${afterId})
         order by id limit ${limit}`;
    return rows.map((row) => text(row.id));
}

/**
 * Removal, phase one: never an active version, a pointed-at one or one an unresolved operation names. The
 * row stays (as `deleting`) until its payload is confirmed gone; `activate` only takes `staged`, so a
 * `deleting` version can never become active.
 */
export async function retireVersion(tx: Sql, id: string, storage: PayloadStorage): Promise<VersionRow | null> {
    const rows: Row[] = await tx`
        update secret_version v set state = 'deleting'
         where v.id = ${id}
           and v.storage = ${storage}
           and v.storage <> 'database'
           and v.state <> 'active'
           and not exists (select 1 from secret_active a where a.version_id = v.id)
           and not exists (select 1 from secret_operation o
                            where o.version_id = v.id and o.state in ('pending', 'unknown'))
     returning v.*`;
    return rows[0] ? versionOf(rows[0]) : null;
}

/** Removal of a database version: 091's own guarded delete, so no `deleting` row ever exists to strand. */
export async function removeInPlace(tx: Sql, id: string, storage: PayloadStorage): Promise<VersionRow | null> {
    const rows: Row[] = await tx`
        delete from secret_version v
         where v.id = ${id}
           and v.storage = ${storage}
           and v.storage = 'database'
           and v.state <> 'active'
           and not exists (select 1 from secret_active a where a.version_id = v.id)
           and not exists (select 1 from secret_operation o
                            where o.version_id = v.id and o.state in ('pending', 'unknown'))
     returning v.*`;
    return rows[0] ? versionOf(rows[0]) : null;
}

/** Removal, phase two: only a `deleting` row, re-checked here, is ever dropped. */
export async function dropVersion(tx: Sql, id: string): Promise<boolean> {
    const rows: Row[] = await tx`
        delete from secret_version v
         where v.id = ${id}
           and v.state = 'deleting'
           and not exists (select 1 from secret_active a where a.version_id = v.id)
     returning v.id`;
    return rows.length > 0;
}

export async function pruneOperations(tx: Sql, cutoffMs: number): Promise<number> {
    const rows: Row[] = await tx`
        delete from secret_operation
         where completed_at_ms is not null and completed_at_ms < ${cutoffMs}
     returning operation_id`;
    return rows.length;
}

export async function listForRotation(
    tx: Sql,
    activeKeyId: string,
    afterRef: string | null,
    limit: number
): Promise<RotationRow[]> {
    const rows: Row[] = await tx`
        select s.ref, s.identity_key, v.id as version_id, v.logical_version, v.key_id, v.envelope
          from secret_active a
          join secret s on s.ref = a.ref
          join secret_version v on v.id = a.version_id
         where s.state = 'active' and v.storage = 'database' and v.key_id <> ${activeKeyId}
           and (${afterRef}::text is null or s.ref > ${afterRef})
         order by s.ref limit ${limit}`;
    return rows.map((row) => ({
        ref: text(row.ref),
        identityKey: text(row.identity_key),
        versionId: text(row.version_id),
        logicalVersion: text(row.logical_version),
        keyId: text(row.key_id),
        envelope: row.envelope as Buffer,
    }));
}

/** Swap the pointer to `next` iff `expectedVersionId` is still active; false when the swap was lost. */
export async function rekeySwap(tx: Sql, ref: string, expectedVersionId: string, next: NewVersion): Promise<boolean> {
    const secrets: Row[] = await tx`select state from secret where ref = ${ref} for update`;
    const pointers: Row[] = await tx`select version_id from secret_active where ref = ${ref} for update`;
    if (secrets[0]?.state !== 'active' || pointers[0]?.version_id !== expectedVersionId) {
        return false;
    }
    await tx`update secret_version set state = 'collectable' where id = ${expectedVersionId}`;
    await tx`
        insert into secret_version
            (id, ref, logical_version, storage, key_id, envelope, state, operation_id, created_at_ms)
        values (${next.id}, ${next.ref}, ${next.logicalVersion}, 'database', ${next.keyId}, ${next.envelope},
                'active', null, ${next.createdAtMs})`;
    await tx`update secret_active set version_id = ${next.id} where ref = ${ref}`;
    return true;
}

export async function countByKey(tx: Sql, keyId: string): Promise<number> {
    const rows: Row[] =
        await tx`select count(*)::int as n from secret_version where storage = 'database' and key_id = ${keyId}`;
    return Number((rows[0] as Row).n);
}
