import {
    createJiraIntegration,
    ERROR_CODES,
    INTEGRATION_CATEGORIES,
    INTEGRATION_CATALOG,
    type IntegrationCategory,
    type IntegrationProvider,
} from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { ConnectionView } from '../db/connection-store.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, guard } from './helpers.js';

/**
 * `GET /api/integrations/catalog`: the provider list (`core/src/integration-catalog.ts`) joined with what this
 * deployment can connect and the caller's OWN connections, as counts and states only. A state is stated only when
 * real state backs it; a connection read that fails is a 503, never a state guessed without it. Read-only: it
 * starts no authorization and grants nothing (docs/connections.md).
 */

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_UNAVAILABLE = 503;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** Where a member connects a provider, and where they manage what is connected: board pages, not provider URLs. */
const CONNECT_PATH = '/settings/integrations/available';
const MANAGE_PATH = '/settings/integrations';

type State = 'connectable' | 'connected' | 'needs_reconnect' | 'planned' | 'unavailable';

interface CatalogEntry {
    provider: string;
    name: string;
    category: IntegrationCategory;
    description: string;
    state: State;
    reason?: 'not_configured' | 'organization_managed';
    connections: number;
    capabilities?: { read: string[]; write: string[] };
    connect?: { path: string };
    manage?: { path: string };
}

export interface IntegrationCatalogDeps {
    orgs: OrgRegistry;
    /** The provider ids this deployment registered an OAuth client for. */
    configured?: readonly string[] | undefined;
}

const SORTED = [...INTEGRATION_CATALOG].sort((a, b) => a.id.localeCompare(b.id));

/** What the provider's integration definition declares it can do, where it has one. */
const capabilitiesOf = (id: string): CatalogEntry['capabilities'] => {
    if (id !== 'jira') return undefined;
    const { capabilities } = createJiraIntegration();
    return { read: [...(capabilities.read ?? [])], write: [...(capabilities.write ?? [])] };
};

function entryOf(provider: IntegrationProvider, configured: boolean, own: ConnectionView[]): CatalogEntry {
    const base = {
        provider: provider.id,
        name: provider.label,
        category: provider.category,
        description: provider.description,
    };
    if (provider.availability === 'planned') return { ...base, state: 'planned', connections: 0 };
    if (provider.availability === 'organization') {
        return { ...base, state: 'unavailable', reason: 'organization_managed', connections: 0 };
    }
    if (!configured) return { ...base, state: 'unavailable', reason: 'not_configured', connections: 0 };
    const active = own.filter((row) => row.provider === provider.id && row.status === 'active');
    const healthy = active.some((row) => !row.needsReconnect);
    const state: State = healthy ? 'connected' : active.length > 0 ? 'needs_reconnect' : 'connectable';
    const capabilities = capabilitiesOf(provider.id);
    return {
        ...base,
        state,
        connections: active.length,
        ...(capabilities ? { capabilities } : {}),
        ...(state === 'connected' ? {} : { connect: { path: CONNECT_PATH } }),
        ...(active.length > 0 ? { manage: { path: MANAGE_PATH } } : {}),
    };
}

interface Query {
    q?: string;
    category?: IntegrationCategory;
    limit: number;
    after: string | null;
}

/** The query's fields, or the refusal sentence and code. */
function parseQuery(raw: Record<string, unknown>): Query | { code: string; message: string } {
    const text = (key: string): string | undefined => (typeof raw[key] === 'string' ? raw[key] : undefined);
    const category = text('category');
    if (category !== undefined && !(INTEGRATION_CATEGORIES as readonly string[]).includes(category)) {
        return {
            code: ERROR_CODES.BAD_QUERY,
            message: `category must be one of: ${INTEGRATION_CATEGORIES.join(', ')}`,
        };
    }
    const limitText = text('limit');
    const limit = limitText === undefined ? DEFAULT_LIMIT : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        return { code: ERROR_CODES.BAD_LIMIT, message: `limit must be an integer from 1 to ${MAX_LIMIT}` };
    }
    const after = text('cursor') ?? null;
    if (after !== null && !SORTED.some((provider) => provider.id === after)) {
        return { code: ERROR_CODES.BAD_CURSOR, message: 'cursor was not issued by this endpoint' };
    }
    const q = text('q');
    return {
        ...(q ? { q } : {}),
        ...(category ? { category: category as IntegrationCategory } : {}),
        limit,
        after,
    };
}

const matches = (provider: IntegrationProvider, q: string | undefined): boolean => {
    if (!q) return true;
    const needle = q.toLowerCase();
    return [provider.id, provider.label, provider.description].some((field) => field.toLowerCase().includes(needle));
};

/** The filtered, sorted catalog from just after the cursor, one page of it, and the cursor of the next. */
function pageOfCatalog(query: Query, configured: readonly string[], own: ConnectionView[]) {
    const chosen = SORTED.filter(
        (provider) =>
            (query.category === undefined || provider.category === query.category) && matches(provider, query.q)
    );
    const rest = query.after === null ? chosen : chosen.filter((provider) => provider.id > query.after!);
    const page = rest.slice(0, query.limit);
    const last = page.at(-1);
    return {
        providers: page.map((provider) => entryOf(provider, configured.includes(provider.id), own)),
        cursor: rest.length > page.length && last ? last.id : null,
    };
}

export const integrationCatalogRoutes =
    ({ orgs, configured = [] }: IntegrationCatalogDeps): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/integrations/catalog', async (request: FastifyRequest, reply: FastifyReply) => {
            const caller = callerOf(request);
            if (!caller) {
                return reply
                    .code(HTTP_UNAUTHORIZED)
                    .send({ error: 'Sign in required', code: ERROR_CODES.UNAUTHENTICATED });
            }
            const query = parseQuery(request.query as Record<string, unknown>);
            if ('message' in query) return bad(reply, query.code, query.message);
            const store = (await orgs.for(orgOf(request)))?.connections;
            if (!store) {
                return bad(
                    reply,
                    ERROR_CODES.CONNECTIONS_UNAVAILABLE,
                    'No connection store for this organization',
                    HTTP_UNAVAILABLE
                );
            }
            const own = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'integration catalog connection read failed'),
                () => store.list(caller.user.id)
            );
            if (!own.ok) return reply;
            const { providers, cursor } = pageOfCatalog(query, configured, own.value);
            return reply.code(HTTP_OK).header('cache-control', 'no-store').send({ providers, cursor });
        });
    };
