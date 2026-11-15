import type { Fragment, TransactionSql } from 'postgres';
import type { EnvSecretScope } from './env-secrets.js';
import { waitAdvisoryXactLock } from './pool.js';

/** One write entry: what env-var-store.ts calls `EnvVarEntry`, restated so this module imports nothing from it. */
interface Entry {
    name: string;
    value: string | null;
    isSecret: boolean;
}

/** A write that touches only the names it carries: `upsert` creates or replaces each, `remove` deletes each. */
export interface ScopeWrite {
    upsert: readonly Entry[];
    remove: readonly string[];
}

/**
 * Judges the list the scope would hold once a write commits — the caller's rules (cap, cloud credential checks,
 * unique names), run on names read under the scope lock. A reason refuses the write; null admits it.
 */
export type ScopeValidator = (resulting: readonly Entry[]) => string | null;

export interface WriteScopedOptions {
    validate?: ScopeValidator;
    /** Runs last inside the write's transaction, under the scope lock; a throw rolls the env write back. */
    alsoInTx?: (tx: TransactionSql) => Promise<void>;
}

/** The validator's refusal, thrown inside the transaction so it rolls back; `reason` is the validator's text. */
export class EnvScopeRefusal extends Error {
    constructor(readonly reason: string) {
        super(reason);
        this.name = 'EnvScopeRefusal';
    }
}

/** The scope's identity in the lock key and the audit row. */
export const scopeKeyOf = (scope: EnvSecretScope): string => {
    if (scope.kind === 'org') return 'org';
    if (scope.kind === 'workspace') return `workspace/${scope.userId}`;
    return `repo/${scope.owner}/${scope.name}`;
};

/**
 * Every write to one scope holds this transaction lock, keyed on (org, scope), so a whole-list replace and a
 * single-name write serialize instead of interleaving their delete and insert. `lock_timeout` bounds the wait (and
 * every row-lock wait after it; the statement timeout is lifted for the wait): a stuck holder fails the write with
 * 55P03 rather than hanging it.
 */
export async function lockScope(
    tx: TransactionSql,
    orgId: string,
    scope: EnvSecretScope,
    lockTimeoutMs: number
): Promise<void> {
    await tx`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`;
    await waitAdvisoryXactLock(tx, `env_var:${orgId}:${scopeKeyOf(scope)}`);
}

/**
 * The list the scope will hold: its stored rows (read under the lock; a secret's value null) minus every touched
 * name, then the upserts. A failed read throws — it is never an empty scope, which would pass the cap and the
 * credential checks it was meant to decide.
 */
export async function resultingList(
    tx: TransactionSql,
    orgId: string,
    where: Fragment,
    write: ScopeWrite
): Promise<Entry[]> {
    const stored = await tx<{ name: string; value: string | null; is_secret: boolean }[]>`
        select name, value, is_secret from env_var where org_id = ${orgId} ${where} order by name asc
    `;
    const touched = new Set([...write.remove, ...write.upsert.map((v) => v.name)]);
    return [
        ...stored
            .filter((row) => !touched.has(row.name))
            .map((row) => ({ name: row.name, value: row.is_secret ? null : row.value, isSecret: row.is_secret })),
        ...write.upsert,
    ];
}

/** Deletes the touched names, answering what each deleted row referenced. */
export const deleteNames = (tx: TransactionSql, orgId: string, where: Fragment, names: readonly string[]) =>
    tx<{ name: string; secret_ref: string | null; secret_version: string | null }[]>`
        delete from env_var where org_id = ${orgId} ${where} and name in ${tx(names)}
        returning name, secret_ref, secret_version
    `;
