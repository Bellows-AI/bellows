import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildApp } from '../src/app.js';
import { createOAuthStore, type OAuthStore } from '../src/auth/oauth-store.js';
import { createAuthStore, type AuthStore, type Caller } from '../src/auth/store.js';
import {
    githubAuth,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
} from '../test/helpers.js';
import { randomGithubId } from './fixtures.js';
import { buildWorld, pkceChallenge, REDIRECT, VERIFIER, type OAuthWorld } from './oauth-rig.js';

export const PUBLIC_URL = 'http://127.0.0.1:8080';
export const RESOURCE = `${PUBLIC_URL}/api/mcp`;
export const AUTHORIZE = '/api/oauth/authorize';
export const TOKEN = '/api/oauth/token';
export const REVOKE = '/api/oauth/revoke';
export const APPROVE = '/api/oauth/consent/approve';
export const DENY = '/api/oauth/consent/deny';
export const FORM = 'application/x-www-form-urlencoded';
export const STATE = 'client-state-123';

export interface Board {
    app: FastifyInstance;
    world: OAuthWorld;
    auth: AuthStore;
    cookie: string;
    sql: Sql;
}

/** The real app over a disposable database: real auth store, real OAuth store, one org, one signed-in member. */
export const startBoard = async (
    sql: Sql,
    orgId: string,
    options: { oauth?: (real: OAuthStore) => OAuthStore; publicUrl?: string; replicaOf?: Board } = {}
): Promise<Board> => {
    // A replica serves the same world from its own store instance over the same database.
    const world = options.replicaOf
        ? { ...options.replicaOf.world, store: createOAuthStore({ sql, now: options.replicaOf.world.clock.now }) }
        : await buildWorld(sql, orgId);
    const publicUrl = options.publicUrl ?? PUBLIC_URL;
    world.resource = `${publicUrl}/api/mcp`;
    const auth = createAuthStore({ sql });
    const config = testConfig({
        auth: githubAuth({ publicUrl }),
        mcp: { enabled: true, resource: world.resource, trustedOrigins: [] },
    });
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, telemetry: stubTelemetryClient(), orgsFor: [orgId] }),
        store: telemetryStoreStub(),
        auth,
        oauth: options.oauth ? options.oauth(world.store) : world.store,
    });
    return { app, world, auth, cookie: options.replicaOf?.cookie ?? (await signedIn(auth, world.caller)), sql };
};

/** A second member of the same org, signed in separately. */
export const otherMember = async (board: Board): Promise<{ caller: Caller; cookie: string }> => {
    const caller = await board.auth.signIn(
        { githubUserId: randomGithubId(), login: `other-${board.world.orgId}`, displayName: null, avatarUrl: null },
        board.world.orgId,
        [{ id: board.world.orgId, name: board.world.orgId }]
    );
    return { caller, cookie: await signedIn(board.auth, caller) };
};

export const authorizeParams = (board: Board, overrides: Record<string, string | undefined> = {}): URLSearchParams => {
    const base: Record<string, string | undefined> = {
        response_type: 'code',
        client_id: board.world.clientId,
        redirect_uri: REDIRECT,
        code_challenge: pkceChallenge(VERIFIER),
        code_challenge_method: 'S256',
        scope: 'factory:read',
        state: STATE,
        resource: board.world.resource,
        ...overrides,
    };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(base)) if (value !== undefined) params.set(key, value);
    return params;
};

export const authorize = (board: Board, params: URLSearchParams, cookie: string | null = board.cookie) =>
    board.app.inject({
        method: 'GET',
        url: `${AUTHORIZE}?${params.toString()}`,
        headers: cookie ? { cookie } : {},
    });

/** Starts an authorization as the signed-in member and returns the consent transaction the redirect carries. */
export const startConsent = async (
    board: Board,
    overrides: Record<string, string | undefined> = {},
    cookie: string | null = board.cookie
): Promise<{ id: string; csrf: string }> => {
    const response = await authorize(board, authorizeParams(board, overrides), cookie);
    const hash = new URLSearchParams(new URL(String(response.headers.location)).hash.slice(1));
    const id = hash.get('id');
    const csrf = hash.get('csrf');
    if (response.statusCode !== 302 || !id || !csrf) {
        throw new Error(`expected a consent redirect, got ${response.statusCode} ${response.body}`);
    }
    return { id, csrf };
};

export const decide = (
    board: Board,
    path: string,
    payload: Record<string, unknown>,
    cookie: string | null = board.cookie
) => board.app.inject({ method: 'POST', url: path, payload, headers: cookie ? { cookie } : {} });

/** Approves a fresh consent and returns the authorization code the client's redirect carries. */
export const approveCode = async (
    board: Board,
    overrides: Record<string, string | undefined> = {}
): Promise<string> => {
    const tx = await startConsent(board, overrides);
    const approved = await decide(board, APPROVE, tx);
    const redirect = new URL((approved.json() as { redirect: string }).redirect);
    const code = redirect.searchParams.get('code');
    if (approved.statusCode !== 200 || !code)
        throw new Error(`expected a code, got ${approved.statusCode} ${approved.body}`);
    return code;
};

export const tokenRequest = (board: Board, form: Record<string, string | undefined>, path = TOKEN) => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) if (value !== undefined) body.set(key, value);
    return board.app.inject({ method: 'POST', url: path, headers: { 'content-type': FORM }, payload: body.toString() });
};

export const codeForm = (board: Board, code: string, overrides: Record<string, string | undefined> = {}) => ({
    grant_type: 'authorization_code',
    code,
    client_id: board.world.clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    ...overrides,
});

export interface TokenBody {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
}
