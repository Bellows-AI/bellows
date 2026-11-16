import {
    type AgentProvider,
    type DeploymentMode,
    type ExecutorType,
    inferProvider,
    isModelProvider,
    MODEL_PROVIDERS,
    type ModelProvider,
    normalizeModelId,
    PROVIDER_BASE_URL_ENV,
    PROVIDER_ENV,
    providerEnvNames,
} from '@factory-ai/core';
import type { EnvSecretScope } from '../db/env-secrets.js';
import type { EnvVarStore } from '../db/env-var-store.js';
import type { UserExecutorStore } from '../db/user-executor-store.js';
import { validateScopeList } from './env.js';

/**
 * The model setup's writes (`PUT /api/model-setup`, docs/api.md): a key with its agent default in one transaction,
 * or the agent default alone. The HTTP shape and the refusals are routes/model-setup.ts'.
 */

export type SetupScope = 'org' | 'personal';

export interface ModelSetupStores {
    readonly envVars: EnvVarStore;
    readonly executors: UserExecutorStore;
    readonly deploymentMode: DeploymentMode;
}

/** A key save: the provider's key (and base URL) and the agent that runs on it. */
export interface KeySave {
    readonly scope: SetupScope;
    /** The caller: the personal scope's owner, and the write's actor in either scope. */
    readonly userId: string;
    readonly provider: ModelProvider;
    readonly key: string;
    readonly baseUrl?: string | undefined;
    readonly agentType: ExecutorType;
    readonly model: string;
}

/** The provider recorded on the scope's agent default moved while the save ran: retried with the new one. */
class ProviderMoved extends Error {}

/** Every name any provider's setup writes: the names a provider switch reasons about. */
const PROVIDER_NAMES = new Set(MODEL_PROVIDERS.flatMap(providerEnvNames));

/** The tries a save makes before it reports a conflict: each one only re-reads what a concurrent save changed. */
const ATTEMPTS = 3;

export class ModelSetupConflict extends Error {
    constructor() {
        super('Another model setup save changed this scope; try again');
        this.name = 'ModelSetupConflict';
    }
}

export const ownerOf = (scope: SetupScope, userId: string): string | null => (scope === 'org' ? null : userId);

export const envScopeOf = (scope: SetupScope, userId: string): EnvSecretScope =>
    scope === 'org' ? { kind: 'org' } : { kind: 'workspace', userId };

/** The names one scope holds; a failed read throws. */
export async function scopeNames(envVars: EnvVarStore, scope: SetupScope, userId: string): Promise<string[]> {
    const rows = scope === 'org' ? await envVars.listOrg() : await envVars.listWorkspace(userId);
    return rows.map((row) => row.name);
}

/** The key provider a scope holds: the one its agent default recorded, else the one its names point to. */
export function scopeProvider(recorded: AgentProvider | undefined, names: readonly string[]): ModelProvider | null {
    return isModelProvider(recorded) ? recorded : inferProvider(names);
}

const KEY_NAMES = new Set(Object.values(PROVIDER_ENV));

/** The provider key names among a scope's names, sorted: names only, never a value. */
export const keyNamesOf = (names: readonly string[]): string[] => names.filter((name) => KEY_NAMES.has(name)).sort();

/**
 * The key provider the member's view of `scope` runs on, for a save of the agent default alone: the personal scope
 * sees its own key first, then the organization's; the org scope only its own. Null when no key is in view. A failed
 * read throws: it never reads as "no key".
 */
export async function providerInView(
    stores: Pick<ModelSetupStores, 'envVars' | 'executors'>,
    scope: SetupScope,
    userId: string
): Promise<ModelProvider | null> {
    const defaults = await stores.executors.agentDefaults(userId);
    const keyed = (recorded: AgentProvider | undefined, names: string[]) =>
        keyNamesOf(names).length > 0 ? scopeProvider(recorded, names) : null;
    if (scope === 'personal') {
        const own = keyed(defaults.personal?.provider, await scopeNames(stores.envVars, 'personal', userId));
        if (own !== null) return own;
    }
    return keyed(defaults.org?.provider, await scopeNames(stores.envVars, 'org', userId));
}

/**
 * Writes the key, its base URL (removed when none is given) and the agent default in one transaction under the scope
 * lock. The names removed are the previous provider's — the recorded one, else the one the scope's names point to.
 * Both are confirmed under the lock (the recorded provider re-read, the scope's provider names compared): when a
 * concurrent write moved either, this save rolls back and runs again on what that write left. A refusal from the
 * scope's rules throws `EnvScopeRefusal`; any throw leaves neither side written and a secret the write created
 * released once (env-var-store.ts).
 */
export async function saveModelKey(stores: ModelSetupStores, input: KeySave): Promise<void> {
    const { envVars, executors, deploymentMode } = stores;
    const owner = ownerOf(input.scope, input.userId);
    const upsert = [{ name: PROVIDER_ENV[input.provider], value: input.key, isSecret: true }];
    const baseName = PROVIDER_BASE_URL_ENV[input.provider];
    if (input.baseUrl !== undefined && baseName !== null) {
        upsert.push({ name: baseName, value: input.baseUrl, isSecret: false });
    }
    const written = new Set(upsert.map((entry) => entry.name));
    const value = {
        agentType: input.agentType,
        model: normalizeModelId(input.provider, input.agentType, input.model),
        provider: input.provider,
    };

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const defaults = await executors.agentDefaults(input.userId);
        const recorded = (input.scope === 'org' ? defaults.org : defaults.personal)?.provider;
        const names = new Set(await scopeNames(envVars, input.scope, input.userId));
        const previous = scopeProvider(recorded, [...names]);
        const touched = new Set([...providerEnvNames(input.provider), ...(previous ? providerEnvNames(previous) : [])]);
        const remove = [...touched].filter((name) => !written.has(name));
        try {
            await envVars.writeScoped(envScopeOf(input.scope, input.userId), { upsert, remove }, input.userId, {
                // The list read under the lock: a provider name this save did not see means the scope moved.
                validate: (resulting) => {
                    const unseen = (name: string) => PROVIDER_NAMES.has(name) && !names.has(name) && !written.has(name);
                    if (resulting.some((entry) => unseen(entry.name))) {
                        throw new ProviderMoved();
                    }
                    return validateScopeList(resulting, deploymentMode);
                },
                alsoInTx: async (tx) => {
                    const locked = await executors.agentDefaultInTx(tx, owner);
                    if (locked?.provider !== recorded) throw new ProviderMoved();
                    await executors.setAgentDefaultInTx(tx, owner, value);
                },
            });
            return;
        } catch (error) {
            if (!(error instanceof ProviderMoved)) throw error;
        }
    }
    throw new ModelSetupConflict();
}
