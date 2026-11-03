/**
 * What a scoped caller (the MCP bridge's) may do on each human route: `read` needs `factory:read`, `write` needs
 * `factory:write`. A cookie, `fat_` or local caller carries scope `'all'` and is never asked.
 *
 * One row per registered method and pattern, the pattern exactly as the router registered it (the form
 * `routeOptions.url` reports), so no re-parse of the URL can disagree with the handler. A route with no row is
 * unclassified, and a scoped caller is refused on it. `server/test/auth.route-class.test.ts` fails when a human
 * route has no row or a row has no route.
 */
export const SCOPES = ['factory:read', 'factory:write'] as const;
export type Scope = (typeof SCOPES)[number];
export type RouteClass = 'read' | 'write';

/** The scope a class needs. */
export const SCOPE_OF_CLASS: Readonly<Record<RouteClass, Scope>> = { read: 'factory:read', write: 'factory:write' };

export const ROUTE_CLASSES: readonly (readonly [method: string, pattern: string, routeClass: RouteClass])[] = [
    // A GET is a read, except the OAuth callback, which completes an authorization. The two dry-run POSTs (a batch
    // validation and a task preflight) change nothing and are reads.
    ['DELETE', '/api/attachments/:id', 'write'],
    ['DELETE', '/api/connections/:id', 'write'],
    ['DELETE', '/api/org/executors/:id', 'write'],
    ['DELETE', '/api/org/notification-subscriptions/:id', 'write'],
    ['DELETE', '/api/workflows/:id', 'write'],
    ['DELETE', '/api/workspace/executors/:id', 'write'],
    ['DELETE', '/api/workspace/notification-subscriptions/:id', 'write'],
    ['GET', '/api/attachments/:id', 'read'],
    ['GET', '/api/attachments/:id/content', 'read'],
    ['GET', '/api/attachments/limits', 'read'],
    ['GET', '/api/batches', 'read'],
    ['GET', '/api/batches/:id', 'read'],
    ['GET', '/api/batches/:id/report', 'read'],
    ['GET', '/api/commerce', 'read'],
    ['GET', '/api/connections', 'read'],
    ['GET', '/api/env', 'read'],
    ['GET', '/api/integrations', 'read'],
    ['GET', '/api/integrations/:provider/callback', 'write'],
    ['GET', '/api/jobs', 'read'],
    ['GET', '/api/jobs/:id', 'read'],
    ['GET', '/api/jobs/:id/activity', 'read'],
    ['GET', '/api/jobs/:id/artifacts', 'read'],
    ['GET', '/api/jobs/:id/artifacts/read', 'read'],
    ['GET', '/api/jobs/:id/thread', 'read'],
    ['GET', '/api/org/executors', 'read'],
    ['GET', '/api/org/members', 'read'],
    ['GET', '/api/org/notification-subscriptions', 'read'],
    ['GET', '/api/repos', 'read'],
    ['GET', '/api/repos/:owner/:name/branches', 'read'],
    ['GET', '/api/repos/:owner/:name/skills', 'read'],
    ['GET', '/api/skills', 'read'],
    ['GET', '/api/stats', 'read'],
    ['GET', '/api/tasks', 'read'],
    ['GET', '/api/tokens', 'read'],
    ['GET', '/api/tokens/org', 'read'],
    ['GET', '/api/workflow-blocks', 'read'],
    ['GET', '/api/workflows', 'read'],
    ['GET', '/api/workflows/:id', 'read'],
    ['GET', '/api/workspace', 'read'],
    ['GET', '/api/workspace/executors', 'read'],
    ['GET', '/api/workspace/notification-subscriptions', 'read'],
    ['PATCH', '/api/jobs/:id', 'write'],
    ['POST', '/api/attachments', 'write'],
    ['POST', '/api/batches', 'write'],
    ['POST', '/api/batches/:id/cancel', 'write'],
    ['POST', '/api/batches/:id/start', 'write'],
    ['POST', '/api/batches/:id/tasks/:key/accept', 'write'],
    ['POST', '/api/batches/:id/tasks/:key/retry', 'write'],
    ['POST', '/api/batches/:id/validate', 'read'],
    ['POST', '/api/integrations/:provider/authorizations', 'write'],
    ['POST', '/api/jobs', 'write'],
    ['POST', '/api/jobs/:id/connections', 'write'],
    ['POST', '/api/jobs/:id/done', 'write'],
    ['POST', '/api/jobs/:id/follow-up', 'write'],
    ['POST', '/api/jobs/:id/questions/:questionId/answer', 'write'],
    ['POST', '/api/jobs/:id/remove', 'write'],
    ['POST', '/api/jobs/:id/reopen', 'write'],
    ['POST', '/api/jobs/:id/requirements/:provider/dismiss', 'write'],
    ['POST', '/api/jobs/:id/retry', 'write'],
    ['POST', '/api/jobs/:id/stop', 'write'],
    ['POST', '/api/jobs/:id/wait/cancel', 'write'],
    ['POST', '/api/jobs/:id/wait/poke', 'write'],
    ['POST', '/api/jobs/preflight', 'read'],
    ['POST', '/api/org/executors', 'write'],
    ['POST', '/api/org/executors/:id/scope', 'write'],
    ['POST', '/api/org/executors/:id/suspension', 'write'],
    ['POST', '/api/org/notification-subscriptions', 'write'],
    ['POST', '/api/org/notification-subscriptions/:id/test', 'write'],
    ['POST', '/api/tokens', 'write'],
    ['POST', '/api/tokens/:id/revoke', 'write'],
    ['POST', '/api/tokens/org', 'write'],
    ['POST', '/api/tokens/org/:id/revoke', 'write'],
    ['POST', '/api/workflows', 'write'],
    ['POST', '/api/workspace/executors/:id/suspension', 'write'],
    ['POST', '/api/workspace/notification-subscriptions', 'write'],
    ['POST', '/api/workspace/notification-subscriptions/:id/test', 'write'],
    ['PUT', '/api/batches/:id', 'write'],
    ['PUT', '/api/env/org', 'write'],
    ['PUT', '/api/env/repo', 'write'],
    ['PUT', '/api/env/workspace', 'write'],
    ['PUT', '/api/org/executors/:id', 'write'],
    ['PUT', '/api/org/members/:userId/role', 'write'],
    ['PUT', '/api/org/notification-subscriptions/:id', 'write'],
    ['PUT', '/api/workflows/:id', 'write'],
    ['PUT', '/api/workspace/executors', 'write'],
    ['PUT', '/api/workspace/executors/default', 'write'],
    ['PUT', '/api/workspace/notification-subscriptions/:id', 'write'],
];

const TABLE = new Map(ROUTE_CLASSES.map(([method, pattern, routeClass]) => [`${method} ${pattern}`, routeClass]));

/** The class of a method on a registered pattern; HEAD rides the GET row, as Fastify's auto-created HEAD route does. */
export const classOf = (method: string, pattern: string): RouteClass | undefined =>
    TABLE.get(`${method === 'HEAD' ? 'GET' : method} ${pattern}`);

/** The known scopes among stored ones; a scope this board does not know grants nothing. */
export const grantedScopes = (stored: readonly string[]): Scope[] => SCOPES.filter((scope) => stored.includes(scope));
