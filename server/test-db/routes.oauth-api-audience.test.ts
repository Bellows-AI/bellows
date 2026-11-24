import { githubRepo } from '@factory-ai/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { buildApp } from '../src/app.js';
import type { OAuthStore } from '../src/auth/oauth-store.js';
import { createAuthStore } from '../src/auth/store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import {
    githubAuth,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
} from '../test/helpers.js';
import { storeOutage } from '../test/helpers-outage.js';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import {
    API_RESOURCE,
    BUILTIN,
    CLI_REDIRECT,
    PUBLIC_URL,
    RESOURCE,
    REVOKE,
    approveCode,
    authorize,
    authorizeParams,
    cliLogin,
    cliParams,
    codeForm,
    otherMember,
    seedBuiltinClient,
    tokenRequest,
    type Board,
    type TokenBody,
} from './oauth-http-rig.js';
import { buildWorld, pkceChallenge, VERIFIER } from './oauth-rig.js';

/**
 * The built-in CLI client (`bellows-cli`) and the API audience it is bound to: an API-audience `mat_` acts as the
 * member's `fat_` on every route a `fat_` reaches, an MCP-audience one stays on `/api/mcp`, and each client may ask for
 * its own resource and scope only (docs/auth.md).
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });
const FULL = 'factory:full';

let sql: Sql;
beforeAll(() => {
    if (enabled) sql = db.sql;
});
beforeEach(async () => {
    if (enabled) await seedBuiltinClient(sql);
});
const boards: Board[] = [];
afterEach(async () => {
    for (const board of boards.splice(0)) await board.app.close();
});

/** The real app with a real job store, so task reads and writes answer as they do for a `fat_`. */
const start = async (
    options: { mcp?: boolean; operators?: number[]; oauth?: (real: OAuthStore) => OAuthStore } = {}
): Promise<Board> => {
    const world = await buildWorld(sql, ORG);
    world.resource = RESOURCE;
    const auth = createAuthStore({ sql });
    const config = testConfig({
        auth: githubAuth({ publicUrl: PUBLIC_URL }),
        mcp: { enabled: options.mcp ?? true, resource: RESOURCE, trustedOrigins: [] },
        operatorGithubIds: options.operators ?? [],
    });
    const app = await buildApp({
        config,
        orgs: staticRegistry({
            config,
            telemetry: stubTelemetryClient(),
            repos: staticRepoSource([{ owner: 'acme', name: 'web' }]),
            jobs: createJobStore({ sql, orgId: ORG }),
            orgsFor: [ORG],
        }),
        store: telemetryStoreStub(),
        auth,
        oauth: options.oauth ? options.oauth(world.store) : world.store,
    });
    const board = { app, world, auth, cookie: await signedIn(auth, world.caller), sql };
    boards.push(board);
    return board;
};

/** A grant minted in the store directly, for a shape the HTTP surface refuses to issue. */
const storeGrant = async (board: Board, scopes: string[], resource = API_RESOURCE): Promise<string> => {
    const { world } = board;
    const { code } = await world.store.createCode({
        clientId: BUILTIN,
        userId: world.caller.user.id,
        orgId: world.orgId,
        scopes,
        codeChallenge: pkceChallenge(VERIFIER),
        resource,
        redirectUri: CLI_REDIRECT,
    });
    const result = await world.store.consumeCode({
        code,
        clientId: BUILTIN,
        redirectUri: CLI_REDIRECT,
        resource,
        codeVerifier: VERIFIER,
    });
    if (!result.ok) throw new Error(`expected a grant, got ${result.error}`);
    return result.accessToken;
};

/** `route` is `METHOD url`, called with the token as the bearer. */
const rest = (board: Board, route: string, token: string, payload?: object) => {
    const [method, url] = route.split(' ') as ['GET' | 'POST', string];
    return board.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload ? { payload } : {}),
    });
};

const refusedWith = (response: { statusCode: number; headers: Record<string, unknown> }) => {
    expect(response.statusCode).toBe(302);
    return new URL(String(response.headers.location)).searchParams.get('error');
};

const setRole = (board: Board, userId: string, role: 'admin' | 'member') =>
    sql`update org_membership set role = ${role} where org_id = ${board.world.orgId} and user_id = ${userId}`;

describe.skipIf(!enabled)('the built-in CLI client and the API audience', () => {
    it('builtin client completes authorize, consent and token', async () => {
        const board = await start();
        const pair = await cliLogin(board);
        expect(pair.access_token.startsWith('mat_')).toBe(true);
        expect(pair.refresh_token.startsWith('mrt_')).toBe(true);
        expect(pair.scope).toBe(FULL);
        const families = await sql<{ resource: string; scopes: string[] }[]>`
            select resource, scopes from oauth_grant_family
            where client_id = ${BUILTIN} and user_id = ${board.world.caller.user.id}
        `;
        expect(families).toEqual([{ resource: API_RESOURCE, scopes: [FULL] }]);
    });

    it('API mat_ acts as the member', async () => {
        const board = await start();
        await setRole(board, board.world.caller.user.id, 'admin');
        const { access_token: token } = await cliLogin(board);

        expect((await rest(board, 'GET /api/tasks', token)).statusCode).toBe(200);
        const created = await rest(board, 'POST /api/jobs', token, {
            command: 'echo hi',
            repo: githubRepo('acme/web'),
        });
        expect(created.statusCode).toBe(201);
        // Class `none` is not refused: the API audience is not scope-checked.
        expect((await rest(board, 'GET /api/tokens', token)).statusCode).toBe(200);
        const minted = await rest(board, 'POST /api/tokens', token, { label: 'from-cli' });
        expect(minted.statusCode).toBe(201);
        const fat = (minted.json() as { token: string }).token;
        expect(fat.startsWith('fat_')).toBe(true);
        expect((await rest(board, 'GET /api/tasks', fat)).statusCode).toBe(200);

        // The role still applies: a member's API token is refused on an admin row.
        const member = await otherMember(board);
        await setRole(board, member.caller.user.id, 'member');
        const memberToken = (await cliLogin(board, member.cookie)).access_token;
        const adminRow = await rest(board, 'GET /api/tokens/org', memberToken);
        expect(adminRow.statusCode).toBe(403);
        expect(adminRow.json()).toMatchObject({ error: 'Only an organization admin can do this' });

        // An operator row is refused unless the account is named in OPERATOR_GITHUB_IDS.
        expect((await rest(board, 'GET /api/operator/orgs', token)).statusCode).toBe(403);
        const operatorBoard = await start({ operators: [] });
        const operatorToken = (await cliLogin(operatorBoard)).access_token;
        await operatorBoard.app.close();
        boards.pop();
        const named = await start({ operators: [operatorBoard.world.caller.user.githubUserId] });
        const asOperator = await rest(named, 'GET /api/operator/orgs', operatorToken);
        expect([401, 403]).not.toContain(asOperator.statusCode);
    });

    it('API mat_ is accepted on the branch and ingest routes, as a fat_ is', async () => {
        const board = await start();
        const { access_token: token } = await cliLogin(board);
        const fat = ((await rest(board, 'POST /api/tokens', token, { label: 'twin' })).json() as { token: string })
            .token;
        for (const url of ['/api/sessions/branch', '/api/otlp/v1/logs']) {
            const asMat = await rest(board, `POST ${url}`, token, {});
            const asFat = await rest(board, `POST ${url}`, fat, {});
            expect(asMat.statusCode).not.toBe(401);
            expect(asMat.statusCode).toBe(asFat.statusCode);
        }
    });

    it('API mat_ is 401 on /api/mcp', async () => {
        const board = await start();
        const { access_token: token } = await cliLogin(board);
        const response = await board.app.inject({
            method: 'POST',
            url: '/api/mcp',
            headers: {
                authorization: `Bearer ${token}`,
                host: new URL(PUBLIC_URL).host,
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
            },
            payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        });
        expect(response.statusCode).toBe(401);
    });

    // A regression guard: this passes before the API audience exists, and must keep passing after it.
    it('MCP mat_ is 401 on REST routes', async () => {
        const board = await start();
        const code = await approveCode(board, { scope: 'factory:read factory:write' });
        const { access_token: token } = (await tokenRequest(board, codeForm(board, code))).json() as TokenBody;
        expect((await rest(board, 'GET /api/tasks', token)).statusCode).toBe(401);
        expect((await rest(board, 'GET /api/tokens', token)).statusCode).toBe(401);
        expect((await rest(board, 'POST /api/sessions/branch', token, {})).statusCode).toBe(401);
    });

    it('builtin client asking for the MCP resource or factory:read is refused', async () => {
        const board = await start();
        const mcp = await authorize(board, authorizeParams(board, { ...cliParams, resource: RESOURCE }));
        expect(refusedWith(mcp)).toBe('invalid_target');
        const read = await authorize(board, authorizeParams(board, { ...cliParams, scope: 'factory:read' }));
        expect(refusedWith(read)).toBe('invalid_scope');
    });

    it('DCR client asking for the API resource or factory:full is refused', async () => {
        const board = await start();
        const api = await authorize(board, authorizeParams(board, { resource: API_RESOURCE }));
        expect(refusedWith(api)).toBe('invalid_target');
        const full = await authorize(board, authorizeParams(board, { scope: FULL }));
        expect(refusedWith(full)).toBe('invalid_scope');
    });

    it('an API-audience token without factory:full is 401', async () => {
        const board = await start();
        const token = await storeGrant(board, ['factory:read', 'factory:write']);
        expect((await rest(board, 'GET /api/tasks', token)).statusCode).toBe(401);
    });

    it("MCP off: the builtin client's authorize is 404 and an API mat_ is 401 on REST", async () => {
        const board = await start({ mcp: false });
        const response = await authorize(board, authorizeParams(board, cliParams));
        expect(response.statusCode).toBe(404);
        const token = await storeGrant(board, [FULL]);
        expect((await rest(board, 'GET /api/tasks', token)).statusCode).toBe(401);
    });

    it('refresh rotates within the API resource; the spent refresh is invalid_grant and ends REST access', async () => {
        const board = await start();
        const first = await cliLogin(board);
        const rotated = await tokenRequest(board, {
            grant_type: 'refresh_token',
            refresh_token: first.refresh_token,
            client_id: BUILTIN,
        });
        expect(rotated.statusCode).toBe(200);
        const second = rotated.json() as TokenBody;
        expect(second.scope).toBe(FULL);
        expect((await rest(board, 'GET /api/tasks', second.access_token)).statusCode).toBe(200);

        const replay = await tokenRequest(board, {
            grant_type: 'refresh_token',
            refresh_token: first.refresh_token,
            client_id: BUILTIN,
        });
        expect(replay.statusCode).toBe(400);
        expect(replay.json()).toMatchObject({ error: 'invalid_grant' });
        expect((await rest(board, 'GET /api/tasks', second.access_token)).statusCode).toBe(401);
    });

    it('revoke with the refresh token ends REST access', async () => {
        const board = await start();
        const pair = await cliLogin(board);
        expect((await rest(board, 'GET /api/tasks', pair.access_token)).statusCode).toBe(200);
        const revoked = await tokenRequest(board, { token: pair.refresh_token, client_id: BUILTIN }, REVOKE);
        expect(revoked.statusCode).toBe(200);
        expect((await rest(board, 'GET /api/tasks', pair.access_token)).statusCode).toBe(401);
    });

    it("/api/auth/me with an API mat_ answers the caller with scopes 'all'", async () => {
        const board = await start();
        const { access_token: token } = await cliLogin(board);
        const me = await rest(board, 'GET /api/auth/me', token);
        expect(me.statusCode).toBe(200);
        expect(me.json()).toMatchObject({
            authenticated: true,
            user: { login: board.world.caller.user.login },
            scopes: 'all',
        });
    });

    it('findAccessToken throwing on a REST mat_ is 503, never 401', async () => {
        const board = await start({
            oauth: (real) => ({
                ...real,
                findAccessToken: async () => {
                    throw storeOutage();
                },
            }),
        });
        const response = await rest(board, 'GET /api/tasks', 'mat_unanswerable-0123456789');
        expect(response.statusCode).toBe(503);
    });
});
