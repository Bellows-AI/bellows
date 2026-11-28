import {
    ADMIN_ROLE,
    CLOUD_CREDENTIAL_MESSAGE,
    ERROR_CODES,
    EXECUTOR_TYPES,
    type ExecutorType,
    isModelProvider,
    type ModelProvider,
    PROVIDER_AGENTS,
    providerAvailable,
    subscriptionTokenAllowed,
} from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { AppConfig } from '../config.js';
import {
    ProviderSetupCapError,
    ProviderSetupConflict,
    ProviderSetupEndpointRefusal,
    ProviderSetupNameConflict,
    ProviderSetupRequestConflict,
    type ConnectionIntent,
    type SetupCommand,
    type SetupResult,
} from '../db/provider-setup-store.js';
import { ProviderConnectionCapError } from '../db/provider-connection-store.js';
import type { OrgRegistry } from '../orgs.js';
import { MAX_AGENT_MODEL_LENGTH } from './agent-default.js';
import { HTTP_CONNECTION_REFUSED, isConnectionRefusal, lifecycleRefusal, UUID } from './executor-fields.js';
import { bad, body as jsonBody, guard } from './helpers.js';
import { refuseUnparsedBody, validBase, validKey } from './provider-connections-verify.js';
import { badConnectionName } from './provider-connections.js';

/**
 * `POST /api/provider-connections/setup` (docs/api.md): the provider setup command. The intent about the connection —
 * create, reuse or rotate — and the executor that runs on it (its own name, agent and model), published with the
 * default selection in one transaction (db/provider-setup-store.ts). Names only: no answer carries a secret value, and
 * a body carrying a key is never echoed.
 */

export type SetupScope = 'org' | 'personal';

export type Refusal = { readonly error: string; readonly code: string };
export const refusal = (error: string, code: string = ERROR_CODES.BAD_BODY): Refusal => ({ error, code });

/** The bound on a request id: a client-generated identifier, never a secret. */
const REQUEST_ID_MAX = 128;
const FIELDS = new Set(['scope', 'requestId', 'connection', 'executor', 'makeDefault']);
const EXECUTOR_FIELDS = new Set(['id', 'name', 'agentType', 'model', 'expectedUpdatedAt']);

/** A parsed body: the command as the route can state it, before the caller is added. */
export interface ParsedSetup {
    readonly scope: SetupScope;
    readonly requestId: string;
    readonly connection: ConnectionIntent;
    readonly executor: SetupCommand['executor'];
    readonly makeDefault?: boolean;
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

function parseExecutor(raw: unknown): SetupCommand['executor'] | Refusal {
    const fields = jsonBody(raw);
    const extra = Object.keys(fields).find((name) => !EXECUTOR_FIELDS.has(name));
    if (extra !== undefined) return refusal(`unknown executor field ${extra}`);
    const { id, name, agentType, expectedUpdatedAt } = fields;
    if (!(EXECUTOR_TYPES as readonly unknown[]).includes(agentType)) {
        return refusal(`executor.agentType must be one of ${EXECUTOR_TYPES.join(', ')}`, ERROR_CODES.BAD_EXECUTOR_TYPE);
    }
    const model = typeof fields.model === 'string' ? fields.model.trim() : '';
    if (!model || model.length > MAX_AGENT_MODEL_LENGTH) {
        return refusal(`executor.model must be a name of 1 to ${MAX_AGENT_MODEL_LENGTH} characters`);
    }
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
        agentType: agentType as ExecutorType,
        model,
        ...(id === undefined ? {} : { id: id as string }),
        ...(name === undefined ? {} : { name: name as string }),
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: expectedUpdatedAt as string }),
    };
}

/**
 * The body, or the refusal; every field named, a request id the retry can repeat, and a subscription only where the
 * caller's org may hold one (`subscriptionAllowed`). The connection's provider must run the executor's agent.
 */
export function parseSetup(raw: unknown, subscriptionAllowed: boolean): ParsedSetup | Refusal {
    const fields = jsonBody(raw);
    const extra = Object.keys(fields).find((name) => !FIELDS.has(name));
    if (extra !== undefined) return refusal(`unknown field ${extra}`);
    const { scope, requestId, makeDefault } = fields;
    if (scope !== 'org' && scope !== 'personal') return refusal('scope must be org or personal');
    if (!text(requestId) || requestId.length > REQUEST_ID_MAX) {
        return refusal(`requestId must be a string of 1 to ${REQUEST_ID_MAX} characters`);
    }
    if (makeDefault !== undefined && typeof makeDefault !== 'boolean') return refusal('makeDefault must be a boolean');
    const executor = parseExecutor(fields.executor);
    if ('error' in executor) return executor;
    const connection = parseConnection(fields.connection, executor.agentType, subscriptionAllowed);
    if ('error' in connection) return connection;
    return { scope, requestId, connection, executor, ...(makeDefault === undefined ? {} : { makeDefault }) };
}

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;
const PATH = '/api/provider-connections/setup';
const BODY_LIMIT = 8192;

/** The answer a save sends: the stable identities the client carries into its next save, no credential. */
const savedView = (result: SetupResult) => ({
    saved: true,
    scope: result.scope,
    executorId: result.executorId,
    executorName: result.executorName,
    connectionId: result.connectionId,
    connectionName: result.connectionName,
    replayed: result.replayed,
});

type Refused = { status: number; error: string; code: string };

/** What a refused setup answers: the closed set of domain refusals the store raises; any other error is an outage. */
function refusedSetup(error: unknown): Refused | null {
    if (error instanceof ProviderSetupNameConflict) {
        return { status: HTTP_CONFLICT, error: error.message, code: ERROR_CODES.NAME_TAKEN };
    }
    if (error instanceof ProviderSetupEndpointRefusal) {
        return { status: 400, error: error.message, code: ERROR_CODES.BAD_BODY };
    }
    if (error instanceof ProviderSetupConflict || error instanceof ProviderSetupRequestConflict) {
        return { status: HTTP_CONFLICT, error: error.message, code: ERROR_CODES.PROVIDER_SETUP_CONFLICT };
    }
    if (error instanceof ProviderSetupCapError) {
        return { status: 400, error: error.message, code: ERROR_CODES.TOO_MANY_EXECUTORS };
    }
    if (isConnectionRefusal(error)) {
        return { status: HTTP_CONNECTION_REFUSED, error: error.message, code: ERROR_CODES.PROVIDER_CONNECTION_REFUSED };
    }
    if (error instanceof ProviderConnectionCapError) {
        return { status: 400, error: error.message, code: ERROR_CODES.TOO_MANY_CONNECTIONS };
    }
    const lifecycle = lifecycleRefusal(error);
    return lifecycle ? { status: lifecycle.status, error: lifecycle.message, code: lifecycle.code } : null;
}

async function handleSetup(
    deps: { config: Pick<AppConfig, 'deploymentMode' | 'cloudSubscriptionOrgIds'>; orgs: OrgRegistry },
    request: FastifyRequest,
    reply: FastifyReply
) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    const parsed = parseSetup(request.body, subscriptionTokenAllowed(deps.config, orgOf(request)));
    if ('error' in parsed) return bad(reply, parsed.code, parsed.error);
    // The scope is in the body, so the route class admits any member and the org scope's admin check is here.
    if (parsed.scope === 'org' && caller.role !== ADMIN_ROLE) {
        return bad(reply, ERROR_CODES.FORBIDDEN, 'Only an admin sets up the organization provider', HTTP_FORBIDDEN);
    }
    const store = (await deps.orgs.for(orgOf(request)))?.providerSetup;
    if (!store) {
        return bad(
            reply,
            ERROR_CODES.PROVIDER_CONNECTIONS_UNAVAILABLE,
            'No provider setup store for this organization',
            HTTP_UNAVAILABLE
        );
    }
    const command: SetupCommand = {
        scope: parsed.scope,
        userId: caller.user.id,
        requestId: parsed.requestId,
        connection: parsed.connection,
        executor: parsed.executor,
        ...(parsed.makeDefault === undefined ? {} : { makeDefault: parsed.makeDefault }),
    };
    const saved = await guard(
        reply,
        (e) => (refusedSetup(e) ? undefined : request.log.error({ err: e }, 'provider setup failed')),
        async (): Promise<{ result: SetupResult } | { refused: Refused }> => {
            try {
                return { result: await store.apply(command) };
            } catch (error) {
                const refused = refusedSetup(error);
                if (refused) return { refused };
                throw error;
            }
        }
    );
    if (!saved.ok) return reply;
    if ('refused' in saved.value) {
        const { status, code, error } = saved.value.refused;
        return bad(reply, code, error, status);
    }
    return reply.code(HTTP_OK).send(savedView(saved.value.result));
}

const refuseUnparsed = refuseUnparsedBody('The provider setup body could not be read');

/** `POST /api/provider-connections/setup`, registered by the provider connection routes. */
export const providerSetupRoutes =
    (deps: {
        config: Pick<AppConfig, 'deploymentMode' | 'cloudSubscriptionOrgIds'>;
        orgs: OrgRegistry;
    }): FastifyPluginAsync =>
    async (app) => {
        app.post(PATH, { bodyLimit: BODY_LIMIT, errorHandler: refuseUnparsed }, (request, reply) =>
            handleSetup(deps, request, reply)
        );
    };
