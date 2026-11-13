/**
 * What a scoped caller (the MCP bridge's) may do on each human route: `read` needs `factory:read`, `write` needs
 * `factory:write`. A cookie, `fat_` or local caller carries scope `'all'` and is never asked.
 *
 * One row per registered method and pattern, the pattern exactly as the router registered it (the form
 * `routeOptions.url` reports), so no re-parse of the URL can disagree with the handler. A route with no row is
 * unclassified, and a scoped caller is refused on it. `server/test/auth.route-class.test.ts` fails when a human
 * route has no row or a row has no route.
 *
 * The same row names the role every user caller needs (cookie, `fat_` or bridged); the auth hook refuses a
 * caller below it before the handler runs.
 */
import { ADMIN_ROLE, MEMBER_ROLE, type Role } from '@factory-ai/core';

/**
 * The board operator's role (`OPERATOR_GITHUB_IDS`): not a membership role but a deployment one, held by the named
 * GitHub accounts whatever their org role — the routes that list, suspend, refuse and reactivate every organization.
 */
export const OPERATOR_ROLE = 'operator';
export type RouteRole = Role | typeof OPERATOR_ROLE;

export const SCOPES = ['factory:read', 'factory:write'] as const;
export type Scope = (typeof SCOPES)[number];
/**
 * `none` is never available to a scoped caller, whatever it holds: the routes that mint, rotate, list or revoke a
 * credential, write a secret or a connection grant, authorize a provider, or administer membership, outbound
 * destinations and executor profiles (whose `config` may hold provider credentials). An MCP grant must not be exchangeable for a longer-lived credential or a wider reach.
 */
export type RouteClass = 'read' | 'write' | 'none';

/** The scope a class needs. */
export const SCOPE_OF_CLASS: Readonly<Record<Exclude<RouteClass, 'none'>, Scope>> = {
    read: 'factory:read',
    write: 'factory:write',
};

export const ROUTE_CLASSES: readonly (readonly [
    method: string,
    pattern: string,
    routeClass: RouteClass,
    role: RouteRole,
])[] = [
    // A GET is a read; the two dry-run POSTs (a batch validation and a task preflight) change nothing and are reads.
    // Everything that touches a credential, secret, connection, provider authorization, membership or outbound
    // destination is `none`.
    // The role is who may call it at all, whatever the credential: `admin` for what administers the whole
    // organization (org tokens, org-wide env, the roster, org executors, skills and subscriptions), `member` for the
    // caller's own surfaces and the board, where a row-dependent rule (author or admin) stays in the handler.
    ['DELETE', '/api/attachments/:id', 'write', MEMBER_ROLE],
    ['DELETE', '/api/connections/:id', 'none', MEMBER_ROLE],
    ['DELETE', '/api/org/executors/:id', 'none', ADMIN_ROLE],
    ['DELETE', '/api/org/skills/:id', 'none', ADMIN_ROLE],
    ['DELETE', '/api/org/members/:userId', 'none', ADMIN_ROLE],
    ['DELETE', '/api/org/members/removed/:userId', 'none', ADMIN_ROLE],
    ['DELETE', '/api/org/notification-subscriptions/:id', 'none', ADMIN_ROLE],
    ['DELETE', '/api/workflows/:id', 'write', MEMBER_ROLE],
    ['DELETE', '/api/workspace/executors/:id', 'none', MEMBER_ROLE],
    ['DELETE', '/api/workspace/skills/:id', 'none', MEMBER_ROLE],
    ['DELETE', '/api/workspace/notification-subscriptions/:id', 'none', MEMBER_ROLE],
    ['GET', '/api/attachments/:id', 'read', MEMBER_ROLE],
    ['GET', '/api/attachments/:id/content', 'read', MEMBER_ROLE],
    ['GET', '/api/attachments/limits', 'read', MEMBER_ROLE],
    // Reads back the caller's own upload request, which the `factory:write` tool that minted it must be able to do.
    ['GET', '/api/attachments/upload-requests/:id', 'write', MEMBER_ROLE],
    // The audit log names every member's actions: an admin read, never reachable by a scoped grant.
    ['GET', '/api/audit', 'none', ADMIN_ROLE],
    ['GET', '/api/batches', 'read', MEMBER_ROLE],
    // The operator's surface spans every organization: never reachable by a scoped grant or by an org role.
    ['GET', '/api/operator/orgs', 'none', OPERATOR_ROLE],
    ['POST', '/api/operator/orgs/:id/suspend', 'none', OPERATOR_ROLE],
    ['POST', '/api/operator/orgs/:id/refuse', 'none', OPERATOR_ROLE],
    ['POST', '/api/operator/orgs/:id/activate', 'none', OPERATOR_ROLE],
    ['POST', '/api/operator/orgs/:id/delete', 'none', OPERATOR_ROLE],
    ['GET', '/api/batches/:id', 'read', MEMBER_ROLE],
    ['GET', '/api/batches/:id/report', 'read', MEMBER_ROLE],
    ['GET', '/api/commerce', 'read', MEMBER_ROLE],
    ['GET', '/api/connections', 'read', MEMBER_ROLE],
    ['GET', '/api/env', 'read', MEMBER_ROLE],
    ['GET', '/api/integrations', 'read', MEMBER_ROLE],
    ['GET', '/api/integrations/catalog', 'read', MEMBER_ROLE],
    ['GET', '/api/integrations/:provider/callback', 'none', MEMBER_ROLE],
    ['GET', '/api/jobs', 'read', MEMBER_ROLE],
    ['GET', '/api/jobs/:id', 'read', MEMBER_ROLE],
    ['GET', '/api/jobs/:id/activity', 'read', MEMBER_ROLE],
    ['GET', '/api/jobs/:id/artifacts', 'read', MEMBER_ROLE],
    ['GET', '/api/jobs/:id/artifacts/read', 'read', MEMBER_ROLE],
    ['GET', '/api/jobs/:id/thread', 'read', MEMBER_ROLE],
    ['GET', '/api/oauth/consent/:id', 'none', MEMBER_ROLE],
    ['GET', '/api/oauth/grants', 'none', MEMBER_ROLE],
    ['GET', '/api/org/executors', 'read', MEMBER_ROLE],
    ['GET', '/api/org/skills', 'read', MEMBER_ROLE],
    ['GET', '/api/org/skills/:id', 'read', MEMBER_ROLE],
    ['GET', '/api/org/skills/:id/zip', 'read', MEMBER_ROLE],
    ['GET', '/api/org/members', 'read', ADMIN_ROLE],
    ['GET', '/api/org/members/invitations', 'read', ADMIN_ROLE],
    ['GET', '/api/org/members/removed', 'read', ADMIN_ROLE],
    ['GET', '/api/org/notification-subscriptions', 'read', MEMBER_ROLE],
    ['GET', '/api/repos', 'read', MEMBER_ROLE],
    ['GET', '/api/repos/:owner/:name/branches', 'read', MEMBER_ROLE],
    ['GET', '/api/repos/:owner/:name/skills', 'read', MEMBER_ROLE],
    ['GET', '/api/skills', 'read', MEMBER_ROLE],
    ['GET', '/api/skills/builtin/:name', 'read', MEMBER_ROLE],
    ['GET', '/api/stats', 'read', MEMBER_ROLE],
    ['GET', '/api/tasks', 'read', MEMBER_ROLE],
    ['GET', '/api/tokens', 'none', MEMBER_ROLE],
    ['GET', '/api/tokens/org', 'none', ADMIN_ROLE],
    ['GET', '/api/workflow-blocks', 'read', MEMBER_ROLE],
    ['GET', '/api/workflows', 'read', MEMBER_ROLE],
    ['GET', '/api/workflows/:id', 'read', MEMBER_ROLE],
    ['GET', '/api/workspace', 'read', MEMBER_ROLE],
    ['GET', '/api/workspace/executors', 'read', MEMBER_ROLE],
    ['GET', '/api/workspace/skills', 'read', MEMBER_ROLE],
    ['GET', '/api/workspace/skills/:id', 'read', MEMBER_ROLE],
    ['GET', '/api/workspace/skills/:id/zip', 'read', MEMBER_ROLE],
    ['GET', '/api/workspace/notification-subscriptions', 'read', MEMBER_ROLE],
    ['PATCH', '/api/jobs/:id', 'write', MEMBER_ROLE],
    ['POST', '/api/attachments', 'write', MEMBER_ROLE],
    ['POST', '/api/attachments/upload-requests', 'write', MEMBER_ROLE],
    ['POST', '/api/batches', 'write', MEMBER_ROLE],
    ['POST', '/api/batches/:id/cancel', 'write', MEMBER_ROLE],
    ['POST', '/api/batches/:id/start', 'write', MEMBER_ROLE],
    ['POST', '/api/batches/:id/tasks/:key/accept', 'write', MEMBER_ROLE],
    ['POST', '/api/batches/:id/tasks/:key/retry', 'write', MEMBER_ROLE],
    ['POST', '/api/batches/:id/validate', 'read', MEMBER_ROLE],
    ['POST', '/api/integrations/:provider/authorizations', 'none', MEMBER_ROLE],
    ['POST', '/api/oauth/consent/approve', 'none', MEMBER_ROLE],
    ['POST', '/api/oauth/consent/deny', 'none', MEMBER_ROLE],
    ['POST', '/api/oauth/grants/:id/revoke', 'none', MEMBER_ROLE],
    ['POST', '/api/jobs', 'write', MEMBER_ROLE],
    ['POST', '/api/jobs/:id/connections', 'write', MEMBER_ROLE],
    ['POST', '/api/jobs/:id/done', 'write', MEMBER_ROLE],
    ['POST', '/api/jobs/:id/follow-up', 'write', MEMBER_ROLE],
    ['POST', '/api/jobs/:id/questions/:questionId/answer', 'write', MEMBER_ROLE],
    ['POST', '/api/jobs/:id/remove', 'write', MEMBER_ROLE],
    ['POST', '/api/jobs/:id/reopen', 'write', MEMBER_ROLE],
    ['POST', '/api/jobs/:id/requirements/:provider/dismiss', 'write', MEMBER_ROLE],
    ['POST', '/api/jobs/:id/retry', 'write', MEMBER_ROLE],
    ['POST', '/api/jobs/:id/stop', 'write', MEMBER_ROLE],
    ['POST', '/api/jobs/:id/wait/cancel', 'write', MEMBER_ROLE],
    ['POST', '/api/jobs/:id/wait/poke', 'write', MEMBER_ROLE],
    ['POST', '/api/jobs/preflight', 'read', MEMBER_ROLE],
    ['POST', '/api/org/executors', 'none', ADMIN_ROLE],
    ['POST', '/api/org/executors/:id/scope', 'none', ADMIN_ROLE],
    ['POST', '/api/org/executors/:id/suspension', 'none', ADMIN_ROLE],
    ['POST', '/api/org/skills', 'none', ADMIN_ROLE],
    ['POST', '/api/org/skills/:id/versions', 'none', ADMIN_ROLE],
    ['POST', '/api/org/notification-subscriptions', 'none', ADMIN_ROLE],
    ['POST', '/api/org/notification-subscriptions/:id/test', 'none', ADMIN_ROLE],
    ['POST', '/api/tokens', 'none', MEMBER_ROLE],
    ['POST', '/api/tokens/:id/revoke', 'none', MEMBER_ROLE],
    ['POST', '/api/tokens/org', 'none', ADMIN_ROLE],
    ['POST', '/api/tokens/org/:id/revoke', 'none', ADMIN_ROLE],
    ['POST', '/api/workflows', 'write', MEMBER_ROLE],
    ['POST', '/api/workspace/executors/:id/suspension', 'none', MEMBER_ROLE],
    ['POST', '/api/workspace/skills', 'none', MEMBER_ROLE],
    ['POST', '/api/workspace/skills/:id/scope', 'none', MEMBER_ROLE],
    ['POST', '/api/workspace/skills/:id/versions', 'none', MEMBER_ROLE],
    ['POST', '/api/workspace/notification-subscriptions', 'none', MEMBER_ROLE],
    ['POST', '/api/workspace/notification-subscriptions/:id/test', 'none', MEMBER_ROLE],
    ['PUT', '/api/batches/:id', 'write', MEMBER_ROLE],
    ['PUT', '/api/env/org', 'none', ADMIN_ROLE],
    ['PUT', '/api/env/repo', 'none', ADMIN_ROLE],
    ['PUT', '/api/env/workspace', 'none', MEMBER_ROLE],
    ['PUT', '/api/jobs/:id/title', 'write', MEMBER_ROLE],
    ['PUT', '/api/org/executors/:id', 'none', ADMIN_ROLE],
    ['PUT', '/api/org/skills/:id/enabled', 'none', ADMIN_ROLE],
    ['PUT', '/api/org/skills/builtin/:name/enabled', 'none', ADMIN_ROLE],
    ['PUT', '/api/org/members/:userId/role', 'none', ADMIN_ROLE],
    ['PUT', '/api/org/notification-subscriptions/:id', 'none', ADMIN_ROLE],
    ['PUT', '/api/workflows/:id', 'write', MEMBER_ROLE],
    ['PUT', '/api/workspace/executors', 'none', MEMBER_ROLE],
    ['PUT', '/api/workspace/executors/default', 'none', MEMBER_ROLE],
    ['PUT', '/api/workspace/skills/:id/enabled', 'none', MEMBER_ROLE],
    ['PUT', '/api/workspace/notification-subscriptions/:id', 'none', MEMBER_ROLE],
];

/**
 * The open routes (no credential of their own) a bridged request may still reach: the MCP `whoami` tool reads the
 * caller's identity and the build version through them. Every other open route is refused to a bridged request.
 */
export const BRIDGE_OPEN_ROUTES: readonly (readonly [method: string, pattern: string])[] = [
    ['GET', '/api/auth/me'],
    ['GET', '/api/version'],
];

export const bridgeOpen = (method: string, pattern: string | undefined): boolean =>
    BRIDGE_OPEN_ROUTES.some(([m, p]) => m === (method === 'HEAD' ? 'GET' : method) && p === pattern);

const TABLE = new Map(ROUTE_CLASSES.map(([method, pattern, ...row]) => [`${method} ${pattern}`, row] as const));

const rowOf = (method: string, pattern: string) => TABLE.get(`${method === 'HEAD' ? 'GET' : method} ${pattern}`);

/** The class of a method on a registered pattern; HEAD rides the GET row, as Fastify's auto-created HEAD route does. */
export const classOf = (method: string, pattern: string): RouteClass | undefined => rowOf(method, pattern)?.[0];

/** The role a method on a registered pattern needs, the same lookup as `classOf`. */
export const roleOf = (method: string, pattern: string): RouteRole | undefined => rowOf(method, pattern)?.[1];

/** The known scopes among stored ones; a scope this board does not know grants nothing. */
export const grantedScopes = (stored: readonly string[]): Scope[] => SCOPES.filter((scope) => stored.includes(scope));
