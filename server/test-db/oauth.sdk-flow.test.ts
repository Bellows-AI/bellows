import { createServer } from 'node:net';
import {
    Client,
    StreamableHTTPClientTransport,
    UnauthorizedError,
    type OAuthClientProvider,
} from '@modelcontextprotocol/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { hashToken } from '../src/auth/session.js';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import {
    APPROVE,
    REVOKE,
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
const LOCALHOST = '127.0.0.1';
const MODERN = '2026-07-28';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FOUND = 302;
const CALLBACK_PORT = 54321;

let sql: Sql;
beforeAll(() => {
    if (enabled) sql = db.sql;
});
const boards: Board[] = [];
afterEach(async () => {
    for (const board of boards.splice(0)) await board.app.close();
});

const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, LOCALHOST, () => {
            const address = probe.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            probe.close(() => resolve(port));
        });
    });

/** A public client that keeps its state in memory and hands the authorization URL to the test, which plays the browser. */
class MemoryProvider implements OAuthClientProvider {
    authorizationUrl: URL | undefined;
    private saved: Awaited<ReturnType<OAuthClientProvider['tokens']>>;
    private verifier = '';
    constructor(private readonly clientId: string) {}
    get redirectUrl() {
        return `http://${LOCALHOST}:${CALLBACK_PORT}/callback`;
    }
    get clientMetadata() {
        return {
            redirect_uris: [this.redirectUrl],
            client_name: 'Flow test',
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
        };
    }
    clientInformation() {
        return { client_id: this.clientId };
    }
    tokens() {
        return this.saved;
    }
    saveTokens(tokens: NonNullable<typeof this.saved>) {
        this.saved = tokens;
    }
    redirectToAuthorization(url: URL) {
        this.authorizationUrl = url;
    }
    saveCodeVerifier(verifier: string) {
        this.verifier = verifier;
    }
    codeVerifier() {
        return this.verifier;
    }
}

describe.skipIf(!enabled)('the MCP SDK client against the real authorization server', () => {
    it('401 -> discovery -> authorize -> consent -> token -> whoami -> revoke -> 401', async () => {
        const port = await freePort();
        const publicUrl = `http://${LOCALHOST}:${port}`;
        const board = await startBoard(sql, ORG, { publicUrl });
        boards.push(board);
        // A native client registers `http://127.0.0.1/callback` and uses whatever port it bound.
        await board.world.store.upsertClient({
            clientId: 'sdk-flow-client',
            kind: 'dcr',
            name: 'Flow test',
            redirectUris: ['http://127.0.0.1/callback'],
        });
        await board.app.listen({ port, host: LOCALHOST });
        const resource = new URL(board.world.resource);
        const provider = new MemoryProvider('sdk-flow-client');
        const connect = (): [Client, StreamableHTTPClientTransport] => [
            new Client({ name: 'flow', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } }),
            new StreamableHTTPClientTransport(resource, { authProvider: provider }),
        ];

        // 1. The unauthenticated connect is challenged and discovery leads to the authorization URL.
        const [first, firstTransport] = connect();
        await expect(first.connect(firstTransport)).rejects.toBeInstanceOf(UnauthorizedError);
        const authorizationUrl = provider.authorizationUrl;
        expect(authorizationUrl?.origin).toBe(publicUrl);
        expect(authorizationUrl?.pathname).toBe('/api/oauth/authorize');
        expect(authorizationUrl?.searchParams.get('resource')).toBe(board.world.resource);

        // 2. The browser: signed in, it lands on the consent page carrying the transaction.
        const authorized = await fetch(authorizationUrl as URL, {
            redirect: 'manual',
            headers: { cookie: board.cookie },
        });
        expect(authorized.status).toBe(HTTP_FOUND);
        const fragment = new URLSearchParams(new URL(String(authorized.headers.get('location'))).hash.slice(1));
        const transaction = { id: fragment.get('id'), csrf: fragment.get('csrf') };

        // 3. The member approves; the redirect to the client carries the code, its state and the issuer.
        const approved = await fetch(`${publicUrl}${APPROVE}`, {
            method: 'POST',
            headers: { cookie: board.cookie, 'content-type': 'application/json' },
            body: JSON.stringify(transaction),
        });
        expect(approved.status).toBe(HTTP_OK);
        const redirect = new URL(((await approved.json()) as { redirect: string }).redirect);
        expect(redirect.origin).toBe(`http://${LOCALHOST}:${CALLBACK_PORT}`);
        expect(redirect.searchParams.get('state')).toBe(authorizationUrl?.searchParams.get('state'));
        expect(redirect.searchParams.get('iss')).toBe(publicUrl);

        // 4. The SDK exchanges the code (form-encoded, PKCE), then calls a tool with the access token.
        await firstTransport.finishAuth(redirect.searchParams);
        const [second, secondTransport] = connect();
        await second.connect(secondTransport);
        const whoami = await second.callTool({ name: 'whoami', arguments: {} });
        expect(whoami.isError).toBeFalsy();
        expect(whoami.structuredContent).toMatchObject({
            account: { login: board.world.caller.user.login },
            organization: { id: ORG },
        });
        await second.close();

        // 5. Revoking the refresh token ends the grant: the access token is refused on the very next call.
        const tokens = provider.tokens();
        const revoked = await fetch(`${publicUrl}${REVOKE}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: tokens?.refresh_token ?? '', client_id: 'sdk-flow-client' }),
        });
        expect(revoked.status).toBe(HTTP_OK);
        const after = await fetch(resource, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${tokens?.access_token}`,
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        expect(after.status).toBe(HTTP_UNAUTHORIZED);
    });

    it('lets exactly one of two board replicas win a raced code exchange, and a raced refresh', async () => {
        const one = await startBoard(sql, ORG);
        const two = await startBoard(sql, ORG, { replicaOf: one });
        boards.push(one, two);

        const code = await approveCode(one);
        const [a, b] = await Promise.all([
            tokenRequest(one, codeForm(one, code)),
            tokenRequest(two, codeForm(one, code)),
        ]);
        expect([a.statusCode, b.statusCode].sort()).toEqual([HTTP_OK, HTTP_BAD_REQUEST]);
        // The loser's replay ended the grant, the winner's tokens included.
        const winner = (a.statusCode === HTTP_OK ? a : b).json() as TokenBody;
        expect(await one.world.store.findAccessToken(hashToken(winner.access_token))).toBeNull();

        const issued = (await tokenRequest(one, codeForm(one, await approveCode(one)))).json() as TokenBody;
        const refresh = {
            grant_type: 'refresh_token',
            refresh_token: issued.refresh_token,
            client_id: one.world.clientId,
        };
        const [c, d] = await Promise.all([tokenRequest(one, refresh), tokenRequest(two, refresh)]);
        expect([c.statusCode, d.statusCode].sort()).toEqual([HTTP_OK, HTTP_BAD_REQUEST]);
        const rotated = (c.statusCode === HTTP_OK ? c : d).json() as TokenBody;
        expect(await one.world.store.findAccessToken(hashToken(rotated.access_token))).toBeNull();
    });
});
