import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import { REDIRECT } from './oauth-rig.js';
import { MAX_RETURN_PATH, safeReturnPath } from '../src/auth/session.js';
import { authorize, authorizeParams, PUBLIC_URL, startBoard, STATE, type Board } from './oauth-http-rig.js';

const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });
const HTTP_FOUND = 302;
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVICE_UNAVAILABLE = 503;

let sql: Sql;
beforeAll(() => {
    if (enabled) sql = db.sql;
});
const boards: Board[] = [];
afterEach(async () => {
    for (const board of boards.splice(0)) await board.app.close();
});
const start = async (options?: Parameters<typeof startBoard>[2]) => {
    const board = await startBoard(sql, ORG, options);
    boards.push(board);
    return board;
};

/** The redirect a refusal sends the browser to: its query, with `iss` and the client's `state` always present. */
const refusal = (location: unknown) => {
    const url = new URL(String(location));
    return { origin: `${url.origin}${url.pathname}`, query: url.searchParams };
};

describe.skipIf(!enabled)('GET /api/oauth/authorize', () => {
    it('shows an unknown client or an unregistered redirect to the user and never redirects', async () => {
        const board = await start();
        for (const overrides of [
            { client_id: 'no-such-client' },
            { redirect_uri: 'https://evil.example/callback' },
            { redirect_uri: `${REDIRECT}/x` },
            { redirect_uri: undefined },
            { client_id: undefined },
        ]) {
            const response = await authorize(board, authorizeParams(board, overrides));
            expect(response.statusCode, JSON.stringify(overrides)).toBe(HTTP_BAD_REQUEST);
            expect(response.headers.location).toBeUndefined();
            expect(response.json()).toMatchObject({ error: 'invalid_request' });
        }
    });

    it('refuses repeated parameters outright', async () => {
        const board = await start();
        const params = authorizeParams(board);
        params.append('redirect_uri', 'https://evil.example/callback');
        expect((await authorize(board, params)).statusCode).toBe(HTTP_BAD_REQUEST);
    });

    it.each([
        ['response_type=token', { response_type: 'token' }, 'unsupported_response_type'],
        ['no code_challenge', { code_challenge: undefined }, 'invalid_request'],
        ['a malformed code_challenge', { code_challenge: 'short' }, 'invalid_request'],
        ['no method', { code_challenge_method: undefined }, 'invalid_request'],
        ['method plain', { code_challenge_method: 'plain' }, 'invalid_request'],
        ['an unknown scope', { scope: 'factory:read admin' }, 'invalid_scope'],
        ['a foreign resource', { resource: 'https://other.example/api/mcp' }, 'invalid_target'],
    ])('redirects %s to the client with the error, iss and state', async (_name, overrides, error) => {
        const board = await start();
        const response = await authorize(board, authorizeParams(board, overrides));
        expect(response.statusCode).toBe(HTTP_FOUND);
        const { origin, query } = refusal(response.headers.location);
        expect(origin).toBe(REDIRECT);
        expect(query.get('error')).toBe(error);
        expect(query.get('iss')).toBe(new URL(board.world.resource).origin);
        expect(query.get('state')).toBe(STATE);
        expect(query.get('code')).toBeNull();
    });

    it('sends a visitor without a session to sign in and back to a short resume link', async () => {
        const board = await start();
        const response = await authorize(board, authorizeParams(board), null);
        expect(response.statusCode).toBe(HTTP_FOUND);
        const login = new URL(String(response.headers.location), 'http://board.test');
        expect(login.pathname).toBe('/api/auth/github');
        const resume = String(login.searchParams.get('returnTo'));
        expect(resume).toMatch(/^\/api\/oauth\/authorize\/resume\?id=[A-Za-z0-9_-]+$/);
        expect(resume.length).toBeLessThan(MAX_RETURN_PATH);
        expect(safeReturnPath(resume, PUBLIC_URL)).toBe(resume);
    });

    it('does not trust a forged or foreign session cookie', async () => {
        const board = await start();
        const response = await authorize(board, authorizeParams(board), 'factory_session=forged.value');
        expect(new URL(String(response.headers.location), 'http://board.test').pathname).toBe('/api/auth/github');
    });

    it.each([
        ['a 2 KB state', 's'.repeat(2048)],
        ['an encoded backslash in the state', `a\\b${'s'.repeat(600)}`],
    ])('carries %s through sign-in to the consent screen', async (_name, state) => {
        const board = await start();
        const signedOut = await authorize(board, authorizeParams(board, { state }), null);
        expect(signedOut.statusCode).toBe(HTTP_FOUND);
        const login = new URL(String(signedOut.headers.location), 'http://board.test');
        const resume = safeReturnPath(login.searchParams.get('returnTo'), PUBLIC_URL);
        expect(resume).toContain('/api/oauth/authorize/resume');
        const resumed = await board.app.inject({ method: 'GET', url: resume, headers: { cookie: board.cookie } });
        expect(resumed.statusCode).toBe(HTTP_FOUND);
        const location = new URL(String(resumed.headers.location));
        expect(location.pathname).toBe('/oauth/consent');
        const id = new URLSearchParams(location.hash.slice(1)).get('id') ?? '';
        expect(await board.world.store.readConsent(id)).toMatchObject({
            clientId: board.world.clientId,
            redirectUri: REDIRECT,
            scopes: ['factory:read'],
            clientState: state,
        });
    });

    it('resumes once, only for a signed-in session, and not after it expires', async () => {
        const board = await start();
        const resumeOf = async () => {
            const response = await authorize(board, authorizeParams(board), null);
            const login = new URL(String(response.headers.location), 'http://board.test');
            return String(login.searchParams.get('returnTo'));
        };
        const get = (url: string, cookie: string | null = board.cookie) =>
            board.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

        const link = await resumeOf();
        // Still signed out: back to sign-in with the same link, nothing spent.
        const again = await get(link, null);
        expect(new URL(String(again.headers.location), 'http://board.test').pathname).toBe('/api/auth/github');
        expect((await get(link)).statusCode).toBe(HTTP_FOUND);
        // One time.
        const replay = await get(link);
        expect(replay.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(replay.headers.location).toBeUndefined();

        const stale = await resumeOf();
        board.world.clock.advance(3600);
        expect((await get(stale)).statusCode).toBe(HTTP_BAD_REQUEST);
        expect((await get('/api/oauth/authorize/resume?id=nope')).statusCode).toBe(HTTP_BAD_REQUEST);
        expect((await get('/api/oauth/authorize/resume')).statusCode).toBe(HTTP_BAD_REQUEST);
    });

    it('opens a consent transaction for a signed-in member and carries it in the redirect fragment', async () => {
        const board = await start();
        const response = await authorize(board, authorizeParams(board));
        expect(response.statusCode).toBe(HTTP_FOUND);
        expect(response.headers['cache-control']).toBe('no-store');
        const location = new URL(String(response.headers.location));
        expect(`${location.origin}${location.pathname}`).toBe(`${new URL(board.world.resource).origin}/oauth/consent`);
        expect(location.search).toBe('');
        const id = new URLSearchParams(location.hash.slice(1)).get('id') ?? '';
        const view = await board.world.store.readConsent(id);
        expect(view).toMatchObject({
            clientId: board.world.clientId,
            redirectUri: REDIRECT,
            resource: board.world.resource,
            scopes: ['factory:read'],
            clientState: STATE,
        });
    });

    it('defaults to every scope the board offers', async () => {
        const board = await start();
        const response = await authorize(board, authorizeParams(board, { scope: undefined }));
        const id = new URLSearchParams(new URL(String(response.headers.location)).hash.slice(1)).get('id') ?? '';
        expect((await board.world.store.readConsent(id))?.scopes).toEqual(['factory:read', 'factory:write']);
    });

    it('accepts any port on a registered loopback redirect and nothing else about it', async () => {
        const board = await start();
        await board.world.store.upsertClient({
            clientId: 'loopback-client',
            kind: 'dcr',
            name: 'Loopback',
            redirectUris: ['http://127.0.0.1/callback', 'http://localhost/callback'],
        });
        for (const redirect of ['http://127.0.0.1:54321/callback', 'http://localhost:3118/callback']) {
            const response = await authorize(
                board,
                authorizeParams(board, { client_id: 'loopback-client', redirect_uri: redirect })
            );
            expect(new URL(String(response.headers.location)).pathname, redirect).toBe('/oauth/consent');
        }
        const other = await authorize(
            board,
            authorizeParams(board, { client_id: 'loopback-client', redirect_uri: 'http://127.0.0.1:1/other' })
        );
        expect(other.statusCode).toBe(HTTP_BAD_REQUEST);
    });

    it('answers 503, never invalid_client, when the client lookup could not be confirmed', async () => {
        const board = await start({
            oauth: (real) => ({
                ...real,
                findClient: async () => {
                    throw new Error('connection reset');
                },
            }),
        });
        const response = await authorize(board, authorizeParams(board));
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(response.headers.location).toBeUndefined();
    });
});
