import { createHash, randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import {
    type AgentProvider,
    type ExecutorType,
    type ModelProvider,
    normalizeModelId,
    PLATFORM_PROVIDER,
} from '@factory-ai/core';
import type { SecretDiagnostic, SecretStore } from '../secrets/secret-store.js';
import { ExecutorConnectionRefusedError } from './executor-connection-selection.js';
import { selectDefaultInTx } from './executor-default-store.js';
import { ExecutorRevisionError, writeSetupExecutor } from './executor-setup-rows.js';
import {
    connectionSecretDeps,
    insertConnectionRow,
    replaceConnectionRow,
} from './provider-connection-store.js';
import {
    mintConnectionSecret,
    providerConnectionSecretIdentity,
    releaseConnectionSecrets,
    retiredConnectionSecret,
    retireConnectionSecrets,
} from './provider-connection-secrets.js';
import { waitAdvisoryXactLock } from './pool.js';

/**
 * The model setup command (docs/persistence.md): a provider connection, the executor that references it and the default
 * selection commit in ONE organization-scoped transaction, under a per-scope lock, with the request's receipt. The key
 * is sealed in the secret store before the transaction, a failed transaction releases what it sealed (conservatively:
 * only what no connection row names), and a superseded key is retired only after the commit. A retry of the same request
 * finds the receipt and answers the same executor and connection. No environment credential and no agent default is
 * written: the connection is the credential's only home.
 */

/** Which connection the executor runs on. */
export type ConnectionIntent =
    /** Seals a new connection. A name already taken in the scope refuses (`ModelSetupNameConflict`); nothing is overwritten. */
    | {
          readonly intent: 'create';
          readonly provider: ModelProvider;
          readonly key: string;
          readonly baseUrl: string | null;
          readonly name: string;
      }
    /** Selects an existing connection the scope may use; its key and endpoint are untouched. */
    | { readonly intent: 'reuse'; readonly id: string }
    /** Replaces the key (and, when given, the endpoint) of a connection the scope owns, in place under its id. */
    | { readonly intent: 'rotate'; readonly id: string; readonly key: string; readonly baseUrl?: string | null }
    /** No connection: the deployment's platform model, or the scope's existing environment credentials, left as they are. */
    | { readonly intent: 'none'; readonly source?: AgentProvider };

export interface SetupCommand {
    readonly scope: 'org' | 'personal';
    /** The caller: the personal scope's owner, and the actor either way. The route has checked the admin role. */
    readonly userId: string;
    /** The client's durable request identity: the same id replays the receipt instead of writing again. */
    readonly requestId: string;
    readonly connection: ConnectionIntent;
    readonly executor: {
        /** The stable id of the executor to edit; absent creates one. */
        readonly id?: string;
        /** Required to create; an edit that omits it keeps the executor's name. */
        readonly name?: string;
        readonly agentType: ExecutorType;
        readonly model: string;
        readonly expectedUpdatedAt?: string;
    };
}

/** What a setup answers: stable identities and names only, never a credential or a reference. */
export interface SetupResult {
    readonly scope: 'org' | 'personal';
    readonly executorId: string;
    readonly executorName: string;
    readonly connectionId: string | null;
    readonly connectionName: string | null;
    /** True when the request id had already been applied: nothing was written this time. */
    readonly replayed: boolean;
}

/** A name the scope already holds: the connection's or the executor's. The route answers 409 `NAME_TAKEN`. */
export class ModelSetupNameConflict extends Error {
    constructor(readonly kind: 'connection' | 'executor') {
        super(`A ${kind} with that name already exists in this scope; choose another name`);
        this.name = 'ModelSetupNameConflict';
    }
}

/** The request id was applied before with a different command: a client bug, never a replay. */
export class ModelSetupRequestConflict extends Error {
    constructor() {
        super('This setup request id was already used for a different setup');
        this.name = 'ModelSetupRequestConflict';
    }
}

/** The setup raced a change of the executor it edits (a stale expected revision): retried by the client after a reread. */
export class ModelSetupConflict extends Error {
    constructor(message = 'Another model setup save changed this scope; try again') {
        super(message);
        this.name = 'ModelSetupConflict';
    }
}

/** The default executor a member's tasks run on, as the setup view reads it: names and ids only. */
export interface SelectedSetup {
    readonly scope: 'org' | 'personal';
    readonly executorId: string;
    readonly executorName: string;
    readonly agentType: string;
    readonly model: string | null;
    readonly suspended: boolean;
    /** The connection the executor selects, when the member may see it; null for none. */
    readonly connection: {
        readonly id: string;
        readonly name: string;
        readonly provider: ModelProvider;
        readonly scope: 'org' | 'personal';
    } | null;
}

export interface ModelSetupStore {
    /** The member's configured default executor, else the organization's, with its connection; null when none is configured. A failed read throws. */
    selectedFor(userId: string): Promise<SelectedSetup | null>;
    /** Applies the command atomically, or replays its receipt. Any throw leaves the previous setup and default as they were. */
    apply(command: SetupCommand): Promise<SetupResult>;
}

const UNIQUE_VIOLATION = '23505';
const CONNECTION_NAME_INDEX = 'provider_connection_name_uk';
const EXECUTOR_NAME_INDEX = 'executor_profile_name_uk';
const RECEIPT_RETENTION = '30 days';
const MISSING_MESSAGE = 'The provider connection does not exist or is not available to you.';

type Superseded = ReturnType<typeof retiredConnectionSecret>;

const setupLockKey = (orgId: string, owner: string | null) => `model-setup:${orgId}:${owner ?? 'org'}`;

/** The command's non-secret fields, hashed: the receipt refuses the same request id carrying a different command. */
function fingerprintOf(command: SetupCommand): string {
    const { connection, executor } = command;
    const connectionFields =
        connection.intent === 'create'
            ? { intent: connection.intent, provider: connection.provider, name: connection.name, baseUrl: connection.baseUrl }
            : connection.intent === 'rotate'
              ? { intent: connection.intent, id: connection.id, baseUrl: connection.baseUrl ?? null }
              : connection.intent === 'reuse'
                ? { intent: connection.intent, id: connection.id }
                : { intent: connection.intent, source: connection.source ?? PLATFORM_PROVIDER };
    return createHash('sha256')
        .update(
            JSON.stringify({
                scope: command.scope,
                connection: connectionFields,
                executor: {
                    id: executor.id ?? null,
                    name: executor.name ?? null,
                    agentType: executor.agentType,
                    model: executor.model,
                },
            })
        )
        .digest('hex');
}

interface ReceiptRow {
    fingerprint: string;
    executor_id: string;
    executor_name: string;
    connection_id: string | null;
    connection_name: string | null;
}

async function readReceipt(
    exec: Sql | TransactionSql,
    orgId: string,
    owner: string | null,
    requestId: string
): Promise<ReceiptRow | null> {
    const [row] = await (exec as Sql)<ReceiptRow[]>`
        select o.fingerprint, o.executor_id, p.name as executor_name, o.connection_id, c.name as connection_name
        from model_setup_operation o
        join executor_profile p on p.org_id = o.org_id and p.id = o.executor_id
        left join provider_connection c on c.org_id = o.org_id and c.id = o.connection_id
        where o.org_id = ${orgId} and o.owner_id is not distinct from ${owner} and o.request_id = ${requestId}
    `;
    return row ?? null;
}

function replayOf(receipt: ReceiptRow, command: SetupCommand, fingerprint: string): SetupResult {
    if (receipt.fingerprint !== fingerprint) throw new ModelSetupRequestConflict();
    return {
        scope: command.scope,
        executorId: receipt.executor_id,
        executorName: receipt.executor_name,
        connectionId: receipt.connection_id,
        connectionName: receipt.connection_name,
        replayed: true,
    };
}

/** The organization is bound at construction: one store serves one organization. */
export function createModelSetupStore({
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
    /** Holds the connection's key (docs/secrets.md). */
    secrets: SecretStore;
    secretLog: (diagnostic: SecretDiagnostic) => void;
    writeDeadlineMs?: number;
    cleanupDeadlineMs?: number;
}): ModelSetupStore {
    const deps = connectionSecretDeps({ sql, orgId, secrets, secretLog, writeDeadlineMs, cleanupDeadlineMs });

    /** The refusal a rotation of a connection the scope does not own is: absent, whatever the reason. */
    const refuseMissing = () => new ExecutorConnectionRefusedError('missing', MISSING_MESSAGE);

    async function connectionRowOf(tx: Sql | TransactionSql, id: string): Promise<{ provider: ModelProvider; name: string }> {
        const [row] = await (tx as Sql)<{ provider: ModelProvider; name: string }[]>`
            select provider, name from provider_connection where org_id = ${orgId} and id = ${id}
        `;
        if (!row) throw refuseMissing();
        return row;
    }

    /** Publishes the command inside the transaction: the connection step, the executor, the default and the receipt. */
    async function publish(
        tx: TransactionSql,
        command: SetupCommand,
        owner: string | null,
        fingerprint: string,
        sealed: { id: string | null; made: Awaited<ReturnType<typeof mintConnectionSecret>> | null }
    ): Promise<{ result: SetupResult; superseded: Superseded | undefined }> {
        await waitAdvisoryXactLock(tx, setupLockKey(orgId, owner));
        const receipt = await readReceipt(tx, orgId, owner, command.requestId);
        if (receipt) return { result: replayOf(receipt, command, fingerprint), superseded: undefined };

        const { connection, executor } = command;
        let source: AgentProvider = PLATFORM_PROVIDER;
        let connectionId: string | null = null;
        let connectionName: string | null = null;
        let superseded: Superseded | undefined;
        if (connection.intent === 'create') {
            const meta = await insertConnectionRow(tx, {
                orgId,
                id: sealed.id!,
                owner,
                input: {
                    scope: command.scope,
                    userId: command.userId,
                    provider: connection.provider,
                    name: connection.name,
                    baseUrl: connection.baseUrl,
                    key: connection.key,
                },
                made: sealed.made!,
            });
            ({ id: connectionId, name: connectionName } = meta);
            source = connection.provider;
        } else if (connection.intent === 'rotate') {
            const replaced = await replaceConnectionRow(tx, {
                orgId,
                owner,
                id: connection.id,
                patch: { key: connection.key, ...(connection.baseUrl === undefined ? {} : { baseUrl: connection.baseUrl }) },
                made: sealed.made,
            });
            if (!replaced) throw refuseMissing();
            ({ id: connectionId, name: connectionName } = replaced.row);
            source = replaced.row.provider;
            superseded = replaced.superseded;
        } else if (connection.intent === 'reuse') {
            const row = await connectionRowOf(tx, connection.id);
            connectionId = connection.id;
            connectionName = row.name;
            source = row.provider;
        } else {
            source = connection.source ?? PLATFORM_PROVIDER;
        }

        const written = await writeSetupExecutor(tx, orgId, {
            owner,
            userId: command.userId,
            id: executor.id,
            name: executor.name,
            agentType: executor.agentType,
            model: normalizeModelId(source, executor.agentType, executor.model),
            connectionId,
            expectedUpdatedAt: executor.expectedUpdatedAt,
        });
        await selectDefaultInTx(tx, orgId, owner, written.id);
        await tx`
            delete from model_setup_operation
            where org_id = ${orgId} and owner_id is not distinct from ${owner}
              and created_at < now() - ${RECEIPT_RETENTION}::interval
        `;
        await tx`
            insert into model_setup_operation (org_id, owner_id, request_id, fingerprint, executor_id, connection_id, created_by)
            values (${orgId}, ${owner}, ${command.requestId}, ${fingerprint}, ${written.id}, ${connectionId}, ${command.userId})
        `;
        return {
            result: {
                scope: command.scope,
                executorId: written.id,
                executorName: written.name,
                connectionId,
                connectionName,
                replayed: false,
            },
            superseded,
        };
    }

    return {
        async selectedFor(userId) {
            if (ready) await ready;
            const [row] = await sql<
                {
                    owner_id: string | null;
                    id: string;
                    name: string;
                    type: string;
                    model: string | null;
                    suspended: boolean;
                    connection_id: string | null;
                    connection_name: string | null;
                    connection_provider: ModelProvider | null;
                    connection_user_id: string | null;
                }[]
            >`
                select s.owner_id, p.id, p.name, p.type, p.config->>'model' as model, p.suspended,
                    c.id as connection_id, c.name as connection_name, c.provider as connection_provider,
                    c.user_id as connection_user_id
                from executor_default_selection s
                join executor_profile p on p.org_id = s.org_id and p.id = s.executor_id
                left join provider_connection c on c.org_id = p.org_id and c.id = p.provider_connection_id
                    and (c.user_id is null or c.user_id = ${userId})
                where s.org_id = ${orgId} and (s.owner_id = ${userId} or s.owner_id is null)
                order by (s.owner_id is null)
                limit 1
            `;
            if (!row) return null;
            return {
                scope: row.owner_id === null ? 'org' : 'personal',
                executorId: row.id,
                executorName: row.name,
                agentType: row.type,
                model: row.model,
                suspended: row.suspended,
                connection:
                    row.connection_id === null
                        ? null
                        : {
                              id: row.connection_id,
                              name: row.connection_name!,
                              provider: row.connection_provider!,
                              scope: row.connection_user_id === null ? 'org' : 'personal',
                          },
            };
        },

        async apply(command) {
            if (ready) await ready;
            const owner = command.scope === 'org' ? null : command.userId;
            const fingerprint = fingerprintOf(command);
            // A request this scope already applied answers from its receipt before anything is sealed.
            const earlier = await readReceipt(sql, orgId, owner, command.requestId);
            if (earlier) return replayOf(earlier, command, fingerprint);

            const { connection } = command;
            let id: string | null = null;
            let made: Awaited<ReturnType<typeof mintConnectionSecret>> | null = null;
            if (connection.intent === 'create') {
                id = randomUUID();
                made = await mintConnectionSecret(deps, providerConnectionSecretIdentity(orgId, id, owner), connection.key);
            } else if (connection.intent === 'rotate') {
                // Rotation reaches a connection the scope owns only; checked before a fresh key is sealed.
                const [owned] = await sql`
                    select 1 from provider_connection
                    where org_id = ${orgId} and id = ${connection.id} and user_id is not distinct from ${owner}
                `;
                if (!owned) throw refuseMissing();
                made = await mintConnectionSecret(
                    deps,
                    providerConnectionSecretIdentity(orgId, connection.id, owner),
                    connection.key
                );
            }
            try {
                const { result, superseded } = await sql.begin((tx) =>
                    publish(tx, command, owner, fingerprint, { id, made })
                );
                // A replay under the lock wrote nothing: what was sealed for it is unreferenced.
                if (result.replayed && made) await releaseConnectionSecrets(deps, [made]);
                if (superseded) await retireConnectionSecrets(deps, [superseded]);
                return result;
            } catch (error) {
                if (made) await releaseConnectionSecrets(deps, [made]);
                throw translated(error);
            }
        },
    };
}

/** The domain refusal a unique violation or a stale revision stands for; any other error is the caller's to see. */
function translated(error: unknown): unknown {
    if (error instanceof ExecutorRevisionError) return new ModelSetupConflict(error.message);
    const { code, constraint_name: constraint } = error as { code?: string; constraint_name?: string };
    if (code !== UNIQUE_VIOLATION) return error;
    if (constraint === CONNECTION_NAME_INDEX) return new ModelSetupNameConflict('connection');
    if (constraint === EXECUTOR_NAME_INDEX) return new ModelSetupNameConflict('executor');
    return error;
}
