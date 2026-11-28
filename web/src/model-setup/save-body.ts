import type { ExecutorType, ModelProvider } from '@factory-ai/core';
import type { ModelSetupSave, SelectedExecutorView, SetupScope } from '../api/useModelSetup.js';

/**
 * The `PUT /api/model-setup` bodies the model setup sends, built in one place so each is one the route accepts
 * (`parseSetup` in server/src/routes/model-setup-save.ts; mirrored in web/test/model-setup-bodies.test.ts). Three intents
 * about the connection — create, reuse, rotate — never inferred from a provider's name or label.
 */

/**
 * A new key: a connection sealed under `name`, and the executor that runs on it, made the default. A base URL only
 * where one is given and the provider takes one.
 */
export function createBody(input: {
    scope: SetupScope;
    provider: ModelProvider;
    key: string;
    baseUrl: string;
    name: string;
    agentType: ExecutorType;
    model: string;
}): ModelSetupSave {
    const { scope, provider, agentType, model } = input;
    const name = input.name.trim();
    const baseUrl = provider === 'subscription' ? '' : input.baseUrl.trim();
    return {
        scope,
        agentType,
        model,
        connection: { intent: 'create', provider, key: input.key.trim(), ...(baseUrl ? { baseUrl } : {}), name },
        executor: { name },
    };
}

/**
 * The selected executor's agent and model changed: the same executor by id on the same connection, at the revision the
 * member read. The key is never sent, so a model-only edit cannot rotate it.
 */
export function editBody(input: {
    selected: SelectedExecutorView;
    connectionId: string;
    agentType: ExecutorType;
    model: string;
}): ModelSetupSave {
    const { selected, agentType, model } = input;
    return {
        scope: selected.scope,
        agentType,
        model,
        connection: { intent: 'reuse', id: input.connectionId },
        executor: { id: selected.executorId, expectedUpdatedAt: selected.updatedAt },
    };
}

/** Explicit rotation: a fresh key for the selected executor's own connection, under its id, at the revision the member read; the endpoint stays. */
export function rotateBody(input: {
    selected: SelectedExecutorView;
    connectionId: string;
    key: string;
    agentType: ExecutorType;
    model: string;
}): ModelSetupSave {
    const { selected, agentType, model } = input;
    return {
        scope: selected.scope,
        agentType,
        model,
        connection: { intent: 'rotate', id: input.connectionId, key: input.key.trim() },
        executor: { id: selected.executorId, expectedUpdatedAt: selected.updatedAt },
    };
}
