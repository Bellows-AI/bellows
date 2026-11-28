import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import {
    type ConnectionCredential,
    type ConnectionSelectionRefusal,
    MAX_PROVIDER_CONNECTIONS_PER_SCOPE,
    type ModelProvider,
    type ProviderConnectionMeta,
    type ProviderConnectionScope,
    type SelectedConnection,
} from '@factory-ai/core';
import { waitAdvisoryXactLock } from './pool.js';
import type { SecretDiagnostic, SecretStore } from '../secrets/secret-store.js';
import {
    mintConnectionSecret,
    providerConnectionSecretIdentity,
    readConnectionCredential,
    releaseConnectionSecrets,
    retiredConnectionSecret,
    retireConnectionSecrets,
    type ProviderConnectionSecretDeps,
} from './provider-connection-secrets.js';

/**
 * One provider connection: a member's personal row (`userId` set) or an organization-wide row the
 * administrators manage and every member may use (docs/api.md). The table is one, with sibling
 * scopes — 047_executor_profile_scope.sql's shape — so the nullness of the owner is the scope. The
 * key is sealed in the secret store before any row is written, the row holds only the reference and
 * version, and a rotation mints a fresh reference and swaps it beside the endpoint in one
 * transaction, retiring the superseded secret after the commit.
 */

/** A connection create: the scope decides the owner, `userId` the caller (and a personal row's owner). */
export interface ProviderConnectionInput {
    readonly scope: ProviderConnectionScope;
    readonly userId: string;
    readonly provider: ModelProvider;
    readonly name: string;
    readonly baseUrl: string | null;
    readonly key: string;
}

/** A connection edit: an omitted field keeps the row's. Provider and scope are not fields. */
export interface ProviderConnectionPatch {
    readonly name?: string;
    /** Absent keeps the row's; null clears it; a string replaces it (the route checks the provider's rules). */
    readonly baseUrl?: string | null;
    /** Present rotates: a fresh sealed reference, swapped in atomically, the old one retired after. */
    readonly key?: string;
}

export interface ProviderConnectionStore {
    /** The member's own connections plus the organization's (the executor visibility split), metadata only. */
    listFor(userId: string): Promise<ProviderConnectionMeta[]>;
    /** The one connection the member may see or act on — their own or the organization's. Null when none matches. */
    forUser(userId: string, id: string): Promise<ProviderConnectionMeta | null>;
    /** How many rows the scope holds — the route's cap pre-check, beside the create's own enforced one. */
    count(scope: ProviderConnectionScope, userId: string): Promise<number>;
    /** Creates a connection, its key sealed first. Refuses a scope over the cap (`ProviderConnectionCapError`); a duplicate name surfaces as the name index. */
    create(input: ProviderConnectionInput): Promise<ProviderConnectionMeta>;
    /** Edits the row `owner` owns (null: the organization's). Null when no such row. */
    update(owner: string | null, id: string, patch: ProviderConnectionPatch): Promise<ProviderConnectionMeta | null>;
    /**
     * Deletes the row and retires its stored secret after the commit. False when no such row. Refused with
     * `ProviderConnectionReferencedError` while an executor profile selects it, naming only the executors `viewer`
     * (a member's id; absent sees the organization's alone) can see — never a silent clear.
     */
    remove(owner: string | null, id: string, viewer?: string): Promise<boolean>;
    /**
     * The stored key of a connection the member may use, with its metadata, fail-closed: any answer
     * that is not a confirmed value of the stored version throws, so a caller never treats an
     * inconclusive read as an absent or wrong key.
     */
    credentialFor(userId: string, id: string): Promise<{ connection: ProviderConnectionMeta; key: string } | null>;
    /**
     * The claim's read, on the claim's transaction: the connection a profile selected, judged by `check` (the
     * shared selection rules, which see the row's provider, scope and owner) BEFORE its key is read, then its
     * current sealed key, fail-closed like `credentialFor` — an unconfirmed read throws and the claim rolls back.
     */
    claimCredentialFor(
        exec: Sql | TransactionSql,
        id: string,
        check: (connection: SelectedConnection | null) => ConnectionSelectionRefusal | null
    ): Promise<{ refusal: ConnectionSelectionRefusal } | { credential: ConnectionCredential }>;
}

/** The per-scope cap is full. The routes answer `TOO_MANY_CONNECTIONS`. */
export class ProviderConnectionCapError extends Error {
    constructor() {
        super(`at most ${MAX_PROVIDER_CONNECTIONS_PER_SCOPE} provider connections can be configured per scope`);
        this.name = 'ProviderConnectionCapError';
    }
}

/** One executor profile that selects a connection, as a deletion refusal may name it. */
export interface ReferencingExecutor {
    readonly name: string;
    readonly scope: 'org' | 'personal';
}

/**
 * Deleting a connection executor profiles still select is refused (`executor_profile_provider_connection_fk`),
 * and the stored secret is retired only after a deletion that committed. `executors` names only the referencing
 * profiles the caller can see — the organization's and their own; `otherReferences` says others exist, without
 * saying whose or what.
 */
export class ProviderConnectionReferencedError extends Error {
    constructor(
        readonly executors: readonly ReferencingExecutor[],
        readonly otherReferences: boolean
    ) {
        super(
            executors.length > 0
                ? `The connection is still used by: ${executors.map((e) => `${e.scope} executor ${e.name}`).join(', ')}${otherReferences ? ', and by other executors' : ''}.`
                : 'The connection is still used by other executors.'
        );
        this.name = 'ProviderConnectionReferencedError';
    }
}

const FOREIGN_KEY_VIOLATION = '23503';
const EXECUTOR_REFERENCE_FK = 'executor_profile_provider_connection_fk';

const isExecutorReference = (error: unknown): boolean =>
    (error as { code?: string; constraint_name?: string }).code === FOREIGN_KEY_VIOLATION &&
    (error as { constraint_name?: string }).constraint_name === EXECUTOR_REFERENCE_FK;

interface Row {
    id: string;
    name: string;
    provider: ModelProvider;
    user_id: string | null;
    base_url: string | null;
    secret_ref: string | null;
    secret_version: string | null;
}

/** The sealed row a superseding write or a fail-closed read starts from: the reference is not null. */
interface SealedRow extends Row {
    secret_ref: string;
    secret_version: string;
}

/** The columns a metadata answer is built from: never `secret_ref` or `secret_version` unguarded. */
const META_COLUMNS = (exec: Sql | TransactionSql) =>
    exec`id, name, provider, user_id, base_url, (secret_ref is not null) as has_key`;

const toMeta = (row: {
    id: string;
    name: string;
    provider: ModelProvider;
    user_id: string | null;
    base_url: string | null;
    has_key?: boolean | null;
    secret_ref?: string | null;
}): ProviderConnectionMeta => ({
    id: row.id,
    name: row.name,
    provider: row.provider,
    scope: row.user_id === null ? 'org' : 'personal',
    baseUrl: row.base_url,
    hasKey: row.has_key === undefined ? row.secret_ref !== null : Boolean(row.has_key),
});

/** The refusal a claim reads a missing row as; the shared rule words it the same (`connectionSelectionRefusal`). */
const MISSING_REFUSAL: ConnectionSelectionRefusal = {
    reason: 'missing',
    message: 'The provider connection does not exist or is not available to you.',
};

/** What a refused deletion names: the referencing profiles the viewer can see, and whether any other exist. */
async function referencedError(
    sql: Sql,
    orgId: string,
    id: string,
    viewer: string | undefined
): Promise<ProviderConnectionReferencedError> {
    const rows = await sql<{ name: string; user_id: string | null }[]>`
        select name, user_id from executor_profile
        where org_id = ${orgId} and provider_connection_id = ${id}
        order by (user_id is not null), position, name
    `;
    const visible = rows.filter((row) => row.user_id === null || row.user_id === viewer);
    return new ProviderConnectionReferencedError(
        visible.map((row) => ({ name: row.name, scope: row.user_id === null ? 'org' : 'personal' })),
        visible.length < rows.length
    );
}

/** The lock one scope's create holds for its count-then-insert, so concurrent creates cannot race past the cap. */
const scopeLockKey = (orgId: string, owner: string | null) => `provider-connection:${orgId}:${owner ?? 'org'}`;

/**
 * The edit's one transaction: lock the row `owner` owns, publish the name, endpoint and — on a
 * rotation — the fresh reference and version in one statement, and answer what the superseded
 * secret is. `null` when no such row: the caller releases what it minted.
 */
export async function replaceConnectionRow(
    tx: TransactionSql,
    {
        orgId,
        owner,
        id,
        patch,
        made,
    }: {
        orgId: string;
        owner: string | null;
        id: string;
        patch: ProviderConnectionPatch;
        made: Awaited<ReturnType<typeof mintConnectionSecret>> | null;
    }
): Promise<{ row: Row; superseded: ReturnType<typeof retiredConnectionSecret> | undefined } | null> {
    const [current] = await tx<SealedRow[]>`
        select id, name, provider, user_id, base_url, secret_ref, secret_version
        from provider_connection
        where org_id = ${orgId} and id = ${id} and user_id is not distinct from ${owner}
        for update
    `;
    if (!current) return null;
    const name = patch.name ?? current.name;
    const baseUrl = patch.baseUrl === undefined ? current.base_url : patch.baseUrl;
    const [row] = await tx<Row[]>`
        update provider_connection set
            name = ${name}, base_url = ${baseUrl}, updated_at = now()
            ${made ? tx`, secret_ref = ${made.ref}, secret_version = ${made.version}` : tx``}
        where org_id = ${orgId} and id = ${id} and user_id is not distinct from ${owner}
        returning id, name, provider, user_id, base_url, secret_ref
    `;
    if (!row) return null;
    return {
        row,
        superseded: made ? retiredConnectionSecret(orgId, id, current.user_id, current) : undefined,
    };
}

/**
 * The create's one transaction body: under the scope's lock, refuse a scope at the cap, then insert the row holding
 * the minted reference. The setup command (provider-setup-store.ts) runs it inside its own transaction beside the executor
 * and the default selection, so a connection never commits apart from them.
 */
export async function insertConnectionRow(
    tx: TransactionSql,
    {
        orgId,
        id,
        owner,
        input,
        made,
    }: {
        orgId: string;
        id: string;
        owner: string | null;
        input: ProviderConnectionInput;
        made: Awaited<ReturnType<typeof mintConnectionSecret>>;
    }
): Promise<ProviderConnectionMeta> {
    await waitAdvisoryXactLock(tx, scopeLockKey(orgId, owner));
    const counted = await tx<{ count: number }[]>`
        select count(*)::int as count from provider_connection
        where org_id = ${orgId} and user_id is not distinct from ${owner}
    `;
    if ((counted[0]?.count ?? 0) >= MAX_PROVIDER_CONNECTIONS_PER_SCOPE) throw new ProviderConnectionCapError();
    const rows = await tx<Row[]>`
        insert into provider_connection
            (org_id, id, user_id, name, provider, base_url, secret_ref, secret_version, created_by)
        values (
            ${orgId}, ${id}, ${owner}, ${input.name}, ${input.provider}, ${input.baseUrl},
            ${made.ref}, ${made.version}, ${input.userId}
        )
        returning id, name, provider, user_id, base_url, secret_ref
    `;
    return toMeta(rows[0]!);
}

/** The secret helpers' dependencies for one organization, with the compensation's fresh read of its references. */
export function connectionSecretDeps({
    sql,
    orgId,
    secrets,
    secretLog,
    writeDeadlineMs = 30_000,
    cleanupDeadlineMs = 10_000,
}: {
    sql: Sql;
    orgId: string;
    secrets: SecretStore;
    secretLog: (diagnostic: SecretDiagnostic) => void;
    writeDeadlineMs?: number;
    cleanupDeadlineMs?: number;
}): ProviderConnectionSecretDeps {
    return {
        orgId,
        secrets,
        secretLog,
        writeDeadlineMs,
        cleanupDeadlineMs,
        referencedRefs: () =>
            sql<{ secret_ref: string | null }[]>`
                select secret_ref from provider_connection where org_id = ${orgId}
            `,
    };
}

export function createProviderConnectionStore({
    sql,
    orgId,
    ready,
    secrets,
    secretLog,
    writeDeadlineMs = 30_000,
    cleanupDeadlineMs = 10_000,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown> | undefined;
    /** Holds every connection's key (docs/secrets.md). */
    secrets: SecretStore;
    /** The secret store's diagnostic sink: a compensation that could not finish is reported here. */
    secretLog: (diagnostic: SecretDiagnostic) => void;
    writeDeadlineMs?: number;
    cleanupDeadlineMs?: number;
}): ProviderConnectionStore {
    const deps = connectionSecretDeps({ sql, orgId, secrets, secretLog, writeDeadlineMs, cleanupDeadlineMs });
    const gate = async () => {
        if (ready) await ready;
    };
    /** The visibility predicate every member-shaped read shares: own rows and the organization's. */
    const visibleTo = (userId: string) => sql`(user_id = ${userId}::uuid or user_id is null)`;
    const identityOf = (id: string, owner: string | null) => providerConnectionSecretIdentity(orgId, id, owner);

    return {
        async listFor(userId) {
            await gate();
            const rows = await sql<Row[]>`
                select ${META_COLUMNS(sql)} from provider_connection
                where org_id = ${orgId} and ${visibleTo(userId)}
                order by (user_id is not null) desc, created_at, id
            `;
            return rows.map(toMeta);
        },

        async forUser(userId, id) {
            await gate();
            const rows = await sql<Row[]>`
                select ${META_COLUMNS(sql)} from provider_connection
                where org_id = ${orgId} and id = ${id} and ${visibleTo(userId)}
            `;
            return rows[0] ? toMeta(rows[0]) : null;
        },

        async count(scope, userId) {
            await gate();
            const rows = await sql<{ count: number }[]>`
                select count(*)::int as count from provider_connection
                where org_id = ${orgId} and ${scope === 'org' ? sql`user_id is null` : sql`user_id = ${userId}::uuid`}
            `;
            return rows[0]?.count ?? 0;
        },

        async create(input) {
            await gate();
            const id = randomUUID();
            const owner = input.scope === 'org' ? null : input.userId;
            const made = await mintConnectionSecret(deps, identityOf(id, owner), input.key);
            try {
                return await sql.begin((tx) => insertConnectionRow(tx, { orgId, id, owner, input, made }));
            } catch (error) {
                await releaseConnectionSecrets(deps, [made]);
                throw error;
            }
        },

        async update(owner, id, patch) {
            await gate();
            const made =
                patch.key === undefined ? null : await mintConnectionSecret(deps, identityOf(id, owner), patch.key);
            const dropMade = () => (made ? releaseConnectionSecrets(deps, [made]) : undefined);
            try {
                const replaced = await sql.begin(async (tx) =>
                    replaceConnectionRow(tx, { orgId, owner, id, patch, made })
                );
                if (!replaced) {
                    await dropMade();
                    return null;
                }
                if (replaced.superseded) await retireConnectionSecrets(deps, [replaced.superseded]);
                return toMeta(replaced.row);
            } catch (error) {
                await dropMade();
                throw error;
            }
        },

        async remove(owner, id, viewer) {
            await gate();
            const rows = await sql<{ secret_ref: string; secret_version: string; user_id: string | null }[]>`
                delete from provider_connection
                where org_id = ${orgId} and id = ${id} and user_id is not distinct from ${owner}
                returning secret_ref, secret_version, user_id
            `.catch(async (error: unknown) => {
                if (!isExecutorReference(error)) throw error;
                throw await referencedError(sql, orgId, id, viewer);
            });
            const row = rows[0];
            if (row) {
                await retireConnectionSecrets(deps, [retiredConnectionSecret(orgId, id, row.user_id, row)]);
                return true;
            }
            return false;
        },

        async claimCredentialFor(exec, id, check) {
            if (ready) await ready;
            const rows = await (exec as Sql)<SealedRow[]>`
                select id, name, provider, user_id, base_url, secret_ref, secret_version
                from provider_connection
                where org_id = ${orgId} and id = ${id}
            `;
            const row = rows[0];
            const refusal = check(
                row
                    ? { provider: row.provider, scope: row.user_id === null ? 'org' : 'personal', ownerId: row.user_id }
                    : null
            );
            if (refusal || !row) return { refusal: refusal ?? MISSING_REFUSAL };
            const key = await readConnectionCredential(secrets, {
                orgId,
                userId: row.user_id,
                connectionId: row.id,
                name: row.name,
                ref: row.secret_ref,
                version: row.secret_version,
            });
            return { credential: { provider: row.provider, key, baseUrl: row.base_url } };
        },

        async credentialFor(userId, id) {
            await gate();
            const rows = await sql<SealedRow[]>`
                select id, name, provider, user_id, base_url, secret_ref, secret_version
                from provider_connection
                where org_id = ${orgId} and id = ${id} and ${visibleTo(userId)}
            `;
            const row = rows[0];
            if (!row) return null;
            const key = await readConnectionCredential(secrets, {
                orgId,
                userId: row.user_id,
                connectionId: row.id,
                name: row.name,
                ref: row.secret_ref,
                version: row.secret_version,
            });
            return { connection: toMeta(row), key };
        },
    };
}
