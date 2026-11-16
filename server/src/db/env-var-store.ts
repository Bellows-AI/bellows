import { stackModelEnv } from '@factory-ai/core';
import type { Fragment, Sql, TransactionSql } from 'postgres';
import { recordAudit, userActor } from './audit-log.js';
import type { SecretDiagnostic, SecretRef, SecretStore, SecretVersion } from '../secrets/secret-store.js';
import {
    createEnvSecrets,
    EnvSecretError,
    envSecretIdentity,
    readSecretValues,
    releaseEnvSecrets,
    retireEnvSecrets,
    type EncryptedEnvRow,
    type EnvSecretScope,
    type RetiredEnvSecret,
} from './env-secrets.js';
import {
    deleteNames,
    EnvScopeRefusal,
    lockScope,
    resultingList,
    withLockedRemovals,
    scopeKeyOf,
    type ScopeWrite,
    type WriteScopedOptions,
} from './env-var-write.js';

export { EnvScopeRefusal, type ScopeValidator, type ScopeWrite, type WriteScopedOptions } from './env-var-write.js';

/**
 * One entry in a PUT body. `value: null` is legal ONLY for a secret, and means "keep whatever is
 * stored" — the write-only escape hatch that lets a browser edit a scope's list without ever
 * seeing, or re-sending, the secret values it holds. A name omitted from the body deletes the row.
 */
export interface EnvVarEntry {
    name: string;
    value: string | null;
    isSecret: boolean;
}

/** What the list routes echo. A secret's `value` is null for every caller — see listScoped. */
export interface EnvVarRow extends EnvVarEntry {
    readonly updatedAt: string;
}

export interface EnvVarStore {
    listOrg(): Promise<EnvVarRow[]>;
    listWorkspace(userId: string): Promise<EnvVarRow[]>;
    listRepo(owner: string, name: string): Promise<EnvVarRow[]>;
    /** Every repo scope's rows, grouped, for the page's per-repository editors. */
    listRepos(): Promise<{ owner: string; name: string; vars: EnvVarRow[] }[]>;
    /** Each replace is audited as `actorId`'s (a workspace's actor is its owner) in the write's transaction. */
    replaceOrg(actorId: string, vars: readonly EnvVarEntry[]): Promise<void>;
    replaceWorkspace(userId: string, vars: readonly EnvVarEntry[]): Promise<void>;
    replaceRepo(actorId: string, owner: string, name: string, vars: readonly EnvVarEntry[]): Promise<void>;
    /**
     * Writes or deletes only the names `write` carries, leaving the rest of the scope as stored, under the same
     * scope lock as the replaces. `validate` judges the list the scope would hold (a reason throws
     * `EnvScopeRefusal`); `alsoInTx` runs in the same transaction. An upsert with a null value is ignored.
     */
    writeScoped(scope: EnvSecretScope, write: ScopeWrite, actorId: string, options?: WriteScopedOptions): Promise<void>;
    /**
     * The merged environment one claim carries: org < workspace < repo, the more specific scope
     * winning a name collision. `userId` null contributes no workspace level (an unattributed
     * job); `repo` null contributes no repo level. Returns real values — secrets included —
     * because injection is what they are for; every other read path goes through the list
     * methods, which never echo one.
     *
     * `exec` lets a caller run the read on an executor it already holds (the job store's claim
     * passes its transaction, so a claim holds one connection, never two) — the pool by default.
     */
    resolveFor(
        target: { userId: string | null; repo: string | null },
        exec?: Sql | TransactionSql
    ): Promise<Record<string, string>>;
}

interface Row {
    name: string;
    value: string | null;
    is_secret: boolean;
    updated_at: Date;
}

interface ResolveRow {
    name: string;
    value: string | null;
    is_secret: boolean;
    secret_ref: string | null;
    secret_version: string | null;
    user_id: string | null;
    repo_owner: string | null;
    repo_name: string | null;
    scope: 'org' | 'workspace' | 'repo';
}

const scopeOfRow = (row: ResolveRow): Scope => {
    if (row.scope === 'workspace') return { kind: 'workspace', userId: row.user_id as string };
    if (row.scope === 'repo') return { kind: 'repo', owner: row.repo_owner as string, name: row.repo_name as string };
    return { kind: 'org' };
};

/**
 * One stored format per kind (113_env_var_secret_form.sql); anything else throws. A non-secret holds
 * its value and no reference; a secret holds a reference and version and no value.
 */
const storedForm = (
    orgId: string,
    row: ResolveRow
): { plaintext: string; encrypted?: undefined } | { plaintext?: undefined; encrypted: EncryptedEnvRow } => {
    if (!row.is_secret && row.secret_ref === null && row.value !== null) return { plaintext: row.value };
    if (row.is_secret && row.secret_ref !== null && row.value === null && row.secret_version !== null) {
        return {
            encrypted: {
                name: row.name,
                ref: row.secret_ref,
                version: row.secret_version,
                identity: envSecretIdentity(orgId, scopeOfRow(row), row.name),
            },
        };
    }
    throw new EnvSecretError(row.name, 'malformed-row', 'malformed-row');
};

const toRow = (row: Row): EnvVarRow => ({
    name: row.name,
    value: row.value,
    isSecret: row.is_secret,
    updatedAt: row.updated_at.toISOString(),
});

/**
 * The stacking rule, in one place and pure: `org` first, `workspace` over it, `repo` over that —
 * the issue's "everything should stack upon each other", and the GitHub Actions precedence
 * (repository beats organization). The model credentials are the exception (`stackModelEnv`): the
 * highest scope naming any of them supplies all of them, so a lower scope's key never rides along
 * with a higher scope's provider. Exported because a rule this load-bearing is pinned by the
 * offline suite, which cannot reach the SQL that feeds it.
 */
export function stackEnv(
    org: Record<string, string>,
    workspace: Record<string, string>,
    repo: Record<string, string>
): Record<string, string> {
    return stackModelEnv([org, workspace, repo]);
}

/**
 * Which of the three scopes a method call addresses. One shape, so the list and the replace paths
 * share their where-clauses instead of restating them — and so a fourth scope, if one ever lands,
 * is a case here and not a search for every query in the file.
 */
type Scope = EnvSecretScope;

/**
 * The scope's predicate, built off whichever executor (pool or transaction) will run it — a
 * fragment is bound to nothing, but building it from the transaction's own tag keeps every
 * parameter inside the one prepared statement.
 */
const scopeWhere = (exec: Sql | TransactionSql, scope: Scope): Fragment => {
    switch (scope.kind) {
        case 'org':
            return exec`and user_id is null and repo_owner is null`;
        case 'workspace':
            return exec`and user_id = ${scope.userId}`;
        case 'repo':
            return exec`and repo_owner = ${scope.owner} and repo_name = ${scope.name}`;
    }
};

interface DeletedRow {
    name: string;
    secret_ref: string | null;
    secret_version: string | null;
}

/** Deletes the scope's rows except the kept secrets, answering what each deleted row referenced. */
const deleteScope = (tx: TransactionSql, orgId: string, scope: Scope, keep: readonly string[]) =>
    keep.length
        ? tx<DeletedRow[]>`
            delete from env_var
            where org_id = ${orgId} ${scopeWhere(tx, scope)}
              and name not in ${tx(keep)}
            returning name, secret_ref, secret_version
        `
        : tx<DeletedRow[]>`
            delete from env_var where org_id = ${orgId} ${scopeWhere(tx, scope)}
            returning name, secret_ref, secret_version
        `;

/** The stored records the deleted rows named; they are deleted from the store once the PUT commits. */
const retiredOf = (orgId: string, scope: Scope, deleted: readonly DeletedRow[]): RetiredEnvSecret[] =>
    deleted.flatMap((row) =>
        row.secret_ref === null || row.secret_version === null
            ? []
            : [
                  {
                      ref: row.secret_ref as SecretRef,
                      version: row.secret_version as SecretVersion,
                      identity: envSecretIdentity(orgId, scope, row.name),
                  },
              ]
    );

const insertRows = async (tx: TransactionSql, rows: ReturnType<typeof rowsToInsert>) => {
    if (!rows.length) return;
    await tx`
        insert into env_var ${tx(rows, 'org_id', 'user_id', 'repo_owner', 'repo_name', 'name', 'value', 'is_secret', 'secret_ref', 'secret_version')}
    `;
};

/**
 * The rows a PUT inserts. The scope columns ride on every row: null for the scopes a row is not in, the scope
 * check enforcing exactly one set. A secret carries its reference and no value; a non-secret its value and no
 * reference.
 */
const rowsToInsert = (
    orgId: string,
    scope: Scope,
    vars: readonly EnvVarEntry[],
    created: ReadonlyMap<string, { ref: SecretRef; version: SecretVersion }>
) =>
    vars
        .filter((v) => v.value !== null)
        .map((v) => {
            const stored = v.isSecret ? created.get(v.name) : undefined;
            return {
                org_id: orgId,
                user_id: scope.kind === 'workspace' ? scope.userId : null,
                repo_owner: scope.kind === 'repo' ? scope.owner : null,
                repo_name: scope.kind === 'repo' ? scope.name : null,
                name: v.name,
                value: v.isSecret ? null : (v.value as string),
                is_secret: v.isSecret,
                secret_ref: stored?.ref ?? null,
                secret_version: stored?.version ?? null,
            };
        });

/** One write's transaction, under the scope lock: it pushes onto `retired` the references its deletes dropped. */
type TxBody = (
    tx: TransactionSql,
    created: ReadonlyMap<string, { ref: SecretRef; version: SecretVersion }>,
    retired: RetiredEnvSecret[]
) => Promise<void>;

/**
 * The whole-list replace, a delete-then-insert (the user-executor-store shape). The keep set: a secret whose incoming
 * entry carries `value: null` survives the delete and is NOT re-inserted, so a client never re-sends values it can
 * never read. Omitted names delete; non-secret rows never survive.
 */
const replaceBody =
    (orgId: string, scope: Scope, vars: readonly EnvVarEntry[], actorId: string): TxBody =>
    async (tx, created, retired) => {
        const keep = vars.filter((v) => v.isSecret && v.value === null).map((v) => v.name);
        retired.push(...retiredOf(orgId, scope, await deleteScope(tx, orgId, scope, keep)));
        await insertRows(tx, rowsToInsert(orgId, scope, vars, created));
        // The names the scope now holds, never a value.
        await recordAudit(tx, {
            orgId,
            actor: userActor(actorId),
            action: 'env.write',
            target: scopeKeyOf(scope),
            detail: { names: vars.map((v) => v.name).sort() },
        });
    };

/**
 * Only the touched names: the resulting list is read under the lock and judged before anything is deleted, so a
 * refusal or a failed read leaves the scope as it was and releases what this write created.
 */
const namesBody =
    (
        orgId: string,
        scope: Scope,
        actorId: string,
        { write: asked, options }: { write: ScopeWrite; options: WriteScopedOptions }
    ): TxBody =>
    async (tx, created, retired) => {
        const write = await withLockedRemovals(tx, orgId, scopeWhere(tx, scope), {
            write: asked,
            removeOf: options.removeOf,
        });
        const resulting = await resultingList(tx, orgId, scopeWhere(tx, scope), write);
        const reason = options.validate?.(resulting) ?? null;
        if (reason !== null) throw new EnvScopeRefusal(reason);
        const touched = [...new Set([...write.remove, ...write.upsert.map((v) => v.name)])];
        if (touched.length) {
            retired.push(...retiredOf(orgId, scope, await deleteNames(tx, orgId, scopeWhere(tx, scope), touched)));
        }
        await insertRows(tx, rowsToInsert(orgId, scope, write.upsert, created));
        await recordAudit(tx, {
            orgId,
            actor: userActor(actorId),
            action: 'env.write',
            target: scopeKeyOf(scope),
            detail: { names: resulting.map((v) => v.name).sort() },
        });
        await options.alsoInTx?.(tx);
    };

/**
 * The organization is bound at construction: it is a constant for the life of the process, and a
 * per-call parameter is one more thing a write path can forget.
 *
 * `ready` gates every query, the way every other store built in main.ts does: migrations retry
 * with backoff while the database container starts, and a boot that raced them would answer 503s
 * for a moment rather than crash.
 */
export function createEnvVarStore({
    sql,
    orgId,
    ready,
    secrets,
    secretLog,
    writeDeadlineMs = 30_000,
    cleanupDeadlineMs = 10_000,
    lockTimeoutMs = 10_000,
}: {
    sql: Sql;
    orgId: string;
    /** Holds every secret's value; the claim's resolve reads it (docs/env.md). */
    secrets: SecretStore;
    /** The secret store's diagnostic sink: a compensation that could not finish is reported here. */
    secretLog: (diagnostic: SecretDiagnostic) => void;
    ready?: Promise<unknown>;
    /** Bounds a PUT's creates; compensation runs under its own `cleanupDeadlineMs`. */
    writeDeadlineMs?: number;
    cleanupDeadlineMs?: number;
    /** Bounds the wait for the scope lock another write holds; past it the write fails (55P03). */
    lockTimeoutMs?: number;
}): EnvVarStore {
    const gate = async () => {
        if (ready) await ready;
    };

    /**
     * The read the page gets. A secret's value is nulled out IN THE SELECT, not dropped on the way
     * through JavaScript — the row still travels (name, updatedAt, the fact that it is a secret),
     * only the value is withheld, which is what lets the UI render "set" without holding it.
     */
    const listScoped = async (scope: Scope): Promise<EnvVarRow[]> => {
        const rows = await sql<Row[]>`
            select name,
                   case when is_secret then null else value end as value,
                   is_secret, updated_at
            from env_var
            where org_id = ${orgId} ${scopeWhere(sql, scope)}
            order by name asc
        `;
        return rows.map(toRow);
    };

    /**
     * Every write's frame, parameterised by scope. Every secret with a value is written to the store first, under no
     * transaction; then one transaction takes the scope lock and runs `body`, which stores only references and
     * versions and pushes onto `retired` the references its deletes dropped. Non-secrets never reach the store. A
     * changed value gets a new reference and the old one is deleted after the commit. A write that does not commit
     * deletes the records it created, but only those a fresh read of this scope shows no row naming (docs/env.md).
     */
    const writeWithSecrets = async (scope: Scope, vars: readonly EnvVarEntry[], body: TxBody): Promise<void> => {
        await gate();
        const referencedInScope = () =>
            sql<{ secret_ref: string | null }[]>`
                select secret_ref from env_var where org_id = ${orgId} ${scopeWhere(sql, scope)}
            `;
        const cleanup = () => ({ signal: AbortSignal.timeout(cleanupDeadlineMs), diagnose: secretLog });

        const writes = vars.filter((v) => v.isSecret && v.value !== null);
        const { created, unknown, failure } = await createEnvSecrets(
            secrets,
            writes.map((v) => ({
                name: v.name,
                identity: envSecretIdentity(orgId, scope, v.name),
                value: v.value as string,
            })),
            { signal: AbortSignal.timeout(writeDeadlineMs) }
        );
        if (failure) {
            await releaseEnvSecrets(secrets, [...created, ...unknown], { ...cleanup(), referencedInScope });
            throw failure;
        }
        const createdByName = new Map(created.map((c) => [c.name, c]));

        const retired: RetiredEnvSecret[] = [];
        try {
            await sql.begin(async (tx) => {
                await lockScope(tx, orgId, scope, lockTimeoutMs);
                await body(tx, createdByName, retired);
            });
        } catch (error) {
            await releaseEnvSecrets(secrets, [...created, ...retired], { ...cleanup(), referencedInScope });
            throw error;
        }
        await retireEnvSecrets(secrets, retired, cleanup());
    };

    const replaceScoped = (scope: Scope, vars: readonly EnvVarEntry[], actorId: string): Promise<void> =>
        writeWithSecrets(scope, vars, replaceBody(orgId, scope, vars, actorId));

    const writeScoped = (
        scope: Scope,
        write: ScopeWrite,
        actorId: string,
        options: WriteScopedOptions = {}
    ): Promise<void> => {
        const upsert = write.upsert.filter((v) => v.value !== null);
        return writeWithSecrets(
            scope,
            upsert,
            namesBody(orgId, scope, actorId, { write: { upsert, remove: write.remove }, options })
        );
    };

    /**
     * Every row's real value, in the rows' order: a non-secret's value, or a secret's reference
     * decrypted here. A row that is neither, a failed or inconclusive read, a version other than the
     * stored one, or bytes that are not UTF-8 throws: a secret is never dropped from an environment.
     */
    const valuesOf = async (rows: readonly ResolveRow[]): Promise<string[]> => {
        const values: string[] = new Array(rows.length);
        const encrypted: (EncryptedEnvRow & { index: number })[] = [];
        rows.forEach((row, index) => {
            const stored = storedForm(orgId, row);
            if (stored.plaintext !== undefined) values[index] = stored.plaintext;
            else encrypted.push({ ...stored.encrypted, index });
        });
        const read = await readSecretValues(secrets, encrypted);
        encrypted.forEach(({ index }, i) => {
            values[index] = read[i] as string;
        });
        return values;
    };

    return {
        async listOrg() {
            await gate();
            return listScoped({ kind: 'org' });
        },

        async listWorkspace(userId) {
            await gate();
            return listScoped({ kind: 'workspace', userId });
        },

        async listRepo(owner, name) {
            await gate();
            return listScoped({ kind: 'repo', owner, name });
        },

        async listRepos() {
            await gate();
            const rows = await sql<(Row & { repo_owner: string; repo_name: string })[]>`
                select repo_owner, repo_name, name,
                       case when is_secret then null else value end as value,
                       is_secret, updated_at
                from env_var
                where org_id = ${orgId} and repo_owner is not null
                order by repo_owner asc, repo_name asc, name asc
            `;
            const grouped: { owner: string; name: string; vars: EnvVarRow[] }[] = [];
            for (const row of rows) {
                let group = grouped.find((g) => g.owner === row.repo_owner && g.name === row.repo_name);
                if (!group) {
                    group = { owner: row.repo_owner, name: row.repo_name, vars: [] };
                    grouped.push(group);
                }
                group.vars.push(toRow(row));
            }
            return grouped;
        },

        async replaceOrg(actorId, vars) {
            await replaceScoped({ kind: 'org' }, vars, actorId);
        },

        async replaceWorkspace(userId, vars) {
            await replaceScoped({ kind: 'workspace', userId }, vars, userId);
        },

        async replaceRepo(actorId, owner, name, vars) {
            await replaceScoped({ kind: 'repo', owner, name }, vars, actorId);
        },

        writeScoped,

        async resolveFor({ userId, repo }, exec = sql) {
            await gate();
            const [owner, name] = repo ? repo.split('/') : [null, null];
            // One round trip for all three levels. The predicates degrade on their own: a null
            // userId makes `user_id = null` never true, so an unattributed job reads no workspace
            // level — the same for a null repo. The scope check guarantees a row matched by the
            // workspace arm is a workspace row, so the case below can label it.
            const rows = await (exec as Sql)<ResolveRow[]>`
                select name, value, is_secret, secret_ref, secret_version, user_id, repo_owner, repo_name,
                       case
                           when user_id is not null then 'workspace'
                           when repo_owner is not null then 'repo'
                           else 'org'
                       end as scope
                from env_var
                where org_id = ${orgId}
                  and (
                      (user_id is null and repo_owner is null)
                      or user_id = ${userId}
                      or (repo_owner = ${owner} and repo_name = ${name})
                  )
            `;
            const values = await valuesOf(rows);
            const pick = (scope: string): Record<string, string> =>
                Object.fromEntries(
                    rows.flatMap((row, i) => (row.scope === scope ? [[row.name, values[i] as string]] : []))
                );
            return stackEnv(pick('org'), pick('workspace'), pick('repo'));
        },
    };
}
