import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { run } from '../../cli/src/run.js';
import { buildApp } from '../src/app.js';
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
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import { APPROVE, BUILTIN, FORM, seedBuiltinClient } from './oauth-http-rig.js';
import { buildWorld, type OAuthWorld } from './oauth-rig.js';

/**
 * `bellows auth login` end to end: the CLI's own `run` against a listening board with MCP on, a
 * browser played by hand (authorize with the member's cookie, approve, follow the redirect into the
 * CLI's loopback listener), then the saved sign-in carrying the CLI's commands, rotating past
 * expiry, and ending on `bellows auth logout`.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });
const GRANTS = '/api/oauth/grants';
const HOUR_S = 3600;

let sql: Sql;
beforeAll(() => {
    if (enabled) sql = db.sql;
});
beforeEach(async () => {
    if (enabled) await seedBuiltinClient(sql);
});

interface Listening {
    app: FastifyInstance;
    url: string;
    world: OAuthWorld;
    cookie: string;
}
const boards: Listening[] = [];
afterEach(async () => {
    for (const board of boards.splice(0)) await board.app.close();
});

/** A free loopback port, so the board's PUBLIC_URL can be its own origin before it listens. */
const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address();
            probe.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject()));
        });
    });

/** The real app with a real job store, listening on loopback, its public URL its own origin. */
const listen = async (mcp = true): Promise<Listening> => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const world = await buildWorld(sql, ORG);
    world.resource = `${url}/api/mcp`;
    const auth = createAuthStore({ sql });
    const config = testConfig({
        auth: githubAuth({ publicUrl: url }),
        mcp: { enabled: mcp, resource: world.resource, trustedOrigins: [] },
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
        oauth: world.store,
    });
    await app.listen({ port, host: '127.0.0.1' });
    const board = { app, url, world, cookie: await signedIn(auth, world.caller) };
    boards.push(board);
    return board;
};

/** The member's browser: authorize with the session cookie, approve the consent, follow the redirect to the CLI. */
const browser = (board: Listening) => async (authorizeUrl: string) => {
    const authorized = await fetch(authorizeUrl, { headers: { cookie: board.cookie }, redirect: 'manual' });
    const fragment = new URLSearchParams(new URL(String(authorized.headers.get('location'))).hash.slice(1));
    const approved = await fetch(`${board.url}${APPROVE}`, {
        method: 'POST',
        headers: { cookie: board.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ id: fragment.get('id'), csrf: fragment.get('csrf') }),
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
    const { redirect } = (await approved.json()) as { redirect: string };
    await (await fetch(redirect)).text();
};

/** One CLI run against `board`, its clock at `now()`, its settings at `path`. */
async function cli(argv: string[], board: Listening, path: string, now: () => number) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, {
        env: { FACTORY_URL: board.url },
        settings: { path, explicit: false },
        now,
        sleep: async () => {},
        openBrowser: browser(board),
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
    });
    return { code, out: out.join(''), err: err.join('') };
}

const storedOAuth = (path: string) =>
    (JSON.parse(readFileSync(path, 'utf8')) as { oauth?: { accessToken: string; refreshToken: string } }).oauth;

const settingsPath = () => join(mkdtempSync(join(tmpdir(), 'cli-oauth-')), 'settings.json');

const grants = async (board: Listening) => {
    const response = await fetch(`${board.url}${GRANTS}`, { headers: { cookie: board.cookie } });
    return ((await response.json()) as { grants: unknown[] }).grants;
};

const refreshWith = (board: Listening, refreshToken: string) =>
    fetch(`${board.url}/api/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': FORM },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: BUILTIN,
        }).toString(),
    });

describe.skipIf(!enabled)('bellows auth login against a real board', () => {
    it('saves the sign-in at 0600, acts as the member, and rotates the pair past expiry', async () => {
        const board = await listen();
        const path = settingsPath();
        let now = Date.now();

        const login = await cli(['auth', 'login'], board, path, () => now);
        expect(login.code, login.err).toBe(0);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        const first = storedOAuth(path)!;
        expect(first.accessToken.startsWith('mat_')).toBe(true);

        const listed = await cli(['task', 'list', '--json'], board, path, () => now);
        expect(listed.code, listed.out).toBe(0);

        board.world.clock.advance(HOUR_S + 1);
        now += (HOUR_S + 1) * 1000;
        const again = await cli(['task', 'list', '--json'], board, path, () => now);
        expect(again.code, again.out).toBe(0);
        const rotated = storedOAuth(path)!;
        expect(rotated.refreshToken).not.toBe(first.refreshToken);
        expect(rotated.accessToken).not.toBe(first.accessToken);

        const replay = await refreshWith(board, first.refreshToken);
        expect(replay.status).toBe(400);
        expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
    });

    it('logout revokes the grant: the oauth entry is gone, its access token is 401, no grant is listed', async () => {
        const board = await listen();
        const path = settingsPath();
        const now = () => Date.now();
        expect((await cli(['auth', 'login'], board, path, now)).code).toBe(0);
        const signedIn = storedOAuth(path)!;
        expect(await grants(board)).toHaveLength(1);

        const logout = await cli(['auth', 'logout'], board, path, now);

        expect(logout.code, logout.err).toBe(0);
        expect(storedOAuth(path)).toBeUndefined();
        const after = await fetch(`${board.url}/api/tasks`, {
            headers: { authorization: `Bearer ${signedIn.accessToken}` },
        });
        expect(after.status).toBe(401);
        expect(await grants(board)).toEqual([]);
    });

    it('a board with MCP off refuses the sign-in before a browser opens', async () => {
        const board = await listen(false);
        const path = settingsPath();
        let opened = false;
        const out: string[] = [];
        const err: string[] = [];

        const code = await run(['auth', 'login'], {
            env: { FACTORY_URL: board.url },
            settings: { path, explicit: false },
            openBrowser: async () => {
                opened = true;
            },
            stdout: (text) => out.push(text),
            stderr: (text) => err.push(text),
        });

        expect(code).toBe(1);
        expect(err.join('')).toMatch(/no OAuth sign-in/);
        expect(opened).toBe(false);
    });
});
