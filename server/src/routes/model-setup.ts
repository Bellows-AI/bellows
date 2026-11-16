import {
    ADMIN_ROLE,
    type AgentProvider,
    CLOUD_CREDENTIAL_MESSAGE,
    ERROR_CODES,
    EXECUTOR_TYPES,
    type ExecutorType,
    isModelProvider,
    type ModelProvider,
    normalizeModelId,
    PLATFORM_PROVIDER,
    PROVIDER_AGENTS,
    providerAvailable,
} from '@factory-ai/core';
import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { AppConfig } from '../config.js';
import { EnvScopeRefusal, type EnvVarStore } from '../db/env-var-store.js';
import type { AgentDefault, UserExecutorStore } from '../db/user-executor-store.js';
import type { OrgRegistry } from '../orgs.js';
import { MAX_AGENT_MODEL_LENGTH } from './agent-default.js';
import { varsCode } from './env.js';
import { errorHandler } from './error-handler.js';
import { bad, guard, body as jsonBody } from './helpers.js';
import {
    keyNamesOf,
    ModelSetupConflict,
    ownerOf,
    providerInView,
    saveModelKey,
    scopeProvider,
    type SetupScope,
} from './model-setup-save.js';
import { validBase, validKey } from './model-setup-verify.js';

/**
 * `GET` / `PUT /api/model-setup` (docs/api.md): what model a member's tasks run on, and saving a provider key with the
 * agent default in one call. Names only: no answer carries a secret value, and a body carrying a key is never echoed.
 */

const PATH = '/api/model-setup';
const BODY_LIMIT = 8192;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;
/** The agent-only save on a key the scope's view already holds, when the deployment supplies no model. */
const EXISTING = 'existing';
const FIELDS = new Set(['scope', 'provider', 'key', 'baseUrl', 'agentType', 'model']);
const HTTP_FIRST_SERVER_ERROR = 500;

/** A body the parser refused (malformed, too large) answers fixed text: the parser's message may quote the key. */
const refuseUnparsed = (error: FastifyError, request: FastifyRequest, reply: FastifyReply) =>
    error.statusCode !== undefined && error.statusCode < HTTP_FIRST_SERVER_ERROR
        ? bad(reply, ERROR_CODES.BAD_BODY, 'The model setup body could not be read', error.statusCode)
        : errorHandler(error, request, reply);

interface Common {
    readonly scope: SetupScope;
    readonly agentType: ExecutorType;
    readonly model: string;
}
type Parsed =
    | (Common & { readonly provider: ModelProvider; readonly key: string; readonly baseUrl?: string })
    | (Common & { readonly provider: typeof PLATFORM_PROVIDER | typeof EXISTING });
type Refusal = { readonly error: string; readonly code: string };

const refusal = (error: string, code: string = ERROR_CODES.BAD_BODY): Refusal => ({ error, code });

function parseCommon(fields: Record<string, unknown>): Common | Refusal {
    const { scope, agentType } = fields;
    if (scope !== 'org' && scope !== 'personal') return refusal('scope must be org or personal');
    if (!(EXECUTOR_TYPES as readonly unknown[]).includes(agentType)) {
        return refusal(`agentType must be one of ${EXECUTOR_TYPES.join(', ')}`, ERROR_CODES.BAD_EXECUTOR_TYPE);
    }
    const model = typeof fields.model === 'string' ? fields.model.trim() : '';
    if (!model || model.length > MAX_AGENT_MODEL_LENGTH) {
        return refusal(`model must be a name of 1 to ${MAX_AGENT_MODEL_LENGTH} characters`);
    }
    return { scope, agentType: agentType as ExecutorType, model };
}

/** A key provider's body: an agent it runs, a header-safe key, a base URL where one fits (LiteLLM needs one). */
function parseKeyed(common: Common, provider: ModelProvider, fields: Record<string, unknown>, config: AppConfig) {
    if (!providerAvailable(provider, config.deploymentMode)) {
        return refusal(CLOUD_CREDENTIAL_MESSAGE, ERROR_CODES.CLOUD_CREDENTIAL_REFUSED);
    }
    if (!PROVIDER_AGENTS[provider].includes(common.agentType)) {
        return refusal(
            `${provider} runs ${PROVIDER_AGENTS[provider].join(' or ')}, not ${common.agentType}`,
            ERROR_CODES.BAD_EXECUTOR_TYPE
        );
    }
    if (!validKey(fields.key)) return refusal('key must be a provider key: printable characters, no spaces');
    const { baseUrl } = fields;
    if (baseUrl === undefined) {
        return provider === 'litellm' ? refusal('LiteLLM needs a baseUrl') : { ...common, provider, key: fields.key };
    }
    if (provider === 'subscription' || typeof baseUrl !== 'string' || !validBase(baseUrl)) {
        return refusal('baseUrl must be an http(s) URL without credentials, and a subscription takes none');
    }
    return { ...common, provider, key: fields.key, baseUrl };
}

/** The body, or the refusal: only the agent-only variant this deployment offers is accepted. */
function parseSave(raw: unknown, config: AppConfig): Parsed | Refusal {
    const fields = jsonBody(raw);
    const extra = Object.keys(fields).find((name) => !FIELDS.has(name));
    if (extra !== undefined) return refusal(`unknown field ${extra}`);
    const common = parseCommon(fields);
    if ('error' in common) return common;
    const { provider } = fields;
    if (isModelProvider(provider)) return parseKeyed(common, provider, fields, config);
    const agentOnly = config.platformModelProvided ? PLATFORM_PROVIDER : EXISTING;
    if (provider !== agentOnly) {
        return refusal(`provider must be one of the key providers or ${agentOnly}`);
    }
    if (fields.key !== undefined || fields.baseUrl !== undefined) {
        return refusal(`provider ${agentOnly} saves the agent default alone: no key, no baseUrl`);
    }
    return { ...common, provider: agentOnly };
}

interface ScopeView {
    provider: AgentProvider | null;
    agentType: ExecutorType | null;
    model: string | null;
    keyNames: string[];
}

/** One scope's setup: its recorded or inferred provider, its agent default, its key names; null when it has none. */
function viewOf(names: string[], agent: AgentDefault | null): ScopeView | null {
    const keyNames = keyNamesOf(names);
    if (agent === null && keyNames.length === 0) return null;
    return {
        provider: agent?.provider === PLATFORM_PROVIDER ? PLATFORM_PROVIDER : scopeProvider(agent?.provider, names),
        agentType: agent?.agentType ?? null,
        model: agent?.model ?? null,
        keyNames,
    };
}

/** Which source a task naming no executor runs on: a key in the member's scope, then the org's, then the platform. */
function effectiveOf(personal: ScopeView | null, org: ScopeView | null, platform: boolean) {
    if (personal?.keyNames.length) return 'personal';
    if (org?.keyNames.length) return 'org';
    return platform ? 'platform' : null;
}

interface Context {
    readonly userId: string;
    readonly admin: boolean;
    readonly envVars: EnvVarStore | undefined;
    readonly executors: UserExecutorStore;
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
            Promise.all([envVars.listOrg(), envVars.listWorkspace(ctx.userId), ctx.executors.agentDefaults(ctx.userId)])
    );
    if (!read.ok) return reply;
    const [orgRows, personalRows, defaults] = read.value;
    const org = viewOf(
        orgRows.map((row) => row.name),
        defaults.org
    );
    const personal = viewOf(
        personalRows.map((row) => row.name),
        defaults.personal
    );
    const platform = config.platformModelProvided;
    return reply.code(HTTP_OK).send({ platform, org, personal, effective: effectiveOf(personal, org, platform) });
}

/** The agent default alone: on the platform model, or on a key the scope's view holds (re-read here, never trusted). */
async function saveAgentOnly(ctx: Context, parsed: Parsed): Promise<Refusal | null> {
    const owner = ownerOf(parsed.scope, ctx.userId);
    if (parsed.provider === PLATFORM_PROVIDER) {
        await ctx.executors.setAgentDefault(owner, { ...parsed, provider: PLATFORM_PROVIDER });
        return null;
    }
    if (!ctx.envVars) throw new Error('no env store');
    const provider = await providerInView({ envVars: ctx.envVars, executors: ctx.executors }, parsed.scope, ctx.userId);
    if (provider === null) return refusal('no provider key is configured in this scope yet');
    if (!PROVIDER_AGENTS[provider].includes(parsed.agentType)) {
        return refusal(
            `the configured ${provider} key does not run ${parsed.agentType}`,
            ERROR_CODES.BAD_EXECUTOR_TYPE
        );
    }
    const model = normalizeModelId(provider, parsed.agentType, parsed.model);
    await ctx.executors.setAgentDefault(owner, { agentType: parsed.agentType, model });
    return null;
}

async function save(ctx: Context, config: AppConfig, parsed: Parsed): Promise<Refusal | null> {
    if (!isModelProvider(parsed.provider)) return saveAgentOnly(ctx, parsed);
    if (!ctx.envVars || !('key' in parsed)) throw new Error('no env store');
    const stores = { envVars: ctx.envVars, executors: ctx.executors, deploymentMode: config.deploymentMode };
    try {
        await saveModelKey(stores, { ...parsed, provider: parsed.provider, userId: ctx.userId });
    } catch (error) {
        if (error instanceof EnvScopeRefusal) return refusal(error.reason, varsCode(error.reason));
        if (error instanceof ModelSetupConflict) return refusal(error.message, ERROR_CODES.MODEL_SETUP_CONFLICT);
        throw error;
    }
    return null;
}

async function handlePut(config: AppConfig, orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    const parsed = parseSave(request.body, config);
    if ('error' in parsed) return bad(reply, parsed.code, parsed.error);
    // The scope is in the body, so the route class admits any member and the org scope's admin check is here.
    if (parsed.scope === 'org' && !ctx.admin) {
        return bad(reply, ERROR_CODES.FORBIDDEN, 'Only an admin sets up the organization model', HTTP_FORBIDDEN);
    }
    if (parsed.provider !== PLATFORM_PROVIDER && !ctx.envVars) return noEnvStore(reply);
    const saved = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'model setup save failed'),
        () => save(ctx, config, parsed)
    );
    if (!saved.ok) return reply;
    if (saved.value !== null) {
        const status = saved.value.code === ERROR_CODES.MODEL_SETUP_CONFLICT ? HTTP_CONFLICT : undefined;
        return bad(reply, saved.value.code, saved.value.error, status);
    }
    return reply.code(HTTP_OK).send({ saved: true });
}

export const modelSetupRoutes =
    ({ config, orgs }: { config: AppConfig; orgs: OrgRegistry }): FastifyPluginAsync =>
    async (app) => {
        app.get(PATH, (request, reply) => handleGet(config, orgs, request, reply));
        app.put(PATH, { bodyLimit: BODY_LIMIT, errorHandler: refuseUnparsed }, (request, reply) =>
            handlePut(config, orgs, request, reply)
        );
    };
