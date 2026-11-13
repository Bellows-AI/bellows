import { describe, expect, it } from 'vitest';
import { ROUTE_CLASSES, classOf, grantedScopes, roleOf } from '../src/auth/route-class.js';

// "Every registered human route is classified" lives in auth.enforcement.test.ts, which already records the full app's
// routes; a second file mocking fastify beside it would share a module cache and see none of them.
describe('the route classes (what a scoped caller may do)', () => {
    it('has one row per method and pattern', () => {
        const keys = ROUTE_CLASSES.map(([method, pattern]) => `${method} ${pattern}`);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('reads are GETs and the two dry-run POSTs; the rest is write; HEAD rides GET', () => {
        expect(classOf('GET', '/api/jobs')).toBe('read');
        expect(classOf('HEAD', '/api/jobs')).toBe('read');
        expect(classOf('POST', '/api/jobs')).toBe('write');
        expect(classOf('POST', '/api/jobs/preflight')).toBe('read');
        expect(classOf('POST', '/api/batches/:id/validate')).toBe('read');
        expect(classOf('POST', '/api/batches/:id/start')).toBe('write');
        expect(classOf('GET', '/api/integrations/:provider/callback')).toBe('none');
        expect(classOf('POST', '/api/tokens')).toBe('none');
        expect(classOf('GET', '/api/connections')).toBe('read');
        expect(classOf('POST', '/api/jobs/:id/connections')).toBe('write');
        expect(classOf('DELETE', '/api/connections/:id')).toBe('none');
        expect(classOf('GET', '/api/no-such-route')).toBeUndefined();
        expect(classOf('PATCH', '/api/jobs')).toBeUndefined();
    });

    it('every row names the role it needs, and a GET or dry run never needs more than its writes', () => {
        for (const row of ROUTE_CLASSES) expect(['member', 'admin', 'operator']).toContain(row[3]);
        expect(roleOf('GET', '/api/jobs')).toBe('member');
        expect(roleOf('HEAD', '/api/tokens/org')).toBe('admin');
        expect(roleOf('GET', '/api/no-such-route')).toBeUndefined();
    });

    // The whole admin surface, pinned: a state-changing org route reachable by a plain member is the class this
    // guards against, so a new org-wide write must be added here on purpose, never by default.
    it('admin is exactly the org-wide administration: tokens, org env, members, executors, skills, subscriptions', () => {
        const admin = ROUTE_CLASSES.filter((row) => row[3] === 'admin').map(
            ([method, pattern]) => `${method} ${pattern}`
        );
        expect(admin.sort()).toEqual(
            [
                'DELETE /api/org/executors/:id',
                'DELETE /api/org/notification-subscriptions/:id',
                'DELETE /api/org/skills/:id',
                'DELETE /api/org/members/:userId',
                'DELETE /api/org/members/removed/:userId',
                'GET /api/audit',
                'GET /api/org/export',
                'GET /api/org/members',
                'GET /api/org/members/invitations',
                'GET /api/org/members/removed',
                'GET /api/tokens/org',
                'POST /api/org/executors',
                'POST /api/org/executors/:id/scope',
                'POST /api/org/executors/:id/suspension',
                'POST /api/org/notification-subscriptions',
                'POST /api/org/notification-subscriptions/:id/test',
                'POST /api/org/skills',
                'POST /api/org/skills/:id/versions',
                'POST /api/tokens/org',
                'POST /api/tokens/org/:id/revoke',
                'PUT /api/env/org',
                'PUT /api/env/repo',
                'PUT /api/org/executors/:id',
                'PUT /api/org/members/:userId/role',
                'PUT /api/org/notification-subscriptions/:id',
                'PUT /api/org/skills/:id/enabled',
                'PUT /api/org/skills/builtin/:name/enabled',
            ].sort()
        );
    });

    // The operator spans every organization: its rows are pinned the same way, and none is reachable by a scoped grant.
    it('operator is exactly the organization status and delete surface, and never a scoped route', () => {
        const operator = ROUTE_CLASSES.filter((row) => row[3] === 'operator');
        expect(operator.map(([method, pattern]) => `${method} ${pattern}`).sort()).toEqual(
            [
                'GET /api/operator/orgs',
                'POST /api/operator/orgs/:id/activate',
                'POST /api/operator/orgs/:id/delete',
                'POST /api/operator/orgs/:id/refuse',
                'POST /api/operator/orgs/:id/suspend',
            ].sort()
        );
        expect(operator.every(([, , cls]) => cls === 'none')).toBe(true);
    });

    it('grantedScopes keeps only scopes the board knows', () => {
        expect(grantedScopes(['read', 'factory:write', 'factory:read'])).toEqual(['factory:read', 'factory:write']);
        expect(grantedScopes([])).toEqual([]);
    });
});
