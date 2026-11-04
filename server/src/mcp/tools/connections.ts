import { z } from 'zod';
import { judge, success } from '../result.js';
import { defineTool, READ_ONLY } from '../tool.js';
import { MAX_CATALOG_PAGE, MAX_CURSOR_CHARS, MAX_NAME_CHARS, queryOf } from './paging.js';

/** `GET /api/connections`: the caller's OWN connections, never a credential. Unknown fields are dropped here. */
export const ConnectionRows = z.object({
    connections: z.array(
        z.object({
            id: z.string(),
            provider: z.string(),
            credential: z.string(),
            ownership: z.string(),
            principal: z.string().nullable(),
            site: z.string(),
            account: z.string(),
            access: z.enum(['read', 'write']),
            status: z.enum(['active', 'disconnected']),
            needsReconnect: z.boolean(),
            createdAt: z.string(),
        })
    ),
});

export type ConnectionStanding = 'connected' | 'needs_reconnect' | 'missing';

/** What the caller's active connections to a provider add up to: a working one wins over a lapsed one. */
export function standingOf(
    rows: readonly { provider: string; status: string; needsReconnect: boolean }[],
    provider: string
): ConnectionStanding {
    const active = rows.filter((row) => row.provider === provider && row.status === 'active');
    if (active.some((row) => !row.needsReconnect)) return 'connected';
    return active.length > 0 ? 'needs_reconnect' : 'missing';
}

const stateOf = (row: { status: string; needsReconnect: boolean }): 'connected' | 'needs_reconnect' | 'disconnected' =>
    row.status === 'disconnected' ? 'disconnected' : row.needsReconnect ? 'needs_reconnect' : 'connected';

/** The caller's own connections. Another member's, and every token, are absent by the board's route. */
export const listConnections = defineTool({
    name: 'list_connections',
    description:
        'List your own provider connections (for example Jira sites): id, provider, site, account, access and `state` (connected, needs_reconnect or disconnected). Only your personal connections within the organization of this connection are shown; no token or secret is ever returned. Pass a connection id to preflight_task to select it for a task.',
    scope: 'factory:read',
    routes: [['GET', '/api/connections']],
    annotations: READ_ONLY,
    input: z.object({}),
    output: z.object({
        connections: z.array(
            ConnectionRows.shape.connections.element.extend({
                state: z.enum(['connected', 'needs_reconnect', 'disconnected']),
            })
        ),
    }),
    async run(_args, ctx) {
        const judged = judge(await ctx.fetch({ method: 'GET', url: '/api/connections' }), ConnectionRows);
        if (!judged.ok) return judged.tagged;
        const rows = judged.data.connections
            .map((row) => ({ ...row, state: stateOf(row) }))
            .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
        return { outcome: 'ok', result: success({ connections: rows }, `${rows.length} connections`) };
    },
});

const CatalogSchema = z.object({
    providers: z.array(
        z.object({
            provider: z.string(),
            name: z.string(),
            category: z.string(),
            description: z.string(),
            state: z.enum(['connectable', 'connected', 'needs_reconnect', 'planned', 'unavailable']),
            reason: z.enum(['not_configured', 'organization_managed']).optional(),
            connections: z.number().int(),
            capabilities: z.object({ read: z.array(z.string()), write: z.array(z.string()) }).optional(),
            connect: z.object({ path: z.string() }).optional(),
            manage: z.object({ path: z.string() }).optional(),
        })
    ),
    cursor: z.string().nullable(),
});

/** The provider catalog with this board's availability and your own standing; it grants and connects nothing. */
export const listAvailableIntegrations = defineTool({
    name: 'list_available_integrations',
    description:
        'Browse the integration providers this board offers, not just the ones you connected. `state`: connectable (you can connect it on the board), connected, needs_reconnect, planned (nothing behind it yet), or unavailable (`reason` says why). `connect` / `manage` are board paths to open while signed in; this tool connects nothing and never starts OAuth. Your own connections are in list_connections.',
    scope: 'factory:read',
    routes: [['GET', '/api/integrations/catalog']],
    annotations: READ_ONLY,
    input: z.object({
        q: z
            .string()
            .max(MAX_NAME_CHARS)
            .optional()
            .describe('Case-insensitive text matched against name, id and description.'),
        category: z.string().max(MAX_NAME_CHARS).optional().describe('One category, for example "Issue tracking".'),
        limit: z.number().int().min(1).max(MAX_CATALOG_PAGE).optional().describe('Page size, 1-100 (default 50).'),
        cursor: z
            .string()
            .max(MAX_CURSOR_CHARS)
            .optional()
            .describe('The cursor of the previous page; omit for the first page.'),
    }),
    output: CatalogSchema,
    async run(args, ctx) {
        const outcome = await ctx.fetch({ method: 'GET', url: `/api/integrations/catalog${queryOf(args)}` });
        const judged = judge(outcome, CatalogSchema);
        if (!judged.ok) return judged.tagged;
        return {
            outcome: 'ok',
            result: success(
                judged.data,
                `${judged.data.providers.length} providers${judged.data.cursor ? ', more available' : ''}`
            ),
        };
    },
});
