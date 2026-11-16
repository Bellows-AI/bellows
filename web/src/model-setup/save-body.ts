import { type ExecutorType, type ModelProvider, normalizeModelId } from '@factory-ai/core';
import type { ModelSetupSave, SetupScope } from '../api/useModelSetup.js';
import type { ModelSource } from './providers.js';

/**
 * The `PUT /api/model-setup` bodies the model setup sends, built in one place so each is one the route accepts
 * (`parseSave` in server/src/routes/model-setup.ts; mirrored in web/test/model-setup-keys.test.ts).
 */

/**
 * The agent-only variant the route takes, exactly as it decides: `platform` while the deployment supplies the model
 * (`PLATFORM_MODEL_PROVIDED`, the setup read's `platform`), else `existing` — a key already in the scope's view.
 */
export const agentOnlyProvider = (platform: boolean): 'platform' | 'existing' => (platform ? 'platform' : 'existing');

/**
 * The agent default alone, on whatever model the banner shows. The id is stored the way core stores it for the key
 * it runs on (`normalizeModelId`): the platform variant keeps an id as given, so the client normalizes first.
 */
export function agentOnlyBody(input: {
    platform: boolean;
    scope: SetupScope;
    source: ModelSource;
    agentType: ExecutorType;
    model: string;
}): ModelSetupSave {
    const { platform, scope, source, agentType, model } = input;
    return {
        scope,
        provider: agentOnlyProvider(platform),
        agentType,
        model: normalizeModelId(source, agentType, model),
    };
}

/** A key with its agent default; a base URL only where one is given and the provider takes one. */
export function keyBody(input: {
    scope: SetupScope;
    provider: ModelProvider;
    key: string;
    baseUrl: string;
    agentType: ExecutorType;
    model: string;
}): ModelSetupSave {
    const { scope, provider, agentType, model } = input;
    const baseUrl = provider === 'subscription' ? '' : input.baseUrl.trim();
    return { scope, provider, key: input.key.trim(), ...(baseUrl ? { baseUrl } : {}), agentType, model };
}
