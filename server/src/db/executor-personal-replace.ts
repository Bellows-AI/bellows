import type { TransactionSql } from 'postgres';
import { DEFAULT_GATE_FIX_ROUNDS } from '@factory-ai/core';
import { assertUnselected, ExecutorIdentityError } from './executor-default-store.js';
import { isDeepStrictEqual } from 'node:util';
import {
    assertConnectionSelection,
    ExecutorConnectionRefusedError,
    MIGRATION_PENDING_MESSAGE,
    MISSING_CONNECTION_MESSAGE,
    modelOf,
} from './executor-connection-selection.js';
import { type StoredCredential, storedOf } from './executor-credentials.js';

/** One entry of a personal whole-list save (`UserExecutorStore.replace`). */
export interface PersonalExecutorEntry {
    /**
     * The row's stable identity. An entry that sends one updates that row of the member's own — a rename keeps its
     * connection and default references — and an id the member does not own, or one sent twice, is refused
     * (`ExecutorIdentityError`). An entry without one keeps the identity of a same-named row; a row no entry
     * names is deleted, which a configured default forbids (`ExecutorDefaultProtectedError`).
     */
    id?: string;
    name: string;
    type: string;
    config: Record<string, unknown>;
    gateFixRounds?: number;
    /** Omitted: the suspension the row the entry survives as already carried survives the rewrite. */
    suspended?: boolean;
    /**
     * The connection the entry selects, validated in the transaction (`ExecutorConnectionRefusedError`). Null only
     * carries back a migration-suspended row, by id, with its config unchanged: it keeps its null connection and reason.
     */
    providerConnectionId: string | null;
}

/** What `replacePersonalRows` carries over from the stored row an entry survives as. */
interface PreviousRow {
    id: string;
    name: string;
    type: string;
    suspended: boolean;
    secret_refs: StoredCredential[];
    provider_connection_id: string | null;
    provider_migration_reason: string | null;
    provider_migration_pending: boolean;
    config: unknown;
}

/**
 * Which stored row each entry survives as: the one its `id` names, else the same-named row no id claimed. An id the
 * member does not own — another member's, an organization profile's, an unknown one — or one sent twice is refused.
 */
function matchPersonalRows(
    previous: readonly PreviousRow[],
    executors: readonly PersonalExecutorEntry[]
): (PreviousRow | undefined)[] {
    const byId = new Map(previous.map((row) => [row.id, row]));
    const byName = new Map(previous.map((row) => [row.name, row]));
    const claimed = new Set<string>();
    const matched: (PreviousRow | undefined)[] = executors.map(() => undefined);
    for (const [index, executor] of executors.entries()) {
        if (executor.id === undefined) continue;
        const row = byId.get(executor.id);
        if (!row) throw new ExecutorIdentityError(`"${executor.id}" is not one of your executors`);
        if (claimed.has(row.id)) throw new ExecutorIdentityError(`executor id "${row.id}" is named twice`);
        claimed.add(row.id);
        matched[index] = row;
    }
    // Entries without an id keep a same-named row no id claimed.
    for (const [index, executor] of executors.entries()) {
        const row = executor.id === undefined ? byName.get(executor.name) : undefined;
        if (!row || claimed.has(row.id)) continue;
        claimed.add(row.id);
        matched[index] = row;
    }
    return matched;
}

/**
 * Whether an entry with no connection only carries back the row it names: a migration-suspended row (a reason, still
 * suspended) or one the migration has not reached (pending), same type and config, its suspension untouched.
 */
function carriesMigrationRow(row: PreviousRow | undefined, executor: PersonalExecutorEntry): boolean {
    return (
        row !== undefined &&
        executor.id === row.id &&
        executor.type === row.type &&
        row.provider_connection_id === null &&
        (row.provider_migration_pending || (row.provider_migration_reason !== null && row.suspended)) &&
        (executor.suspended ?? row.suspended) === row.suspended &&
        isDeepStrictEqual(row.config, executor.config)
    );
}

/**
 * Each entry names its connection and each selection is judged in this transaction; a null one is only the
 * carried-back migration-suspended row.
 */
async function assertSelections(
    tx: TransactionSql,
    { orgId, userId }: { orgId: string; userId: string },
    executors: readonly PersonalExecutorEntry[],
    matched: readonly (PreviousRow | undefined)[]
): Promise<void> {
    for (const [index, executor] of executors.entries()) {
        const connectionId = executor.providerConnectionId;
        if (connectionId === null) {
            if (!carriesMigrationRow(matched[index], executor)) {
                const pending = matched[index]?.provider_migration_pending;
                throw new ExecutorConnectionRefusedError(
                    'missing',
                    pending ? MIGRATION_PENDING_MESSAGE : MISSING_CONNECTION_MESSAGE
                );
            }
            continue;
        }
        await assertConnectionSelection(tx, orgId, {
            owner: userId,
            connectionId,
            type: executor.type,
            model: modelOf(executor.config),
            previousConnectionId: matched[index]?.provider_connection_id ?? null,
        });
    }
}

/**
 * `replace()`'s transaction body: the member's personal list reconciled by identity. A surviving row is updated in place
 * under its id, a new entry inserted, an omitted row deleted — unless a default still names it. `sealedOf` turns the
 * stored credentials of the rows being rewritten into the sealed configs (executor-credentials.ts).
 */
export async function replacePersonalRows(
    tx: TransactionSql,
    { orgId, userId }: { orgId: string; userId: string },
    executors: readonly PersonalExecutorEntry[],
    sealedOf: (
        previous: readonly StoredCredential[]
    ) => { config: Record<string, unknown>; secretRefs: StoredCredential[] }[]
): Promise<void> {
    // Read before the write: an entry that does not say otherwise keeps the suspension and connection of the row it
    // survives as (issue 440), and a stored credential sent back as its marker stays stored.
    const previous = await tx<PreviousRow[]>`
        select id, name, type, suspended, secret_refs, provider_connection_id, provider_migration_reason,
            provider_migration_pending, config
        from executor_profile
        where org_id = ${orgId} and user_id = ${userId}
        for update
    `;
    const matched = matchPersonalRows(previous, executors);
    await assertSelections(tx, { orgId, userId }, executors, matched);
    const survivors = new Set(matched.filter((row) => row !== undefined).map((row) => row.id));
    const omitted = previous.filter((row) => !survivors.has(row.id));
    await assertUnselected(tx, orgId, omitted, userId);
    const sealed = sealedOf(storedOf(previous));
    if (omitted.length) {
        await tx`delete from executor_profile where org_id = ${orgId} and id in ${tx(omitted.map((row) => row.id))}`;
    }
    // Names move by identity, so two survivors may trade names: park them under their ids first, as the name index is
    // not deferrable.
    if (survivors.size) {
        await tx`
            update executor_profile set name = id::text
            where org_id = ${orgId} and id in ${tx([...survivors])}
        `;
    }
    // `position` is the member's own order, taken from the array index. It has to be stored rather
    // than inferred: this is one transaction, so every row lands with the same `now()` and a
    // created_at sort is a total tie (041's header).
    for (const [index, executor] of executors.entries()) {
        const row = matched[index];
        const values = {
            name: executor.name,
            type: executor.type,
            config: tx.json(sealed[index]!.config as never),
            secret_refs: tx.json(sealed[index]!.secretRefs as never),
            gate_fix_rounds: executor.gateFixRounds ?? DEFAULT_GATE_FIX_ROUNDS,
            position: index,
            suspended: executor.suspended ?? row?.suspended ?? false,
            provider_connection_id: executor.providerConnectionId,
            provider_migration_reason: executor.providerConnectionId === null ? row!.provider_migration_reason : null,
            provider_migration_pending: executor.providerConnectionId === null && row!.provider_migration_pending,
        };
        if (row) {
            await tx`
                update executor_profile set ${tx(values)}, updated_at = now()
                where org_id = ${orgId} and id = ${row.id}
            `;
        } else {
            await tx`insert into executor_profile ${tx({ org_id: orgId, user_id: userId, ...values })}`;
        }
    }
}
