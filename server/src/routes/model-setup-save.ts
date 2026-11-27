import {
    type AgentProvider,
    CLOUD_CREDENTIAL_MESSAGE,
    currentProvider,
    ERROR_CODES,
    EXECUTOR_TYPES,
    type ExecutorType,
    isModelProvider,
    type ModelProvider,
    PLATFORM_PROVIDER,
    PROVIDER_AGENTS,
    PROVIDER_ENV,
    providerAvailable,
} from '@factory-ai/core';
import type { ConnectionIntent, SetupCommand } from '../db/model-setup-store.js';
import type { EnvVarStore } from '../db/env-var-store.js';
import type { UserExecutorStore } from '../db/user-executor-store.js';
import type { AppConfig } from '../config.js';
import { MAX_AGENT_MODEL_LENGTH } from './agent-default.js';
import { body as jsonBody } from './helpers.js';
import { validBase, validKey } from './model-setup-verify.js';
import { badConnectionName } from './provider-connections.js';

/**
 * The model setup's command body (`PUT /api/model-setup`, docs/api.md): the intent about the connection — create, reuse,
 * rotate or none — and the executor it runs, parsed into the store's `SetupCommand` (db/model-setup-store.ts). The HTTP
 * shape and the refusals are routes/model-setup.ts'.
 */

export type SetupScope = 'org' | 'personal';

export type Refusal = { readonly error: string; readonly code: string };
export const refusal = (error: string, code: string = ERROR_CODES.BAD_BODY): Refusal => ({ error, code });

/** The bound on a request id: a client-generated identifier, never a secret. */
const REQUEST_ID_MAX = 128;
const FIELDS = new Set(['scope', 'requestId', 'agentType', 'model', 'connection', 'executor']);
const EXECUTOR_FIELDS = new Set(['id', 'name', 'expectedUpdatedAt']);

export const ownerOf = (scope: SetupScope, userId: string): string | null => (scope === 'org' ? null : userId);

/** A parsed body: the command as the route can state it, before the `none` intent's provider is looked up. */
export interface ParsedSetup {
    readonly scope: SetupScope;
    readonly requestId: string;
    readonly connection: ConnectionIntent;
    readonly executor: SetupCommand['executor'];
}

/** A header-safe key and the base URL rules a provider has: LiteLLM needs one, a subscription takes none. */
function endpointRefusal(provider: ModelProvider, baseUrl: unknown): Refusal | null {
    if (baseUrl === undefined || baseUrl === null) {
        return provider === 'litellm' && baseUrl === undefined ? refusal('LiteLLM needs a baseUrl') : null;
    }
    if (provider === 'subscription' || typeof baseUrl !== 'string' || !validBase(baseUrl)) {
        return refusal('baseUrl must be an http(s) URL without credentials, and a subscription takes none');
    }
    return null;
}

const text = (value: unknown): value is string => typeof value === 'string' && value !== '';

function parseConnection(raw: unknown, agentType: ExecutorType, config: AppConfig): ConnectionIntent | Refusal {
    const fields = jsonBody(raw);
    const { intent } = fields;
    if (intent === 'none') {
        if (Object.keys(fields).length > 1) return refusal('intent none takes no other connection field');
        return { intent };
    }
    if (intent === 'reuse') {
        if (!text(fields.id) || Object.keys(fields).length > 2) return refusal('intent reuse takes an id alone');
        return { intent, id: fields.id };
    }
    if (intent === 'rotate') {
        if (!text(fields.id)) return refusal('intent rotate needs the connection id');
        const extra = Object.keys(fields).find((name) => !['intent', 'id', 'key', 'baseUrl'].includes(name));
        if (extra !== undefined) return refusal(`unknown connection field ${extra}`);
        if (!validKey(fields.key)) return refusal('key must be a provider key: printable characters, no spaces');
        if (fields.baseUrl !== undefined) {
            if (typeof fields.baseUrl !== 'string' || !validBase(fields.baseUrl)) {
                return refusal('baseUrl must be an http(s) URL without credentials');
            }
            return { intent, id: fields.id, key: fields.key, baseUrl: fields.baseUrl };
        }
        return { intent, id: fields.id, key: fields.key };
    }
    if (intent !== 'create') return refusal('connection.intent must be create, reuse, rotate or none');
    const extra = Object.keys(fields).find((name) => !['intent', 'provider', 'key', 'baseUrl', 'name'].includes(name));
    if (extra !== undefined) return refusal(`unknown connection field ${extra}`);
    const { provider, key, name, baseUrl } = fields;
    if (!isModelProvider(provider)) return refusal('connection.provider must be one of the model providers');
    if (!providerAvailable(provider, config.deploymentMode)) {
        return refusal(CLOUD_CREDENTIAL_MESSAGE, ERROR_CODES.CLOUD_CREDENTIAL_REFUSED);
    }
    if (!PROVIDER_AGENTS[provider].includes(agentType)) {
        return refusal(
            `${provider} runs ${PROVIDER_AGENTS[provider].join(' or ')}, not ${agentType}`,
            ERROR_CODES.BAD_EXECUTOR_TYPE
        );
    }
    if (!validKey(key)) return refusal('key must be a provider key: printable characters, no spaces');
    const nameReason = badConnectionName(name);
    if (nameReason) return refusal(nameReason, ERROR_CODES.BAD_NAME);
    const endpoint = endpointRefusal(provider, baseUrl);
    if (endpoint) return endpoint;
    return { intent, provider, key, name: name as string, baseUrl: typeof baseUrl === 'string' ? baseUrl : null };
}

function parseExecutor(raw: unknown, common: { agentType: ExecutorType; model: string }): SetupCommand['executor'] | Refusal {
    const fields = jsonBody(raw ?? {});
    const extra = Object.keys(fields).find((name) => !EXECUTOR_FIELDS.has(name));
    if (extra !== undefined) return refusal(`unknown executor field ${extra}`);
    const { id, name, expectedUpdatedAt } = fields;
    if (id !== undefined && !text(id)) return refusal('executor.id must be the executor id');
    if (name !== undefined || id === undefined) {
        const reason = badConnectionName(name);
        if (reason) return refusal(reason.replace(/^name/, 'executor.name'), ERROR_CODES.BAD_NAME);
    }
    if (expectedUpdatedAt !== undefined && (typeof expectedUpdatedAt !== 'string' || Number.isNaN(Date.parse(expectedUpdatedAt)))) {
        return refusal('executor.expectedUpdatedAt must be the updatedAt the executor was read with');
    }
    return {
        ...common,
        ...(id === undefined ? {} : { id: id as string }),
        ...(name === undefined ? {} : { name: name as string }),
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: expectedUpdatedAt as string }),
    };
}

/** The body, or the refusal; every field named, a request id the retry can repeat, no key beside an intent that holds none. */
export function parseSetup(raw: unknown, config: AppConfig): ParsedSetup | Refusal {
    const fields = jsonBody(raw);
    const extra = Object.keys(fields).find((name) => !FIELDS.has(name));
    if (extra !== undefined) return refusal(`unknown field ${extra}`);
    const { scope, requestId, agentType } = fields;
    if (scope !== 'org' && scope !== 'personal') return refusal('scope must be org or personal');
    if (!text(requestId) || requestId.length > REQUEST_ID_MAX) {
        return refusal(`requestId must be a string of 1 to ${REQUEST_ID_MAX} characters`);
    }
    if (!(EXECUTOR_TYPES as readonly unknown[]).includes(agentType)) {
        return refusal(`agentType must be one of ${EXECUTOR_TYPES.join(', ')}`, ERROR_CODES.BAD_EXECUTOR_TYPE);
    }
    const model = typeof fields.model === 'string' ? fields.model.trim() : '';
    if (!model || model.length > MAX_AGENT_MODEL_LENGTH) {
        return refusal(`model must be a name of 1 to ${MAX_AGENT_MODEL_LENGTH} characters`);
    }
    const type = agentType as ExecutorType;
    const connection = parseConnection(fields.connection, type, config);
    if ('error' in connection) return connection;
    const executor = parseExecutor(fields.executor, { agentType: type, model });
    if ('error' in executor) return executor;
    return { scope, requestId, connection, executor };
}

const KEY_NAMES = new Set(Object.values(PROVIDER_ENV));

/** The provider key names among a scope's names, sorted: names only, never a value. */
export const keyNamesOf = (names: readonly string[]): string[] => names.filter((name) => KEY_NAMES.has(name)).sort();

/** The names one scope holds; a failed read throws. */
async function scopeNames(envVars: EnvVarStore, scope: SetupScope, userId: string): Promise<string[]> {
    const rows = scope === 'org' ? await envVars.listOrg() : await envVars.listWorkspace(userId);
    return rows.map((row) => row.name);
}

/**
 * The key provider the member's view of `scope` runs on, for an executor that adopts the credentials already in the
 * environment (intent `none`): the personal scope sees its own key first, then the organization's; the org scope only its
 * own. Null when no key is in view. A failed read throws: it never reads as "no key".
 */
async function providerInView(
    stores: { envVars: EnvVarStore; executors: Pick<UserExecutorStore, 'agentDefaults'> },
    scope: SetupScope,
    userId: string
): Promise<ModelProvider | null> {
    const defaults = await stores.executors.agentDefaults(userId);
    if (scope === 'personal') {
        const own = currentProvider(await scopeNames(stores.envVars, 'personal', userId), defaults.personal?.provider);
        if (own !== null) return own;
    }
    return currentProvider(await scopeNames(stores.envVars, 'org', userId), defaults.org?.provider);
}

/**
 * The command the store runs. The `none` intent decides its provider here: the deployment's platform model when it
 * supplies one, else the key already in the scope's view — which must run the agent. Anything else is a refusal.
 */
export async function commandOf(
    parsed: ParsedSetup,
    ctx: {
        userId: string;
        config: AppConfig;
        envVars: EnvVarStore | undefined;
        executors: Pick<UserExecutorStore, 'agentDefaults'>;
    }
): Promise<SetupCommand | Refusal> {
    const base = { scope: parsed.scope, userId: ctx.userId, requestId: parsed.requestId, executor: parsed.executor };
    if (parsed.connection.intent !== 'none') return { ...base, connection: parsed.connection };
    let source: AgentProvider = PLATFORM_PROVIDER;
    if (!ctx.config.platformModelProvided) {
        if (!ctx.envVars) throw new Error('no env store');
        const provider = await providerInView(
            { envVars: ctx.envVars, executors: ctx.executors },
            parsed.scope,
            ctx.userId
        );
        if (provider === null) return refusal('no provider key is configured in this scope yet');
        if (!PROVIDER_AGENTS[provider].includes(parsed.executor.agentType)) {
            return refusal(
                `the configured ${provider} key does not run ${parsed.executor.agentType}`,
                ERROR_CODES.BAD_EXECUTOR_TYPE
            );
        }
        source = provider;
    }
    return { ...base, connection: { intent: 'none', source } };
}
