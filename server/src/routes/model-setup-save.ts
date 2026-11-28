import {
    CLOUD_CREDENTIAL_MESSAGE,
    ERROR_CODES,
    EXECUTOR_TYPES,
    type ExecutorType,
    isModelProvider,
    type ModelProvider,
    PROVIDER_AGENTS,
    PROVIDER_ENV,
    providerAvailable,
} from '@factory-ai/core';
import type { ConnectionIntent, SetupCommand } from '../db/model-setup-store.js';
import { MAX_AGENT_MODEL_LENGTH } from './jobs/job-limits.js';
import { body as jsonBody } from './helpers.js';
import { validBase, validKey } from './model-setup-verify.js';
import { UUID } from './executor-fields.js';
import { badConnectionName } from './provider-connections.js';

/**
 * The model setup's command body (`PUT /api/model-setup`, docs/api.md): the intent about the connection — create, reuse,
 * or rotate — and the executor it runs, parsed into the store's `SetupCommand` (db/model-setup-store.ts). The HTTP
 * shape and the refusals are routes/model-setup.ts'.
 */

export type SetupScope = 'org' | 'personal';

export type Refusal = { readonly error: string; readonly code: string };
export const refusal = (error: string, code: string = ERROR_CODES.BAD_BODY): Refusal => ({ error, code });

/** The bound on a request id: a client-generated identifier, never a secret. */
const REQUEST_ID_MAX = 128;
const FIELDS = new Set(['scope', 'requestId', 'agentType', 'model', 'connection', 'executor']);
const EXECUTOR_FIELDS = new Set(['id', 'name', 'expectedUpdatedAt']);

/** A parsed body: the command as the route states it, before the caller's id is added. */
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
const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

const CREATE_FIELDS = ['intent', 'provider', 'key', 'baseUrl', 'name'];
const ROTATE_FIELDS = ['intent', 'id', 'key', 'baseUrl'];

const unknownField = (fields: Record<string, unknown>, allowed: readonly string[]): Refusal | null => {
    const extra = Object.keys(fields).find((name) => !allowed.includes(name));
    return extra === undefined ? null : refusal(`unknown connection field ${extra}`);
};

function parseRotate(fields: Record<string, unknown>): ConnectionIntent | Refusal {
    if (!isId(fields.id)) return refusal('intent rotate needs the connection id');
    const unknown = unknownField(fields, ROTATE_FIELDS);
    if (unknown) return unknown;
    if (!validKey(fields.key)) return refusal('key must be a provider key: printable characters, no spaces');
    if (fields.baseUrl === undefined) return { intent: 'rotate', id: fields.id, key: fields.key };
    if (typeof fields.baseUrl !== 'string' || !validBase(fields.baseUrl)) {
        return refusal('baseUrl must be an http(s) URL without credentials');
    }
    return { intent: 'rotate', id: fields.id, key: fields.key, baseUrl: fields.baseUrl };
}

function parseCreate(
    fields: Record<string, unknown>,
    agentType: ExecutorType,
    subscriptionAllowed: boolean
): ConnectionIntent | Refusal {
    const unknown = unknownField(fields, CREATE_FIELDS);
    if (unknown) return unknown;
    const { provider, key, name, baseUrl } = fields;
    if (!isModelProvider(provider)) return refusal('connection.provider must be one of the model providers');
    if (!providerAvailable(provider, subscriptionAllowed)) {
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
    return {
        intent: 'create',
        provider,
        key,
        name: name as string,
        baseUrl: typeof baseUrl === 'string' ? baseUrl : null,
    };
}

function parseConnection(
    raw: unknown,
    agentType: ExecutorType,
    subscriptionAllowed: boolean
): ConnectionIntent | Refusal {
    const fields = jsonBody(raw);
    const { intent } = fields;
    if (intent === 'reuse') {
        if (!isId(fields.id) || Object.keys(fields).length > 2) return refusal('intent reuse takes an id alone');
        return { intent, id: fields.id };
    }
    if (intent === 'rotate') return parseRotate(fields);
    if (intent !== 'create') return refusal('connection.intent must be create, reuse or rotate');
    return parseCreate(fields, agentType, subscriptionAllowed);
}

function parseExecutor(
    raw: unknown,
    common: { agentType: ExecutorType; model: string }
): SetupCommand['executor'] | Refusal {
    const fields = jsonBody(raw ?? {});
    const extra = Object.keys(fields).find((name) => !EXECUTOR_FIELDS.has(name));
    if (extra !== undefined) return refusal(`unknown executor field ${extra}`);
    const { id, name, expectedUpdatedAt } = fields;
    if (id !== undefined && !isId(id)) return refusal('executor.id must be the executor id');
    if (name !== undefined || id === undefined) {
        const reason = badConnectionName(name);
        if (reason) return refusal(reason.replace(/^name/, 'executor.name'), ERROR_CODES.BAD_NAME);
    }
    if (
        expectedUpdatedAt !== undefined &&
        (typeof expectedUpdatedAt !== 'string' || Number.isNaN(Date.parse(expectedUpdatedAt)))
    ) {
        return refusal('executor.expectedUpdatedAt must be the updatedAt the executor was read with');
    }
    return {
        ...common,
        ...(id === undefined ? {} : { id: id as string }),
        ...(name === undefined ? {} : { name: name as string }),
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: expectedUpdatedAt as string }),
    };
}

/**
 * The body, or the refusal; every field named, a request id the retry can repeat, no key beside an intent that holds
 * none, and a subscription only where the caller's org may hold one (`subscriptionAllowed`).
 */
export function parseSetup(raw: unknown, subscriptionAllowed: boolean): ParsedSetup | Refusal {
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
    const connection = parseConnection(fields.connection, type, subscriptionAllowed);
    if ('error' in connection) return connection;
    const executor = parseExecutor(fields.executor, { agentType: type, model });
    if ('error' in executor) return executor;
    return { scope, requestId, connection, executor };
}

const KEY_NAMES = new Set(Object.values(PROVIDER_ENV));

/** The provider key names among a scope's names, sorted: names only, never a value. */
export const keyNamesOf = (names: readonly string[]): string[] => names.filter((name) => KEY_NAMES.has(name)).sort();
