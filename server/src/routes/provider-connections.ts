import {
    ADMIN_ROLE,
    CLOUD_CREDENTIAL_MESSAGE,
    type DeploymentMode,
    ERROR_CODES,
    isModelProvider,
    type ModelProvider,
    type ProviderConnectionModels,
    type ProviderConnectionScope,
    providerAvailable,
} from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { Caller } from '../auth/store.js';
import { ProviderConnectionCapError, type ProviderConnectionStore } from '../db/provider-connection-store.js';
import { createRateLimiter } from '../oauth/rate-limit.js';
import type { OrgRegistry } from '../orgs.js';
import type { ProviderKeys, VerifyAnswer } from '../provider-keys/verify.js';
import type { AppConfig } from '../config.js';
import { bad, badSegment, body as jsonBody, guard } from './helpers.js';
import { validBase, validKey } from './model-setup-verify.js';

/**
 * Provider connections (docs/api.md): the named model-provider credentials a member brings and an
 * executor profile references. The list answers metadata alone — no answer carries a key or a
 * secret reference; a create or edit validates a key's shape but never contacts the provider
 * (verification is the member's explicit `POST /api/model-setup/verify` step), and discovery reads
 * the SEALED stored key through the real checker, rate-limited.
 */

const PATH = '/api/provider-connections';
const BODY_LIMIT = 8192;
/** No payload past an id needs more than a control route's headroom. */
const CONTROL_BODY_LIMIT = 4096;
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;
const HTTP_TOO_MANY = 429;

const PER_MEMBER_PER_WINDOW = 10;
const WINDOW_MS = 60_000;

const NAME_MAX = 200;
const CREATE_FIELDS = new Set(['scope', 'name', 'provider', 'key', 'baseUrl']);
const EDIT_FIELDS = new Set(['name', 'baseUrl', 'key']);

const refusal = (error: string, code: string = ERROR_CODES.BAD_BODY): { error: string; code: string } => ({
    error,
    code,
});

/** The name rules a connection name follows — the same segment rules an executor name does. */
const badConnectionName = (name: unknown): string | null => {
    if (typeof name !== 'string' || name.length === 0 || name.length > NAME_MAX) {
        return `name must be 1 to ${NAME_MAX} characters`;
    }
    return badSegment('name', name);
};

interface ParsedCreate {
    scope: ProviderConnectionScope;
    name: string;
    provider: ModelProvider;
    key: string;
    baseUrl: string | null;
}

/** The create body, or the refusal: a listed provider this mode offers, a header-safe key, a base URL where one fits. */
function parseCreate(raw: unknown, deploymentMode: DeploymentMode): ParsedCreate | { error: string; code: string } {
    const fields = jsonBody(raw);
    const extra = Object.keys(fields).find((name) => !CREATE_FIELDS.has(name));
    if (extra !== undefined) return refusal(`unknown field ${extra}`);
    const { scope, name, provider, key, baseUrl } = fields;
    if (scope !== 'org' && scope !== 'personal') return refusal('scope must be org or personal');
    const nameReason = badConnectionName(name);
    if (nameReason) return refusal(nameReason, ERROR_CODES.BAD_NAME);
    const connectionName = name as string;
    if (!isModelProvider(provider)) return refusal('provider must be one of the model providers');
    if (!providerAvailable(provider, deploymentMode)) {
        return refusal(CLOUD_CREDENTIAL_MESSAGE, ERROR_CODES.CLOUD_CREDENTIAL_REFUSED);
    }
    if (!validKey(key)) return refusal('key must be a provider key: printable characters, no spaces');
    if (baseUrl === undefined) {
        return provider === 'litellm'
            ? refusal('LiteLLM needs a baseUrl')
            : { scope, name: connectionName, provider, key, baseUrl: null };
    }
    if (provider === 'subscription' || typeof baseUrl !== 'string' || !validBase(baseUrl)) {
        return refusal('baseUrl must be an http(s) URL without credentials, and a subscription takes none');
    }
    return { scope, name: connectionName, provider, key, baseUrl };
}

/** The edit body, or the refusal: metadata and an optional rotation; provider and scope are not fields. */
function parseEdit(
    raw: unknown
): { patch: { name?: string; baseUrl?: string | null; key?: string } } | { error: string; code: string } {
    const fields = jsonBody(raw);
    // Immutability is loud: a body naming either field is refused for exactly that, before the
    // unknown-field scan can reframe it.
    if (fields.provider !== undefined) return refusal('provider is immutable; create another connection');
    if (fields.scope !== undefined) {
        return refusal('scope changes are not supported; create another connection', ERROR_CODES.BAD_SCOPE);
    }
    const extra = Object.keys(fields).find((name) => !EDIT_FIELDS.has(name));
    if (extra !== undefined) return refusal(`unknown field ${extra}`);
    const patch: { name?: string; baseUrl?: string | null; key?: string } = {};
    if (fields.name !== undefined) {
        const nameReason = badConnectionName(fields.name);
        if (nameReason) return refusal(nameReason, ERROR_CODES.BAD_NAME);
        patch.name = fields.name as string;
    }
    if (fields.baseUrl !== undefined) {
        if (fields.baseUrl !== null && (typeof fields.baseUrl !== 'string' || !validBase(fields.baseUrl))) {
            return refusal('baseUrl must be an http(s) URL without credentials, or null to clear it');
        }
        patch.baseUrl = fields.baseUrl as string | null;
    }
    if (fields.key !== undefined && !validKey(fields.key)) {
        return refusal('key must be a provider key: printable characters, no spaces');
    }
    return { patch };
}

/** The provider's rules over an edited endpoint: a subscription takes none, LiteLLM cannot lose its only one. */
function baseUrlRefusal(provider: ModelProvider, patch: { baseUrl?: string | null }): string | null {
    if (patch.baseUrl === undefined) return null;
    if (provider === 'subscription') return 'a subscription takes no baseUrl';
    if (provider === 'litellm' && patch.baseUrl === null) return 'LiteLLM needs a baseUrl';
    return null;
}

interface Context {
    readonly store: ProviderConnectionStore;
    readonly caller: Caller;
    readonly admin: boolean;
}

/** The store and caller every route needs — or null once the refusal is sent. */
async function contextOf(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply): Promise<Context | null> {
    const caller = callerOf(request);
    if (!caller) {
        bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
        return null;
    }
    const rt = await orgs.for(orgOf(request));
    if (!rt?.providerConnections) {
        bad(
            reply,
            ERROR_CODES.PROVIDER_CONNECTIONS_UNAVAILABLE,
            'No provider connection store for this organization',
            HTTP_UNAVAILABLE
        );
        return null;
    }
    return { store: rt.providerConnections, caller, admin: caller.role === ADMIN_ROLE };
}

const noSuchConnection = (reply: FastifyReply) =>
    reply.code(HTTP_NOT_FOUND).send({ error: 'No such provider connection' });

/** The `:id` path segment, or null once the BAD_ID refusal is sent. */
function idParam(request: FastifyRequest, reply: FastifyReply): string | null {
    const { id } = request.params as { id?: string };
    if (typeof id !== 'string' || !id) {
        bad(reply, ERROR_CODES.BAD_ID, 'id must be a string');
        return null;
    }
    return id;
}

/** Whether the error is the unique violation the per-scope name index raises — anything else rethrows. */
function isNameTaken(error: unknown): boolean {
    if ((error as { code?: string }).code === '23505') return true;
    throw error;
}

/**
 * A write the store can refuse by name or cap, answered by the route: a duplicate name is a 409
 * `NAME_TAKEN`, a full scope a 400 `TOO_MANY_CONNECTIONS`; anything else reaches `guard` and is an
 * outage or a bug.
 */
async function writeOrRefuse<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    write: () => Promise<T>
): Promise<{ ok: T } | { taken: true } | { capped: true } | { failed: true }> {
    const guarded = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        async (): Promise<{ ok: T } | { taken: true } | { capped: true }> => {
            try {
                return { ok: await write() };
            } catch (error) {
                if (isNameTaken(error)) return { taken: true };
                if (error instanceof ProviderConnectionCapError) return { capped: true };
                throw error;
            }
        }
    );
    if (!guarded.ok) return { failed: true };
    return guarded.value;
}

/** Discovery's answer from the check's verdict: the catalog, the credit-only providers, or the failure. */
function discoveryOf(verdict: VerifyAnswer): ProviderConnectionModels {
    if (!verdict.ok) return { state: 'failed', code: verdict.code, message: verdict.message };
    if (verdict.models !== undefined) return { state: 'listed', models: verdict.models };
    return {
        state: 'unsupported',
        ...(verdict.creditUsd !== undefined ? { creditUsd: verdict.creditUsd } : {}),
        ...(verdict.budget ? { budget: verdict.budget } : {}),
    };
}

async function handleList(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    const read = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => ctx.store.listFor(ctx.caller.user.id)
    );
    if (!read.ok) return reply;
    return reply.code(HTTP_OK).send({ connections: read.value });
}

async function handleCreate(deps: ProviderConnectionRoutesDeps, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(deps.orgs, request, reply);
    if (!ctx) return reply;
    const parsed = parseCreate(request.body, deps.deploymentMode);
    if ('error' in parsed) return bad(reply, parsed.code, parsed.error);
    // The scope is in the body, so the route class admits any member and the org scope's admin check is here.
    if (parsed.scope === 'org' && !ctx.admin) {
        return bad(reply, ERROR_CODES.FORBIDDEN, 'Only an admin configures an organization connection', HTTP_FORBIDDEN);
    }
    const saved = await writeOrRefuse(request, reply, () =>
        ctx.store.create({
            scope: parsed.scope,
            userId: ctx.caller.user.id,
            provider: parsed.provider,
            name: parsed.name,
            baseUrl: parsed.baseUrl,
            key: parsed.key,
        })
    );
    if ('failed' in saved) return reply;
    if ('taken' in saved) {
        return bad(
            reply,
            ERROR_CODES.NAME_TAKEN,
            `a provider connection named "${parsed.name}" already exists`,
            HTTP_CONFLICT
        );
    }
    if ('capped' in saved) {
        return bad(reply, ERROR_CODES.TOO_MANY_CONNECTIONS, 'too many provider connections in this scope');
    }
    return reply.code(HTTP_CREATED).send(saved.ok);
}

async function handleEdit(deps: ProviderConnectionRoutesDeps, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(deps.orgs, request, reply);
    if (!ctx) return reply;
    const id = idParam(request, reply);
    if (id === null) return reply;
    const existing = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => ctx.store.forUser(ctx.caller.user.id, id)
    );
    if (!existing.ok) return reply;
    if (!existing.value) return noSuchConnection(reply);
    // Scope and ownership are the row's: an org row is an admin's edit, a personal row its owner's —
    // and `forUser` already answers only the caller's own and the organization's rows.
    if (existing.value.scope === 'org' && !ctx.admin) {
        return bad(reply, ERROR_CODES.FORBIDDEN, 'Only an admin configures an organization connection', HTTP_FORBIDDEN);
    }
    const parsed = parseEdit(request.body);
    if ('error' in parsed) return bad(reply, parsed.code, parsed.error);
    const endpointReason = baseUrlRefusal(existing.value.provider, parsed.patch);
    if (endpointReason) return bad(reply, ERROR_CODES.BAD_BODY, endpointReason);

    const saved = await writeOrRefuse(request, reply, () =>
        ctx.store.update(existing.value!.scope === 'org' ? null : ctx.caller.user.id, id, parsed.patch)
    );
    if ('failed' in saved) return reply;
    if ('taken' in saved) {
        return bad(
            reply,
            ERROR_CODES.NAME_TAKEN,
            `a provider connection named "${parsed.patch.name}" already exists`,
            HTTP_CONFLICT
        );
    }
    if ('capped' in saved) {
        return bad(reply, ERROR_CODES.TOO_MANY_CONNECTIONS, 'too many provider connections in this scope');
    }
    if (!saved.ok) return noSuchConnection(reply);
    return reply.code(HTTP_OK).send(saved.ok);
}

async function handleDelete(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    const id = idParam(request, reply);
    if (id === null) return reply;
    const existing = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => ctx.store.forUser(ctx.caller.user.id, id)
    );
    if (!existing.ok) return reply;
    if (!existing.value) return noSuchConnection(reply);
    if (existing.value.scope === 'org' && !ctx.admin) {
        return bad(reply, ERROR_CODES.FORBIDDEN, 'Only an admin configures an organization connection', HTTP_FORBIDDEN);
    }
    const removed = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => ctx.store.remove(existing.value!.scope === 'org' ? null : ctx.caller.user.id, id)
    );
    if (!removed.ok) return reply;
    if (!removed.value) return noSuchConnection(reply);
    return reply.code(HTTP_OK).send({ id, removed: true });
}

async function handleModels(
    deps: ProviderConnectionRoutesDeps,
    limiter: ReturnType<typeof createRateLimiter>,
    request: FastifyRequest,
    reply: FastifyReply
) {
    reply.header('cache-control', 'no-store');
    // The slot is spent before anything is read: a refused request still counts.
    const caller = callerOf(request);
    const verdict = limiter.hit(caller ? `${caller.org.id}:${caller.user.id}` : orgOf(request));
    if (!verdict.ok) {
        reply.header('retry-after', String(verdict.retryAfterSeconds));
        return bad(reply, ERROR_CODES.RATE_LIMITED, 'Too many model listings; try again shortly', HTTP_TOO_MANY);
    }
    const ctx = await contextOf(deps.orgs, request, reply);
    if (!ctx) return reply;
    const id = idParam(request, reply);
    if (id === null) return reply;
    const found = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => ctx.store.credentialFor(ctx.caller.user.id, id)
    );
    if (!found.ok) return reply;
    if (!found.value) return noSuchConnection(reply);
    const { connection, key } = found.value;
    // A subscription token has no read to make with it: no discovery, no provider call.
    if (connection.provider === 'subscription') return reply.code(HTTP_OK).send({ state: 'unsupported' });
    // The member going away ends the check: the signal reaches the lookup and the request.
    const abort = new AbortController();
    reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) abort.abort();
    });
    const checked = await deps.providerKeys!.verify(
        { provider: connection.provider, key, baseUrl: connection.baseUrl ?? undefined },
        abort.signal
    );
    return reply.code(HTTP_OK).send(discoveryOf(checked));
}

/**
 * Provider connection routes: the metadata list every member reads (own + org), the writes the
 * scope gates (personal any member, org an admin), and — with a checker wired — the discovery read
 * that spends a stored key against its provider.
 */
interface ProviderConnectionRoutesDeps {
    readonly orgs: OrgRegistry;
    /** Cloud refuses a `subscription` connection at create. */
    readonly deploymentMode: AppConfig['deploymentMode'];
    /** The provider key check behind discovery; absent, the models route does not exist. */
    readonly providerKeys: ProviderKeys | undefined;
    readonly now?: (() => number) | undefined;
}

export function providerConnectionRoutes(deps: ProviderConnectionRoutesDeps): FastifyPluginAsync {
    const limiter = createRateLimiter({ limit: PER_MEMBER_PER_WINDOW, windowMs: WINDOW_MS, now: deps.now ?? Date.now });
    return async (app) => {
        app.get(PATH, { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) => handleList(deps.orgs, request, reply));
        app.post(PATH, { bodyLimit: BODY_LIMIT }, (request, reply) => handleCreate(deps, request, reply));
        app.put(`${PATH}/:id`, { bodyLimit: BODY_LIMIT }, (request, reply) => handleEdit(deps, request, reply));
        app.delete(`${PATH}/:id`, { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleDelete(deps.orgs, request, reply)
        );
        if (deps.providerKeys) {
            app.get(`${PATH}/:id/models`, { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
                handleModels(deps, limiter, request, reply)
            );
        }
    };
}
