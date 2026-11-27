import {
    ADMIN_ROLE,
    type AgentProvider,
    currentProvider,
    ERROR_CODES,
    type ExecutorType,
    isModelProvider,
    PLATFORM_PROVIDER,
    PROVIDER_BASE_URL_ENV,
    subscriptionTokenAllowed,
} from '@factory-ai/core';
import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { AppConfig } from '../config.js';
import type { EnvVarEntry, EnvVarStore } from '../db/env-var-store.js';
import {
    ModelSetupCapError,
    ModelSetupConflict,
    ModelSetupEndpointRefusal,
    type ModelSetupStore,
    ModelSetupNameConflict,
    ModelSetupRequestConflict,
    type SelectedSetup,
    type SetupResult,
} from '../db/model-setup-store.js';
import { ProviderConnectionCapError } from '../db/provider-connection-store.js';
import type { AgentDefault, UserExecutorStore } from '../db/user-executor-store.js';
import type { OrgRegistry } from '../orgs.js';
import { errorHandler } from './error-handler.js';
import { HTTP_CONNECTION_REFUSED, isConnectionRefusal, lifecycleRefusal } from './executor-fields.js';
import { bad, guard } from './helpers.js';
import { commandOf, keyNamesOf, parseSetup } from './model-setup-save.js';

/**
 * `GET` / `PUT /api/model-setup` (docs/api.md): what model a member's tasks run on, and the setup command that creates or
 * selects a provider connection, writes the executor on it and makes it the default in one transaction. Names only: no
 * answer carries a secret value, and a body carrying a key is never echoed.
 */

const PATH = '/api/model-setup';
const BODY_LIMIT = 8192;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;
const HTTP_FIRST_SERVER_ERROR = 500;

/** A body the parser refused (malformed, too large) answers fixed text: the parser's message may quote the key. */
const refuseUnparsed = (error: FastifyError, request: FastifyRequest, reply: FastifyReply) =>
    error.statusCode !== undefined && error.statusCode < HTTP_FIRST_SERVER_ERROR
        ? bad(reply, ERROR_CODES.BAD_BODY, 'The model setup body could not be read', error.statusCode)
        : errorHandler(error, request, reply);

interface ScopeView {
    provider: AgentProvider | null;
    agentType: ExecutorType | null;
    model: string | null;
    keyNames: string[];
    /** The provider's base URL when the scope holds it as a plain variable; never a secret's value. */
    baseUrl?: string;
    /** The scope holds the provider's base URL as a secret: set, value withheld. */
    baseUrlSet?: true;
}

/** The scope's base URL for its provider: the plain value, or only that a secret one is set. */
function baseOf(
    rows: readonly EnvVarEntry[],
    provider: AgentProvider | null
): Pick<ScopeView, 'baseUrl' | 'baseUrlSet'> {
    const name = isModelProvider(provider) ? PROVIDER_BASE_URL_ENV[provider] : null;
    const row = name === null ? undefined : rows.find((entry) => entry.name === name);
    if (!row) return {};
    return !row.isSecret && row.value !== null ? { baseUrl: row.value } : { baseUrlSet: true };
}

/**
 * One scope's setup: the provider its names hold now (`currentProvider`; the platform when it holds none and its
 * agent default runs on it), its agent default, its key names; null when it has none.
 */
function viewOf(rows: readonly EnvVarEntry[], agent: AgentDefault | null): ScopeView | null {
    const names = rows.map((row) => row.name);
    const keyNames = keyNamesOf(names);
    if (agent === null && keyNames.length === 0) return null;
    const platform = agent?.provider === PLATFORM_PROVIDER ? PLATFORM_PROVIDER : null;
    const provider = currentProvider(names, agent?.provider) ?? platform;
    return {
        provider,
        agentType: agent?.agentType ?? null,
        model: agent?.model ?? null,
        keyNames,
        ...baseOf(rows, provider),
    };
}

/**
 * Which source a task naming no executor runs on: the configured default executor, then a key in the member's scope, then
 * the org's, then the platform. A suspended default refuses launches, so it is not effective: the legacy source shows.
 */
function effectiveOf(
    selected: SelectedSetup | null,
    org: ScopeView | null,
    personal: ScopeView | null,
    platform: boolean
) {
    if (selected !== null && !selected.suspended) return 'executor';
    if (personal?.keyNames.length) return 'personal';
    if (org?.keyNames.length) return 'org';
    return platform ? 'platform' : null;
}

/** The default executor as the view shows it: ids and names, the connection's safe metadata, never a credential. */
const selectedView = (selected: SelectedSetup) => ({
    scope: selected.scope,
    executorId: selected.executorId,
    name: selected.executorName,
    agentType: selected.agentType,
    model: selected.model,
    suspended: selected.suspended,
    updatedAt: selected.updatedAt,
    connection: selected.connection,
});

interface Context {
    readonly userId: string;
    readonly admin: boolean;
    readonly envVars: EnvVarStore | undefined;
    readonly executors: UserExecutorStore;
    readonly modelSetup: ModelSetupStore | undefined;
}

async function contextOf(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply): Promise<Context | null> {
    const caller = callerOf(request);
    if (!caller) {
        bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
        return null;
    }
    const rt = await orgs.for(orgOf(request));
    if (!rt?.userExecutors) {
        bad(reply, ERROR_CODES.WORKSPACE_UNAVAILABLE, 'No executor store for this organization', HTTP_UNAVAILABLE);
        return null;
    }
    return {
        userId: caller.user.id,
        admin: caller.role === ADMIN_ROLE,
        envVars: rt.envVars,
        executors: rt.userExecutors,
        modelSetup: rt.modelSetup,
    };
}

const noEnvStore = (reply: FastifyReply) =>
    bad(reply, ERROR_CODES.ENV_UNAVAILABLE, 'No environment store for this organization', HTTP_UNAVAILABLE);

async function handleGet(config: AppConfig, orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    const { envVars } = ctx;
    if (!envVars) return noEnvStore(reply);
    // A failed read is a 503, never "nothing configured": that answer turns on the "No model yet" banner.
    const read = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'model setup read failed'),
        () =>
            Promise.all([
                envVars.listOrg(),
                envVars.listWorkspace(ctx.userId),
                ctx.executors.agentDefaults(ctx.userId),
                ctx.modelSetup?.selectedFor(ctx.userId) ?? null,
            ])
    );
    if (!read.ok) return reply;
    const [orgRows, personalRows, defaults, selected] = read.value;
    const platform = config.platformModelProvided;
    const org = viewOf(orgRows, defaults.org);
    const personal = viewOf(personalRows, defaults.personal);
    return reply.code(HTTP_OK).send({
        platform,
        org,
        personal,
        ...(selected === null ? {} : { selected: selectedView(selected) }),
        effective: effectiveOf(selected, org, personal, platform),
    });
}

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

/** What a refused setup answers: the closed set of domain refusals the store raises; any other error is an outage. */
function refusedSetup(error: unknown): { status: number; error: string; code: string } | null {
    if (error instanceof ModelSetupNameConflict) {
        return { status: HTTP_CONFLICT, error: error.message, code: ERROR_CODES.NAME_TAKEN };
    }
    if (error instanceof ModelSetupEndpointRefusal) {
        return { status: 400, error: error.message, code: ERROR_CODES.BAD_BODY };
    }
    if (error instanceof ModelSetupConflict || error instanceof ModelSetupRequestConflict) {
        return { status: HTTP_CONFLICT, error: error.message, code: ERROR_CODES.MODEL_SETUP_CONFLICT };
    }
    if (error instanceof ModelSetupCapError) {
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

async function handlePut(config: AppConfig, orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    const parsed = parseSetup(request.body, subscriptionTokenAllowed(config, orgOf(request)));
    if ('error' in parsed) return bad(reply, parsed.code, parsed.error);
    // The scope is in the body, so the route class admits any member and the org scope's admin check is here.
    if (parsed.scope === 'org' && !ctx.admin) {
        return bad(reply, ERROR_CODES.FORBIDDEN, 'Only an admin sets up the organization model', HTTP_FORBIDDEN);
    }
    const { modelSetup } = ctx;
    if (!modelSetup) {
        return bad(
            reply,
            ERROR_CODES.WORKSPACE_UNAVAILABLE,
            'No model setup store for this organization',
            HTTP_UNAVAILABLE
        );
    }
    if (parsed.connection.intent === 'none' && !config.platformModelProvided && !ctx.envVars) return noEnvStore(reply);
    const saved = await guard(
        reply,
        (e) => (refusedSetup(e) ? undefined : request.log.error({ err: e }, 'model setup save failed')),
        async (): Promise<{ result: SetupResult } | { refused: { status: number; error: string; code: string } }> => {
            const command = await commandOf(parsed, { ...ctx, userId: ctx.userId, config });
            if ('error' in command) return { refused: { status: 400, ...command } };
            try {
                return { result: await modelSetup.apply(command) };
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

export const modelSetupRoutes =
    ({ config, orgs }: { config: AppConfig; orgs: OrgRegistry }): FastifyPluginAsync =>
    async (app) => {
        app.get(PATH, (request, reply) => handleGet(config, orgs, request, reply));
        app.put(PATH, { bodyLimit: BODY_LIMIT, errorHandler: refuseUnparsed }, (request, reply) =>
            handlePut(config, orgs, request, reply)
        );
    };
