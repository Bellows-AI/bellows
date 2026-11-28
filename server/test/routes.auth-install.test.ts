import { describe, expect, it } from 'vitest';
import { decodeState } from '../src/auth/session.js';
import { TEST_SESSION_SECRET } from './helpers-config.js';
import { HTTP_FOUND } from './helpers-http.js';
import { githubAuth, harness, memoryAuthStore, stubIdentityClient } from './helpers.js';
import { errorOf, setup } from './auth.oauth-fixtures.js';

const installRoute = (app: Awaited<ReturnType<typeof setup>>['app'], query: string) =>
    app.inject({ method: 'GET', url: `/api/auth/github/install${query}` });

describe('GET /api/auth/github/install', () => {
    it('redirects to the App install page with a signed state that reselects and returns to the page', async () => {
        const { app } = await setup();
        const response = await installRoute(app, '?returnTo=%2Faccount');

        expect(response.statusCode).toBe(HTTP_FOUND);
        const install = new URL(response.headers.location as string);
        expect(install.origin + install.pathname).toBe('https://github.com/apps/stub-app/installations/new');
        const decoded = decodeState(install.searchParams.get('state') ?? undefined, TEST_SESSION_SECRET);
        expect(decoded).toMatchObject({ returnTo: '/account', reselect: true });
    });

    it('normalizes a hostile returnTo to /', async () => {
        const { app } = await setup();
        const response = await installRoute(app, `?returnTo=${encodeURIComponent('https://evil.example/x')}`);

        const install = new URL(response.headers.location as string);
        const decoded = decodeState(install.searchParams.get('state') ?? undefined, TEST_SESSION_SECRET);
        expect(decoded?.returnTo).toBe('/');
    });

    it('reports install as its own failure when the slug cannot be resolved', async () => {
        // No appSlug at all — the offline shape.
        const { app } = await harness({
            config: { auth: githubAuth() },
            auth: memoryAuthStore(),
            identity: stubIdentityClient(),
        });
        const response = await installRoute(app, '?returnTo=%2Faccount');

        expect(response.statusCode).toBe(HTTP_FOUND);
        expect(errorOf(response.headers.location as string)).toBe('install');
    });
});
