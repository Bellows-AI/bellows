import { githubRepo } from '@factory-ai/core';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildApp } from '../src/app.js';
import { createGitHubIdentityClient } from '../src/auth/github.js';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore } from '../src/auth/store.js';
import { createOrgOfJob, createOrgOfLease, createOrgOfReclaim } from '../src/db/jobs/job-store-org-resolvers.js';
import type { MemberForgeGrants } from '../src/integrations/member-forge-grant.js';
import { createOrgRegistry } from '../src/orgs.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { githubAuth, testConfig, testDriverCredentials } from '../test/helpers-config.js';
import { testSecretStore } from './env-secrets-harness.js';
import { type FakeGithub, startFakeGithub } from './fake-github.js';
import { randomGithubId, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import { memberGrantsOver } from './member-grant-rig.js';

/**
 * The kind lane's members (docs/executor-testing.md): each signs in through the board's real GitHub sign-in against
 * the fake GitHub, so the grant the forge start gate reads is stored the way a person's is. The real board, auth
 * store, member grants and identity client over a real database; only GitHub is the fake, in-process.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const run = promisify(execFile);
const CLIENT = new URL('../../scripts/publish-member-client.mjs', import.meta.url).pathname;
const CLIENT_TIMEOUT_MS = 90_000;
const CONFLICT = 409;
const OK_STATUSES = [200, 201, 202];
const REPO = 'factory-smoke/demo';
const db = useTestDb({ max: 12 });

let sql: Sql;
let fake: FakeGithub;
let secrets: SecretStore;
let app: FastifyInstance | undefined;
let board: string;

const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as { port: number };
            probe.close(() => resolve(port));
        });
    });

async function boot(grants: MemberForgeGrants | undefined): Promise<void> {
    const port = await freePort();
    board = `http://127.0.0.1:${port}`;
    const ready = Promise.resolve();
    const config = testConfig({
        auth: githubAuth({
            publicUrl: board,
            authorizeUrl: `${fake.base}/login/oauth/authorize`,
            tokenUrl: `${fake.base}/login/oauth/access_token`,
            userUrl: `${fake.base}/user`,
            apiUrl: fake.base,
        }),
        deploymentMode: 'cloud',
        platformModelProvided: true,
    });
    app = await buildApp({
        config,
        orgs: createOrgRegistry({ sql, ready, config, withStores: true, secrets, secretLog: () => {} }),
        auth: createAuthStore({ sql, ready }),
        orgOfLease: createOrgOfLease({ sql, ready }),
        orgOfJob: createOrgOfJob({ sql, ready }),
        orgOfReclaim: createOrgOfReclaim({ sql, ready }),
        driverCredentials: testDriverCredentials,
        identity: createGitHubIdentityClient(config.auth as Parameters<typeof createGitHubIdentityClient>[0]),
        ...(grants ? { memberGrants: grants } : {}),
        ready,
        version: '0.0.0',
    });
    await app.listen({ port, host: '127.0.0.1' });
}

interface Lane {
    login: string;
    org: string;
}
/** What `lane_member` does before it signs in: an org with a repo to select, and the identity registered at the fake. */
async function seed(): Promise<Lane> {
    const org = testOrg();
    const login = `lane-${randomUUID().slice(0, 8)}`;
    await sql`insert into organization (id, name) values (${org}, ${org}) on conflict do nothing`;
    await sql`insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen)
              values (${org}, 'claude-code', ${`lane-${randomUUID()}`}, ${REPO}, 'main', now(), now())`;
    const registered = await fake.control('github/members', {
        login,
        id: randomGithubId(),
        installation: { id: Number(org), account: login },
    });
    expect(registered.status).toBe(200);
    return { login, org };
}

const signIn = (lane: Lane) =>
    run('node', [CLIENT, board, lane.login], { timeout: CLIENT_TIMEOUT_MS }).then(({ stdout }) => stdout.trim());

const create = (token: string) =>
    app!.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${token}` },
        payload: { repo: githubRepo(REPO), command: 'work' },
    });

beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    fake = await startFakeGithub();
    secrets = testSecretStore(sql);
});

afterEach(async () => {
    if (!enabled) return;
    await app?.close();
    app = undefined;
    await fake.stop();
});

describe.skipIf(!enabled)('a kind lane member signs in through the fake GitHub', () => {
    it('signs two lane members in as themselves, each in their own org, with a live GitHub grant', async () => {
        const grants = memberGrantsOver({ sql, fake, secrets, tokenFetch: () => fetch });
        await boot(grants);
        const lanes = [await seed(), await seed()];
        const tokens = [await signIn(lanes[0]!), await signIn(lanes[1]!)];
        expect(new Set(tokens).size).toBe(2);
        for (const [i, lane] of lanes.entries()) {
            const me = await app!.inject({
                method: 'GET',
                url: '/api/auth/me',
                headers: { authorization: `Bearer ${tokens[i]}` },
            });
            expect(me.json()).toMatchObject({ user: { login: lane.login }, organization: { id: lane.org } });
            const [grant] = await sql<{ status: string; secret_ref: string | null }[]>`
                select g.status, g.secret_ref from integration_grant g join app_user u on u.id = g.principal_user_id
                where g.org_id = ${lane.org} and u.github_login = ${lane.login}`;
            expect(grant?.status).toBe('active');
            expect(grant?.secret_ref).toBeTruthy();
            const [user] = await sql<{ id: string }[]>`select id from app_user where github_login = ${lane.login}`;
            expect(await grants.accessToken(lane.org, user!.id, 'github')).toMatchObject({
                ok: true,
                accessToken: expect.stringMatching(/^ghu_fake/),
            });
            expect(OK_STATUSES).toContain((await create(tokens[i]!)).statusCode);
        }
    });

    it('fails loudly when the board kept no grant, naming the forge-grants answer', async () => {
        await boot(undefined);
        const lane = await seed();
        await expect(signIn(lane)).rejects.toMatchObject({
            code: 1,
            stderr: expect.stringContaining('/api/forge-grants'),
        });
    });

    it('refuses a member minted as rows alone: 409 FORGE_GRANT_REQUIRED naming github (the issue repro)', async () => {
        const grants = memberGrantsOver({ sql, fake, secrets, tokenFetch: () => fetch });
        await boot(grants);
        const lane = await seed();
        const caller = await createAuthStore({ sql }).signIn(
            { githubUserId: randomGithubId(), login: lane.login, displayName: lane.login, avatarUrl: null },
            lane.org,
            [{ id: lane.org, name: lane.login }]
        );
        const token = `fat_${randomUUID()}`;
        await createAuthStore({ sql }).createAccessToken({
            kind: 'personal',
            orgId: lane.org,
            userId: caller.user.id,
            createdBy: caller.user.id,
            label: 'rows',
            tokenHash: hashToken(token),
        });
        const res = await create(token);
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({ code: 'FORGE_GRANT_REQUIRED', forge: 'github', standing: 'missing' });
    });
});
