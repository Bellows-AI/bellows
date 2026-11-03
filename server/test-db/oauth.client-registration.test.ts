import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import { APPROVE, authorize, authorizeParams, startBoard, type Board } from './oauth-http-rig.js';
import { CALLBACK_PORT, LOCALHOST, MemoryProvider, freePort } from './oauth-sdk-rig.js';

const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });
const MODERN = '2026-07-28';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_FOUND = 302;
const CALLBACK = `http://${LOCALHOST}:${CALLBACK_PORT}/callback`;

let sql: Sql;
beforeAll(() => {
    if (enabled) sql = db.sql;
});
const boards: Board[] = [];
const servers: Server[] = [];
afterEach(async () => {
    for (const board of boards.splice(0)) await board.app.close();
    for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
});

/** The client's own server: a metadata document at a URL, which is the client's id. */
const serveDocument = async (document: (clientId: string) => unknown): Promise<string> => {
    const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(document(clientId)));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, LOCALHOST, done));
    const clientId = `http://${LOCALHOST}:${(server.address() as AddressInfo).port}/oauth/client.json`;
    return clientId;
};

const boardOnLoopback = async (): Promise<{ board: Board; publicUrl: string }> => {
    const port = await freePort();
    const publicUrl = `http://${LOCALHOST}:${port}`;
    const board = await startBoard(sql, ORG, { publicUrl });
    boards.push(board);
    await board.app.listen({ port, host: LOCALHOST });
    return { board, publicUrl };
};

/** 401 -> discovery -> authorize (the browser) -> consent -> token -> whoami, driven by the SDK. */
const connectThrough = async (board: Board, publicUrl: string, provider: MemoryProvider) => {
    const resource = new URL(board.world.resource);
    const connect = (): [Client, StreamableHTTPClientTransport] => [
        new Client({ name: 'flow', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } }),
        new StreamableHTTPClientTransport(resource, { authProvider: provider }),
    ];
    const [first, firstTransport] = connect();
    await expect(first.connect(firstTransport)).rejects.toBeInstanceOf(UnauthorizedError);
    const url = provider.authorizationUrl as URL;
    const authorized = await fetch(url, { redirect: 'manual', headers: { cookie: board.cookie } });
    expect(authorized.status).toBe(HTTP_FOUND);
    const fragment = new URLSearchParams(new URL(String(authorized.headers.get('location'))).hash.slice(1));
    const approved = await fetch(`${publicUrl}${APPROVE}`, {
        method: 'POST',
        headers: { cookie: board.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ id: fragment.get('id'), csrf: fragment.get('csrf') }),
    });
    expect(approved.status).toBe(HTTP_OK);
    const redirect = new URL(((await approved.json()) as { redirect: string }).redirect);
    expect(redirect.origin + redirect.pathname).toBe(CALLBACK);
    await firstTransport.finishAuth(redirect.searchParams);
    const [second, secondTransport] = connect();
    await second.connect(secondTransport);
    const whoami = await second.callTool({ name: 'whoami', arguments: {} });
    await second.close();
    return whoami;
};

describe.skipIf(!enabled)('client registration against the real authorization server', () => {
    it('a Client ID Metadata Document client: its id is the URL, fetched and kept as cimd', async () => {
        const { board, publicUrl } = await boardOnLoopback();
        const clientId = await serveDocument((id) => ({
            client_id: id,
            client_name: 'Document client',
            redirect_uris: ['http://127.0.0.1/callback', 'http://localhost/callback'],
            token_endpoint_auth_method: 'none',
        }));
        const whoami = await connectThrough(board, publicUrl, new MemoryProvider(clientId));
        expect(whoami.isError).toBeFalsy();
        expect(whoami.structuredContent).toMatchObject({ organization: { id: ORG } });
        const stored = await board.world.store.findClient(clientId);
        expect(stored).toMatchObject({ kind: 'cimd', name: 'Document client' });
        expect(stored?.fetchedAt).toBeInstanceOf(Date);
    });

    it('a document whose client_id is not its URL, or that omits the redirect, leaves the client unknown', async () => {
        const { board } = await boardOnLoopback();
        const liar = await serveDocument(() => ({
            client_id: 'http://127.0.0.1/elsewhere.json',
            redirect_uris: [CALLBACK],
        }));
        const narrow = await serveDocument((id) => ({ client_id: id, redirect_uris: ['http://127.0.0.1/other'] }));
        for (const clientId of [liar, narrow]) {
            const response = await authorize(
                board,
                authorizeParams(board, { client_id: clientId, redirect_uri: CALLBACK })
            );
            expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
            expect(response.headers.location).toBeUndefined();
        }
        expect(await board.world.store.findClient(liar)).toBeNull();
    });

    it('an unreachable document is an unknown client, shown to the user and never redirected', async () => {
        const { board } = await boardOnLoopback();
        const gone = `http://${LOCALHOST}:${await freePort()}/oauth/client.json`;
        const response = await authorize(board, authorizeParams(board, { client_id: gone, redirect_uri: CALLBACK }));
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.headers.location).toBeUndefined();
    });

    it('a Dynamic Client Registration client: the SDK registers itself, then runs the whole flow', async () => {
        const { board, publicUrl } = await boardOnLoopback();
        const provider = new MemoryProvider();
        const whoami = await connectThrough(board, publicUrl, provider);
        expect(whoami.isError).toBeFalsy();
        const clientId = provider.clientInformation()?.client_id ?? '';
        expect(clientId).toMatch(/^dcr_/);
        expect(await board.world.store.findClient(clientId)).toMatchObject({ kind: 'dcr', redirectUris: [CALLBACK] });
    });
});
