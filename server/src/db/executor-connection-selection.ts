import type { TransactionSql } from 'postgres';
import type { StoredCredential } from './executor-credentials.js';
import {
    type ConnectionRefusalReason,
    connectionModelRefusal,
    connectionSelectionRefusal,
    type ExecutorType,
    type ModelProvider,
} from '@factory-ai/core';

/**
 * A write selecting a provider connection the profile may not use: another member's or a missing one (`missing`), a
 * personal one on an organization profile (`scope`), a provider that cannot run the executor type (`incompatible`)
 * or a model known to belong to another provider (`model`). The routes map it to a 409.
 */
export class ExecutorConnectionRefusedError extends Error {
    constructor(
        readonly reason: ConnectionRefusalReason,
        message: string
    ) {
        super(message);
        this.name = 'ExecutorConnectionRefusedError';
    }
}

export const selectedOf = (id: string | null): { providerConnectionId?: string } =>
    id === null ? {} : { providerConnectionId: id };

/**
 * The shared selection rule, run inside the write's transaction: the connection must be visible to the profile's
 * owner (`owner` null: the organization), its provider must run the executor type, and a connection that CHANGED
 * must not carry a model known to belong to another provider. The row is read `for share`, so a concurrent deletion
 * waits for this transaction — with the foreign key, no write can leave a reference dangling.
 */
export async function assertConnectionSelection(
    tx: TransactionSql,
    orgId: string,
    selection: {
        owner: string | null;
        connectionId: string | null;
        type: string;
        model: unknown;
        previousConnectionId: string | null;
    }
): Promise<void> {
    const { owner, connectionId, type, model, previousConnectionId } = selection;
    if (connectionId === null) return;
    const [row] = await tx<{ provider: ModelProvider; user_id: string | null }[]>`
        select provider, user_id from provider_connection
        where org_id = ${orgId} and id = ${connectionId}
        for share
    `;
    const agentType = type as ExecutorType;
    const refusal =
        connectionSelectionRefusal({
            connection: row
                ? { provider: row.provider, scope: row.user_id === null ? 'org' : 'personal', ownerId: row.user_id }
                : null,
            owner,
            agentType,
        }) ??
        (row && connectionId !== previousConnectionId ? connectionModelRefusal(row.provider, agentType, model) : null);
    if (refusal) throw new ExecutorConnectionRefusedError(refusal.reason, refusal.message);
}

/**
 * A scope transfer is a selection write: the row's connection must be visible to its NEW owner, so a promotion
 * cannot carry a personal connection into the organization. The model is unchanged, so it is not re-judged.
 */
export async function assertMovedSelection(
    tx: TransactionSql,
    orgId: string,
    { id, from, to }: { id: string; from: string | null; to: string | null }
): Promise<void> {
    const [row] = await tx<{ type: string; provider_connection_id: string | null }[]>`
        select type, provider_connection_id from executor_profile
        where org_id = ${orgId} and id = ${id} and user_id is not distinct from ${from}
        for update
    `;
    if (!row) return;
    await assertConnectionSelection(tx, orgId, {
        owner: to,
        connectionId: row.provider_connection_id,
        type: row.type,
        model: undefined,
        previousConnectionId: row.provider_connection_id,
    });
}

export const modelOf = (config: unknown): unknown =>
    typeof config === 'object' && config !== null ? (config as { model?: unknown }).model : undefined;

/**
 * `updateOrg`'s locked read: the org row's stored credentials and the connection it will hold after the patch (an
 * omitted field keeps the row's), the effective selection judged whatever field changed — a type change alone can
 * break the provider pair. Null when no such org row.
 */
export async function lockOrgRowForUpdate(
    tx: TransactionSql,
    orgId: string,
    {
        id,
        patch,
    }: { id: string; patch: { type?: string; config?: Record<string, unknown>; providerConnectionId?: string | null } }
): Promise<{ secret_refs: StoredCredential[]; connectionId: string | null } | null> {
    const [previous] = await tx<
        {
            type: string;
            config: Record<string, unknown>;
            secret_refs: StoredCredential[];
            provider_connection_id: string | null;
        }[]
    >`
        select type, config, secret_refs, provider_connection_id from executor_profile
        where org_id = ${orgId} and id = ${id} and user_id is null
        for update
    `;
    if (!previous) return null;
    const connectionId =
        patch.providerConnectionId === undefined ? previous.provider_connection_id : patch.providerConnectionId;
    await assertConnectionSelection(tx, orgId, {
        owner: null,
        connectionId,
        type: patch.type ?? previous.type,
        model: modelOf(patch.config ?? previous.config),
        previousConnectionId: previous.provider_connection_id,
    });
    return { secret_refs: previous.secret_refs, connectionId };
}
