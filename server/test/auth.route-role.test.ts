import { describe, expect, it } from 'vitest';
import { ROUTE_CLASSES } from '../src/auth/route-class.js';
import { githubAuth, harness, memoryAuthStore, memoryEnvVarStore, signedIn } from './helpers.js';
import { HTTP_FORBIDDEN, HTTP_OK, trackApps } from './helpers-http.js';

/**
 * Offline: the route→role table (route-class.ts) enforced in the one auth hook. A member's cookie and a member's
 * `fat_` are refused on every admin row before any handler runs; an admin's are let through to the handler.
 */

const track = trackApps();
const ORG = 'test-org';
const ID = '00000000-0000-4000-8000-000000000001';
const REFUSAL = 'Only an organization admin can do this';

const ADMIN_ROUTES = ROUTE_CLASSES.filter((row) => row[3] === 'admin').map(([method, pattern]) => ({
    method,
    pattern,
    url: pattern.replace(/:(\w+)/g, (_m, name: string) => (name === 'name' ? 'builtin-skill' : ID)),
}));

async function boot() {
    const auth = memoryAuthStore();
    const admin = auth.seedMember(ORG, 'admin-cat', 'admin');
    const member = auth.seedMember(ORG, 'octocat');
    const { app: instance } = await harness({
        auth,
        envVars: memoryEnvVarStore(),
        repos: [{ owner: 'acme', name: 'web' }],
        config: { auth: githubAuth() },
    });
    track(instance);
    return {
        instance,
        admin: {
            cookie: { cookie: await signedIn(auth, admin) },
            token: { authorization: `Bearer ${auth.seedAccessToken(ORG, 'personal', { userId: admin.user.id })}` },
        },
        member: {
            cookie: { cookie: await signedIn(auth, member) },
            token: { authorization: `Bearer ${auth.seedAccessToken(ORG, 'personal', { userId: member.user.id })}` },
        },
    };
}

/** `route` is `METHOD url`. */
const send = (
    instance: Awaited<ReturnType<typeof boot>>['instance'],
    route: string,
    headers: Record<string, string>,
    payload?: object
) => {
    const [method = 'GET', url = ''] = route.split(' ');
    return instance.inject({
        method: method as 'GET',
        url,
        headers,
        ...(method === 'GET' || method === 'DELETE' ? {} : { payload: payload ?? {} }),
    });
};

describe('the route→role table', () => {
    it.each(ADMIN_ROUTES)('$method $pattern refuses a member cookie and a member fat_ with 403', async (r) => {
        const { instance, member } = await boot();
        for (const headers of [member.cookie, member.token]) {
            const response = await send(instance, `${r.method} ${r.url}`, headers);
            expect(response.statusCode).toBe(HTTP_FORBIDDEN);
            expect(response.json()).toMatchObject({ error: REFUSAL, code: 'FORBIDDEN' });
        }
    });

    it.each(ADMIN_ROUTES)(
        '$method $pattern lets an admin cookie and an admin fat_ through to the handler',
        async (r) => {
            const { instance, admin } = await boot();
            for (const headers of [admin.cookie, admin.token]) {
                const response = await send(instance, `${r.method} ${r.url}`, headers);
                expect(response.json()).not.toMatchObject({ error: REFUSAL });
            }
        }
    );

    it('an admin mints, lists and revokes an org token and writes org env; a member changes nothing', async () => {
        const { instance, admin, member } = await boot();
        for (const headers of [member.cookie, member.token]) {
            expect((await send(instance, 'POST /api/tokens/org', headers, { label: 'ci' })).statusCode).toBe(
                HTTP_FORBIDDEN
            );
            expect((await send(instance, 'PUT /api/env/org', headers, { vars: [] })).statusCode).toBe(HTTP_FORBIDDEN);
        }
        expect((await send(instance, 'GET /api/tokens/org', admin.cookie)).json()).toEqual({ tokens: [] });

        const minted = await send(instance, 'POST /api/tokens/org', admin.token, { label: 'ci' });
        expect(minted.statusCode).toBeLessThan(300);
        const { id } = minted.json() as { id: string };
        expect((await send(instance, `POST /api/tokens/org/${id}/revoke`, member.cookie)).statusCode).toBe(
            HTTP_FORBIDDEN
        );
        expect((await send(instance, `POST /api/tokens/org/${id}/revoke`, admin.cookie)).statusCode).toBe(HTTP_OK);

        const vars = [{ name: 'CORE', value: '1', isSecret: false }];
        expect((await send(instance, 'PUT /api/env/org', admin.cookie, { vars })).statusCode).toBe(HTTP_OK);
    });

    it('a member keeps their own surfaces: personal tokens and workspace env', async () => {
        const { instance, member } = await boot();
        expect((await send(instance, 'POST /api/tokens', member.cookie, { label: 'laptop' })).statusCode).toBeLessThan(
            300
        );
        expect((await send(instance, 'PUT /api/env/workspace', member.token, { vars: [] })).statusCode).toBe(HTTP_OK);
    });
});
