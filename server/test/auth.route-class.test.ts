import { describe, expect, it } from 'vitest';
import { ROUTE_CLASSES, classOf, grantedScopes } from '../src/auth/route-class.js';

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

    it('grantedScopes keeps only scopes the board knows', () => {
        expect(grantedScopes(['read', 'factory:write', 'factory:read'])).toEqual(['factory:read', 'factory:write']);
        expect(grantedScopes([])).toEqual([]);
    });
});
