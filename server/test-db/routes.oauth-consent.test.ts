import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { hashToken } from '../src/auth/session.js';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import { REDIRECT } from './oauth-rig.js';
import {
    APPROVE,
    DENY,
    FORM,
    STATE,
    codeForm,
    decide,
    otherMember,
    startBoard,
    startConsent,
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
const HTTP_NOT_FOUND = 404;
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;
const CONSENT_TTL_SECONDS = 600;

let sql: Sql;
beforeAll(() => {
    if (enabled) sql = db.sql;
});
const boards: Board[] = [];
afterEach(async () => {
    for (const board of boards.splice(0)) await board.app.close();
});
const start = async () => {
    const board = await startBoard(sql, ORG);
    boards.push(board);
    return board;
};
const redirectOf = (response: { json: () => unknown }): URL =>
    new URL((response.json() as { redirect: string }).redirect);

describe.skipIf(!enabled)('the consent transaction API', () => {
    it('shows the session owner what is being asked, and no one else', async () => {
        const board = await start();
        const tx = await startConsent(board);
        const own = await board.app.inject({
            method: 'GET',
            url: `/api/oauth/consent/${tx.id}`,
            headers: { cookie: board.cookie },
        });
        expect(own.statusCode).toBe(HTTP_OK);
        expect(own.json()).toMatchObject({
            client: { id: board.world.clientId, name: 'Test client' },
            scopes: ['factory:read'],
            redirectUri: REDIRECT,
            organization: { id: ORG },
        });
        expect(own.body).not.toContain(tx.csrf);

        const other = await otherMember(board);
        for (const cookie of [other.cookie, undefined]) {
            const response = await board.app.inject({
                method: 'GET',
                url: `/api/oauth/consent/${tx.id}`,
                headers: cookie ? { cookie } : {},
            });
            expect(response.statusCode).toBe(cookie ? HTTP_NOT_FOUND : HTTP_UNAUTHORIZED);
        }
        const unknown = await board.app.inject({
            method: 'GET',
            url: '/api/oauth/consent/nope',
            headers: { cookie: board.cookie },
        });
        expect(unknown.statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('approves once: a code lands on the frozen redirect with state and iss, and it exchanges for the frozen scopes', async () => {
        const board = await start();
        const tx = await startConsent(board);
        // Nothing but the id and the CSRF value is read from the body; a tampered scope, redirect or org is ignored.
        const approved = await decide(board, APPROVE, {
            ...tx,
            scope: 'factory:read factory:write',
            redirect_uri: 'https://evil.example/cb',
            org: 'other-org',
        });
        expect(approved.statusCode).toBe(HTTP_OK);
        const redirect = redirectOf(approved);
        expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
        expect(redirect.searchParams.get('state')).toBe(STATE);
        expect(redirect.searchParams.get('iss')).toBe(new URL(board.world.resource).origin);
        const code = redirect.searchParams.get('code') ?? '';
        const token = await tokenRequest(board, codeForm(board, code));
        expect(token.statusCode).toBe(HTTP_OK);
        expect((token.json() as TokenBody).scope).toBe('factory:read');
        const found = await board.world.store.findAccessToken(hashToken((token.json() as TokenBody).access_token));
        expect(found).toMatchObject({ clientId: board.world.clientId, scopes: ['factory:read'] });
        expect(found?.org.id).toBe(ORG);
        expect(found?.user.id).toBe(board.world.caller.user.id);

        const again = await decide(board, APPROVE, tx);
        expect(again.statusCode).toBe(HTTP_BAD_REQUEST);
    });

    it('refuses a missing or wrong CSRF value without spending the transaction', async () => {
        const board = await start();
        const tx = await startConsent(board);
        for (const payload of [
            { id: tx.id },
            { id: tx.id, csrf: 'wrong' },
            { csrf: tx.csrf },
            { id: tx.id, csrf: 7 },
        ]) {
            const response = await decide(board, APPROVE, payload);
            expect(response.statusCode, JSON.stringify(payload)).toBe(HTTP_BAD_REQUEST);
        }
        expect((await decide(board, APPROVE, tx)).statusCode).toBe(HTTP_OK);
    });

    it('refuses another member holding the right id and CSRF value, and a request with no session', async () => {
        const board = await start();
        const tx = await startConsent(board);
        const other = await otherMember(board);
        expect((await decide(board, APPROVE, tx, other.cookie)).statusCode).toBe(HTTP_BAD_REQUEST);
        expect((await decide(board, APPROVE, tx, null)).statusCode).toBe(HTTP_UNAUTHORIZED);
        expect((await decide(board, APPROVE, tx)).statusCode).toBe(HTTP_OK);
    });

    it('refuses an expired transaction', async () => {
        const board = await start();
        const tx = await startConsent(board);
        board.world.clock.advance(CONSENT_TTL_SECONDS + 1);
        expect((await decide(board, APPROVE, tx)).statusCode).toBe(HTTP_BAD_REQUEST);
    });

    it('refuses once the membership was removed', async () => {
        const board = await start();
        const tx = await startConsent(board);
        await sql`delete from org_membership where org_id = ${ORG} and user_id = ${board.world.caller.user.id}`;
        expect((await decide(board, APPROVE, tx)).statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('is refused to a bearer credential: an MCP token or a personal token never approves', async () => {
        const board = await start();
        const tx = await startConsent(board);
        for (const authorization of ['Bearer mat_whatever-token-value', 'Bearer fat_whatever-token-value']) {
            const response = await board.app.inject({
                method: 'POST',
                url: APPROVE,
                payload: tx,
                headers: { authorization },
            });
            expect(response.statusCode, authorization).toBe(HTTP_UNAUTHORIZED);
        }
    });

    it('answers a form post 415: only JSON, so a cross-site form cannot reach it', async () => {
        const board = await start();
        const tx = await startConsent(board);
        const response = await board.app.inject({
            method: 'POST',
            url: APPROVE,
            headers: { cookie: board.cookie, 'content-type': FORM },
            payload: `id=${tx.id}&csrf=${tx.csrf}`,
        });
        expect(response.statusCode).toBe(HTTP_UNSUPPORTED_MEDIA_TYPE);
    });

    it('denies with access_denied, state and iss, and issues no code', async () => {
        const board = await start();
        const tx = await startConsent(board);
        const denied = await decide(board, DENY, tx);
        expect(denied.statusCode).toBe(HTTP_OK);
        const redirect = redirectOf(denied);
        expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
        expect(redirect.searchParams.get('error')).toBe('access_denied');
        expect(redirect.searchParams.get('state')).toBe(STATE);
        expect(redirect.searchParams.get('iss')).toBe(new URL(board.world.resource).origin);
        expect(redirect.searchParams.get('code')).toBeNull();
        expect((await decide(board, APPROVE, tx)).statusCode).toBe(HTTP_BAD_REQUEST);
        const rows = await sql`select 1 from oauth_authorization_code where client_id = ${board.world.clientId}`;
        expect(rows).toHaveLength(0);
    });

    it('keeps the client query on a registered redirect and sets the code beside it', async () => {
        const board = await start();
        await board.world.store.upsertClient({
            clientId: 'query-client',
            kind: 'dcr',
            name: 'Query',
            redirectUris: ['https://client.example.test/cb?tenant=a'],
        });
        const tx = await startConsent(board, {
            client_id: 'query-client',
            redirect_uri: 'https://client.example.test/cb?tenant=a',
        });
        const redirect = redirectOf(await decide(board, APPROVE, tx));
        expect(redirect.searchParams.get('tenant')).toBe('a');
        expect(redirect.searchParams.get('code')).not.toBeNull();
    });
});
