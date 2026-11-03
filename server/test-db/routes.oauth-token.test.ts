import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { hashToken } from '../src/auth/session.js';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import { REDIRECT } from './oauth-rig.js';
import {
    REVOKE,
    TOKEN,
    approveCode,
    codeForm,
    startBoard,
    tokenRequest,
    type Board,
    type TokenBody,
} from './oauth-http-rig.js';

const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVICE_UNAVAILABLE = 503;
const ACCESS_TTL_SECONDS = 3600;

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
const live = (board: Board, token: string) => board.world.store.findAccessToken(hashToken(token));
const issue = async (board: Board, overrides: Record<string, string | undefined> = {}): Promise<TokenBody> => {
    const response = await tokenRequest(board, codeForm(board, await approveCode(board, overrides)));
    expect(response.statusCode).toBe(HTTP_OK);
    return response.json() as TokenBody;
};
const refreshForm = (board: Board, refresh: string, overrides: Record<string, string | undefined> = {}) => ({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: board.world.clientId,
    ...overrides,
});

describe.skipIf(!enabled)('POST /api/oauth/token', () => {
    it('exchanges a code sent form-encoded for an RFC 6749 token response that is never cached', async () => {
        const board = await start();
        const code = await approveCode(board);
        const response = await tokenRequest(board, codeForm(board, code));
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers.pragma).toBe('no-cache');
        const body = response.json() as TokenBody;
        expect(body).toMatchObject({ token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, scope: 'factory:read' });
        expect(body.access_token).toMatch(/^mat_/);
        expect(body.refresh_token).toMatch(/^mrt_/);
        expect((await live(board, body.access_token))?.resource).toBe(board.world.resource);
    });

    it('accepts the same request as JSON', async () => {
        const board = await start();
        const response = await board.app.inject({
            method: 'POST',
            url: TOKEN,
            payload: codeForm(board, await approveCode(board)),
        });
        expect(response.statusCode).toBe(HTTP_OK);
    });

    it.each([
        ['a wrong verifier', { code_verifier: 'w'.repeat(48) }, HTTP_BAD_REQUEST, 'invalid_grant'],
        ['another redirect', { redirect_uri: `${REDIRECT}/other` }, HTTP_BAD_REQUEST, 'invalid_grant'],
        ['a foreign resource', { resource: 'https://other.example/api/mcp' }, HTTP_BAD_REQUEST, 'invalid_grant'],
        ['no code', { code: undefined }, HTTP_BAD_REQUEST, 'invalid_request'],
        ['no verifier', { code_verifier: undefined }, HTTP_BAD_REQUEST, 'invalid_request'],
        ['a malformed verifier', { code_verifier: 'short' }, HTTP_BAD_REQUEST, 'invalid_request'],
        ['no redirect_uri', { redirect_uri: undefined }, HTTP_BAD_REQUEST, 'invalid_request'],
        ['an unknown client', { client_id: 'no-such-client' }, HTTP_UNAUTHORIZED, 'invalid_client'],
        ['no client', { client_id: undefined }, HTTP_BAD_REQUEST, 'invalid_request'],
        ['an unsupported grant', { grant_type: 'password' }, HTTP_BAD_REQUEST, 'unsupported_grant_type'],
        ['no grant', { grant_type: undefined }, HTTP_BAD_REQUEST, 'invalid_request'],
    ])('refuses %s as a JSON RFC 6749 error', async (_name, overrides, status, error) => {
        const board = await start();
        const response = await tokenRequest(board, codeForm(board, await approveCode(board), overrides));
        expect(response.statusCode).toBe(status);
        expect(response.headers['content-type']).toContain('application/json');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json()).toMatchObject({ error });
    });

    it('refuses a code redeemed by another client', async () => {
        const board = await start();
        await board.world.store.upsertClient({
            clientId: 'second-client',
            kind: 'dcr',
            name: 'Second',
            redirectUris: [REDIRECT],
        });
        const code = await approveCode(board);
        const stolen = await tokenRequest(board, codeForm(board, code, { client_id: 'second-client' }));
        expect(stolen.json()).toMatchObject({ error: 'invalid_grant' });
        const owner = await tokenRequest(board, codeForm(board, code));
        expect(owner.json()).toMatchObject({ error: 'invalid_grant' });
    });

    it('revokes the whole grant when a code is replayed', async () => {
        const board = await start();
        const code = await approveCode(board);
        const first = (await tokenRequest(board, codeForm(board, code))).json() as TokenBody;
        const replay = await tokenRequest(board, codeForm(board, code));
        expect(replay.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(replay.json()).toMatchObject({ error: 'invalid_grant' });
        expect(await live(board, first.access_token)).toBeNull();
    });

    it('answers 503, never invalid_grant, when the exchange could not be confirmed', async () => {
        const board = await start({
            oauth: (real) => ({
                ...real,
                consumeCode: async () => {
                    throw new Error('connection reset');
                },
            }),
        });
        const response = await tokenRequest(board, codeForm(board, await approveCode(board)));
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(response.json()).toMatchObject({ error: 'temporarily_unavailable' });
    });

    it('rotates a refresh token, and a reused one ends the family', async () => {
        const board = await start();
        const first = await issue(board);
        const rotated = await tokenRequest(board, refreshForm(board, first.refresh_token));
        expect(rotated.statusCode).toBe(HTTP_OK);
        const second = rotated.json() as TokenBody;
        expect(second.access_token).not.toBe(first.access_token);
        expect(second.refresh_token).not.toBe(first.refresh_token);
        expect(await live(board, second.access_token)).not.toBeNull();

        const reuse = await tokenRequest(board, refreshForm(board, first.refresh_token));
        expect(reuse.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(reuse.json()).toMatchObject({ error: 'invalid_grant' });
        expect(await live(board, second.access_token)).toBeNull();
    });

    it('narrows scopes on refresh against the presented token, never widens', async () => {
        const board = await start();
        const first = await issue(board, { scope: 'factory:read factory:write' });
        const wider = await tokenRequest(
            board,
            refreshForm(board, first.refresh_token, { scope: 'factory:read admin' })
        );
        expect(wider.json()).toMatchObject({ error: 'invalid_scope' });
        const narrowed = await tokenRequest(board, refreshForm(board, first.refresh_token, { scope: 'factory:read' }));
        expect(narrowed.statusCode).toBe(HTTP_OK);
        const second = narrowed.json() as TokenBody;
        expect(second.scope).toBe('factory:read');
        const regrow = await tokenRequest(
            board,
            refreshForm(board, second.refresh_token, { scope: 'factory:read factory:write' })
        );
        expect(regrow.json()).toMatchObject({ error: 'invalid_scope' });
    });

    it('refuses a refresh for another resource and leaves the grant usable', async () => {
        const board = await start();
        const first = await issue(board);
        const foreign = await tokenRequest(
            board,
            refreshForm(board, first.refresh_token, { resource: 'https://other.example/api/mcp' })
        );
        expect(foreign.json()).toMatchObject({ error: 'invalid_target' });
        expect((await tokenRequest(board, refreshForm(board, first.refresh_token))).statusCode).toBe(HTTP_OK);
    });

    it('refuses a refresh token presented by another client', async () => {
        const board = await start();
        await board.world.store.upsertClient({
            clientId: 'second-client',
            kind: 'dcr',
            name: 'Second',
            redirectUris: [REDIRECT],
        });
        const first = await issue(board);
        const response = await tokenRequest(
            board,
            refreshForm(board, first.refresh_token, { client_id: 'second-client' })
        );
        expect(response.json()).toMatchObject({ error: 'invalid_grant' });
    });
});

describe.skipIf(!enabled)('POST /api/oauth/revoke', () => {
    const revoke = (board: Board, form: Record<string, string | undefined>) => tokenRequest(board, form, REVOKE);

    it('ends the family when a refresh token is revoked, and answers 200 with no body', async () => {
        const board = await start();
        const issued = await issue(board);
        const response = await revoke(board, { token: issued.refresh_token, client_id: board.world.clientId });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.body).toBe('');
        expect(await live(board, issued.access_token)).toBeNull();
        const refresh = await tokenRequest(board, refreshForm(board, issued.refresh_token));
        expect(refresh.json()).toMatchObject({ error: 'invalid_grant' });
    });

    it('ends only the access token when an access token is revoked', async () => {
        const board = await start();
        const issued = await issue(board);
        await revoke(board, { token: issued.access_token, client_id: board.world.clientId });
        expect(await live(board, issued.access_token)).toBeNull();
        expect((await tokenRequest(board, refreshForm(board, issued.refresh_token))).statusCode).toBe(HTTP_OK);
    });

    it('ignores a foreign client, an unknown token and a hint, and still answers 200', async () => {
        const board = await start();
        await board.world.store.upsertClient({
            clientId: 'second-client',
            kind: 'dcr',
            name: 'Second',
            redirectUris: [REDIRECT],
        });
        const issued = await issue(board);
        const foreign = await revoke(board, { token: issued.refresh_token, client_id: 'second-client' });
        expect(foreign.statusCode).toBe(HTTP_OK);
        expect(await live(board, issued.access_token)).not.toBeNull();
        const unknown = await revoke(board, {
            token: 'mrt_unknown',
            client_id: board.world.clientId,
            token_type_hint: 'access_token',
        });
        expect(unknown.statusCode).toBe(HTTP_OK);
    });

    it('refuses a request with no token or no client, and a revoke that could not be confirmed', async () => {
        const board = await start();
        expect((await revoke(board, { client_id: board.world.clientId })).json()).toMatchObject({
            error: 'invalid_request',
        });
        expect((await revoke(board, { token: 'x' })).json()).toMatchObject({ error: 'invalid_request' });
        const failing = await start({
            oauth: (real) => ({
                ...real,
                revoke: async () => {
                    throw new Error('connection reset');
                },
            }),
        });
        const response = await revoke(failing, { token: 'x', client_id: failing.world.clientId });
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
    });
});
