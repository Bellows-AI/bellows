import type { JSONValue, TransactionSql } from 'postgres';
import { CLAUDE_CODE, DEFAULT_GATE_FIX_ROUNDS, type ExecutorType } from '@factory-ai/core';
import { assertConnectionSelection } from './executor-connection-selection.js';
import { ExecutorIdentityError } from './executor-default-store.js';
import { CLAUDE_MODEL_ENV } from './jobs/job-store-claim-executor.js';

/**
 * The provider setup's executor write, as a transaction body (provider-setup-store.ts): one profile created or edited by its
 * stable id, carrying a connection id and a model and no credential of its own, so nothing here seals a secret. It
 * is the same row the executor routes write — `assertConnectionSelection` judges the pair — composed into the setup's
 * transaction instead of opening its own.
 */

/** The executor changed since the revision the caller read: nothing was written. The route answers 409. */
export class ExecutorRevisionError extends Error {
    constructor() {
        super('The executor changed since you read it; reload and try again');
        this.name = 'ExecutorRevisionError';
    }
}

export interface SetupExecutorInput {
    /** The scope's owner: a member's id, or null for the organization's. */
    readonly owner: string | null;
    /** The caller, recorded as an organization row's creator. */
    readonly userId: string;
    /** The stable id of the profile to edit; absent creates one. */
    readonly id?: string | undefined;
    /** Required to create; an edit that omits it keeps the row's name. */
    readonly name?: string | undefined;
    readonly agentType: ExecutorType;
    /** The model id as the executor stores it (`normalizeModelId`). */
    readonly model: string;
    readonly connectionId: string | null;
    /** The `updatedAt` the caller last read; a different stored one refuses the edit. */
    readonly expectedUpdatedAt?: string | undefined;
}

export interface SetupExecutor {
    readonly id: string;
    readonly name: string;
}

/** Writes the profile and answers its identity. The connection selection is judged first, in this transaction. */
export async function writeSetupExecutor(
    tx: TransactionSql,
    orgId: string,
    input: SetupExecutorInput
): Promise<SetupExecutor> {
    const { owner, id } = input;
    if (id === undefined) {
        if (input.name === undefined) throw new Error('a new executor needs a name');
        await assertSelection(tx, orgId, input);
        return insertRow(tx, orgId, { ...input, name: input.name });
    }
    const [previous] = await tx<{ updated_at: Date; config: Record<string, JSONValue> | null }[]>`
        select updated_at, config from executor_profile
        where org_id = ${orgId} and id = ${id} and user_id is not distinct from ${owner}
        for update
    `;
    if (!previous) {
        throw new ExecutorIdentityError(
            `"${id}" is not ${owner === null ? 'an organization' : 'one of your'} executor`
        );
    }
    const expected = input.expectedUpdatedAt;
    if (expected !== undefined && new Date(expected).getTime() !== previous.updated_at.getTime()) {
        throw new ExecutorRevisionError();
    }
    await assertSelection(tx, orgId, input);
    const [row] = await tx<{ id: string; name: string }[]>`
        update executor_profile set
            name = coalesce(${input.name ?? null}, name), type = ${input.agentType},
            config = ${tx.json(configWithModel(previous.config, input.agentType, input.model))},
            provider_connection_id = ${input.connectionId}, provider_migration_reason = null, updated_at = now()
        where org_id = ${orgId} and id = ${id} and user_id is not distinct from ${owner}
        returning id, name
    `;
    return row!;
}

/**
 * The profile's config with the saved model laid over it. Claude Code runs `env.ANTHROPIC_MODEL` over the config's
 * `model`, so a pin there is moved to the new model (or dropped for an agent that reads none): the model saved is the
 * one that runs. Every other key stays.
 */
function configWithModel(
    config: Record<string, JSONValue> | null,
    agentType: ExecutorType,
    model: string
): Record<string, JSONValue> {
    const next: Record<string, JSONValue> = { ...config, model };
    const { env } = next;
    if (typeof env !== 'object' || env === null || Array.isArray(env) || !(CLAUDE_MODEL_ENV in env)) return next;
    const { [CLAUDE_MODEL_ENV]: _pinned, ...rest } = env as Record<string, JSONValue>;
    next.env = agentType === CLAUDE_CODE ? { ...rest, [CLAUDE_MODEL_ENV]: model } : rest;
    return next;
}

/** The shared selection rule, always judging the model too: a model-only edit is still a selection of that pair. */
const assertSelection = (tx: TransactionSql, orgId: string, input: SetupExecutorInput) =>
    assertConnectionSelection(tx, orgId, {
        owner: input.owner,
        connectionId: input.connectionId,
        type: input.agentType,
        model: input.model,
        previousConnectionId: null,
    });

async function insertRow(
    tx: TransactionSql,
    orgId: string,
    input: SetupExecutorInput & { name: string }
): Promise<SetupExecutor> {
    const { owner } = input;
    const [next] = await tx<{ next: number }[]>`
        select coalesce(max(position) + 1, 0) as next from executor_profile
        where org_id = ${orgId} and user_id is not distinct from ${owner}
    `;
    const [row] = await tx<{ id: string; name: string }[]>`
        insert into executor_profile
            (org_id, user_id, name, type, config, secret_refs, gate_fix_rounds, position, created_by,
             provider_connection_id)
        values (
            ${orgId}, ${owner}, ${input.name}, ${input.agentType}, ${tx.json({ model: input.model })},
            ${tx.json([])}, ${DEFAULT_GATE_FIX_ROUNDS}, ${next?.next ?? 0}, ${owner === null ? input.userId : null},
            ${input.connectionId}
        )
        returning id, name
    `;
    return row!;
}
