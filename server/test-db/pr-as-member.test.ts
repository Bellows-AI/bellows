import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildApp } from '../src/app.js';
import { createAuthStore } from '../src/auth/store.js';
import { createOrgOfJob, createOrgOfLease, createOrgOfReclaim } from '../src/db/jobs/job-store-org-resolvers.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { createPrWriter, type PrWriter } from '../src/github/pr-write.js';
import type { MintedToken } from '../src/github/app-token.js';
import type { MemberForgeGrants } from '../src/integrations/member-forge-grant.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { LOCAL_ORG_ID } from '../src/identifiers.js';
import { createOrgRegistry } from '../src/orgs.js';
import { githubAuth, TEST_DRIVER_CREDENTIAL, testConfig, testDriverCredentials } from '../test/helpers-config.js';
import { testSecretStore } from './env-secrets-harness.js';
import { type FakeGithub, startFakeGithub } from './fake-github.js';
import { expireLease, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import { memberGrantsOver, signMemberIn as signMemberInAs } from './member-grant-rig.js';

/**
 * The board writes the task's PR as the acting member (docs/connections.md): `POST /api/jobs/:id/pull-request` on a real
 * database, the real member-grant reader and lineage, and the fake GitHub as the API and the token endpoint. The
 * route's answer holds no token, a broken grant waits and never fails, and an answer that is not confirmed is a 503.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const AUTHOR = testUser('pr-author');
const REPO = 'acme/widgets';
const LEASE_SECONDS = 300;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;
const ASK = { branch: 'task/one', base: 'main', create: { title: 'Fix it', body: 'Body', draft: false, base: 'main' } };
const db = useTestDb({ orgs: [ORG, LOCAL_ORG_ID], users: [AUTHOR], max: 12 });

let sql: Sql;
let jobs: JobStore;
let fake: FakeGithub;
let app: FastifyInstance | undefined;
/** The token endpoint's fetch: delegates to the real one unless a test swaps it. */
let tokenFetch: typeof fetch;
let secrets: SecretStore;

beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    jobs = createJobStore({ sql, orgId: ORG });
    fake = await startFakeGithub();
    tokenFetch = fetch;
    secrets = testSecretStore(sql);
    for (const org of [ORG, LOCAL_ORG_ID]) {
        await sql`insert into org_membership (org_id, github_login, user_id) values (${org}, ${AUTHOR.login}, ${AUTHOR.id})
                  on conflict do nothing`;
    }
});

afterEach(async () => {
    if (!enabled) return;
    await app?.close();
    app = undefined;
    await fake.stop();
});

/** The grants reader as main.ts composes it, its refresh going through `tokenFetch` to the fake's token endpoint. */
const grantsOver = (store: SecretStore = secrets): MemberForgeGrants =>
    memberGrantsOver({ sql, fake, secrets: store, tokenFetch: () => tokenFetch });

const signMemberIn = (grants: MemberForgeGrants, options: { expiresIn?: number; refreshToken?: string } = {}) =>
    signMemberInAs({ grants, fake, orgId: ORG, user: AUTHOR }, options);

interface BootOptions {
    grants?: MemberForgeGrants | undefined;
    writer?: PrWriter | undefined;
    mint?: (() => Promise<MintedToken | null>) | undefined;
    github?: boolean;
}

async function boot({ grants, writer, mint, github = true }: BootOptions): Promise<FastifyInstance> {
    const ready = Promise.resolve();
    const config = testConfig(github ? { auth: githubAuth() } : {});
    app = await buildApp({
        config,
        orgs: createOrgRegistry({ sql, ready, config, withStores: true, secrets, secretLog: () => {} }),
        auth: createAuthStore({ sql, ready }),
        orgOfLease: createOrgOfLease({ sql, ready }),
        orgOfJob: createOrgOfJob({ sql, ready }),
        orgOfReclaim: createOrgOfReclaim({ sql, ready }),
        driverCredentials: testDriverCredentials,
        ...(grants ? { memberGrants: grants } : {}),
        ...(writer ? { prWriter: writer } : {}),
        ...(mint ? { githubMint: mint } : {}),
        ready,
        version: '0.0.0',
    });
    return app;
}

const writerOver = (fetchFn: typeof fetch = fetch) => createPrWriter({ apiUrl: fake.base, fetchFn });

/** A running task of AUTHOR's under a live lease. */
async function running(board: JobStore = jobs): Promise<{ id: string; claim: Claim }> {
    const ref = await board.create('push the fix', AUTHOR.id, { repo: REPO, executor: null });
    if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
    const claim = (await board.claim('w1', LEASE_SECONDS)) as Claim;
    expect(claim.id).toBe(ref.id);
    return { id: ref.id, claim };
}

const ask = (instance: FastifyInstance, id: string, leaseToken: string, body: object = ASK) =>
    instance.inject({
        method: 'POST',
        url: `/api/jobs/${id}/pull-request`,
        headers: { authorization: `Bearer ${TEST_DRIVER_CREDENTIAL}`, 'content-type': 'application/json' },
        payload: { leaseToken, ...body },
    });

const creates = () => fake.calls().filter((c) => c.method === 'POST' && c.path === `/repos/${REPO}/pulls`);
const requirements = (rootId: string) =>
    sql<{ provider: string; target: string | null; reason: string; satisfied_at: Date | null }[]>`
        select provider, target, reason, satisfied_at from job_integration_requirement
        where root_job_id = ${rootId}`;
const grantStatus = async () =>
    (await sql<{ status: string }[]>`select status from integration_grant where org_id = ${ORG}`)[0]?.status;
const until = async (done: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await done()); i += 1) await new Promise((r) => setTimeout(r, 50));
};

describe.skipIf(!enabled)('POST /api/jobs/:id/pull-request — the member opens the PR', () => {
    it('creates the PR with the member token, and the answer holds no token', async () => {
        await signMemberIn(grantsOver());
        const instance = await boot({ grants: grantsOver(), writer: writerOver() });
        const { id, claim } = await running();
        const response = await ask(instance, id, claim.leaseToken);
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({
            answer: 'pr',
            operation: 'created',
            url: 'https://github.com/acme/widgets/pull/1',
            number: 1,
        });
        expect(creates().map((c) => c.tokenKind)).toEqual(['user']);
        expect((await fake.pulls()).map((p) => p.createdBy)).toEqual(['user']);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).not.toContain('ghu_');
        expect(JSON.stringify(response.headers)).not.toContain('ghu_');
    });

    it('creates a PR for a task with no claim base: create.base is the base, nothing is retargeted', async () => {
        await signMemberIn(grantsOver());
        const instance = await boot({ grants: grantsOver(), writer: writerOver() });
        const { id, claim } = await running();
        const response = await ask(instance, id, claim.leaseToken, { ...ASK, base: null });
        expect(response.json()).toMatchObject({ answer: 'pr', operation: 'created', number: 1 });
        expect(creates().map((c) => c.tokenKind)).toEqual(['user']);
        expect((await fake.pulls())[0]).toMatchObject({ base: { ref: 'main' }, createdBy: 'user' });
        expect(fake.calls().filter((c) => c.method === 'PATCH')).toEqual([]);
    });

    it('opens no duplicate when the same ask is replayed', async () => {
        await signMemberIn(grantsOver());
        const instance = await boot({ grants: grantsOver(), writer: writerOver() });
        const { id, claim } = await running();
        await ask(instance, id, claim.leaseToken);
        const replay = await ask(instance, id, claim.leaseToken);
        expect(replay.json()).toMatchObject({ answer: 'pr', operation: 'reused', number: 1 });
        expect(await fake.pulls()).toHaveLength(1);
    });

    it('opens no duplicate when the answer to the first create was lost', async () => {
        await signMemberIn(grantsOver());
        const instance = await boot({ grants: grantsOver(), writer: writerOver() });
        const { id, claim } = await running();
        writeFileSync(join(fake.stateDir, 'hold'), '');
        // over a real socket, so the abort is the driver's connection dropping while the create is parked
        const url = await instance.listen({ port: 0, host: '127.0.0.1' });
        const lost = new AbortController();
        const first = fetch(`${url}/api/jobs/${id}/pull-request`, {
            method: 'POST',
            headers: { authorization: `Bearer ${TEST_DRIVER_CREDENTIAL}`, 'content-type': 'application/json' },
            body: JSON.stringify({ leaseToken: claim.leaseToken, ...ASK }),
            signal: lost.signal,
        }).catch(() => null);
        await until(() => existsSync(join(fake.stateDir, 'hold.ready')));
        lost.abort();
        await first;
        writeFileSync(join(fake.stateDir, 'hold.go'), '');
        await until(async () => (await fake.pulls()).length === 1);
        const again = await ask(instance, id, claim.leaseToken);
        expect(again.json()).toMatchObject({ answer: 'pr', operation: 'reused', number: 1 });
        expect(await fake.pulls()).toHaveLength(1);
    });

    it('answers none to a view-only ask that finds no PR, and the PR to one that does', async () => {
        await signMemberIn(grantsOver());
        const instance = await boot({ grants: grantsOver(), writer: writerOver() });
        const { id, claim } = await running();
        const view = { branch: ASK.branch, base: ASK.base };
        expect((await ask(instance, id, claim.leaseToken, view)).json()).toEqual({ answer: 'none' });
        expect(creates()).toHaveLength(0);
        await ask(instance, id, claim.leaseToken);
        expect((await ask(instance, id, claim.leaseToken, view)).json()).toMatchObject({ answer: 'pr', number: 1 });
    });

    it('retargets an open PR on another base with the member token', async () => {
        await signMemberIn(grantsOver());
        const instance = await boot({ grants: grantsOver(), writer: writerOver() });
        const { id, claim } = await running();
        await ask(instance, id, claim.leaseToken);
        const moved = await ask(instance, id, claim.leaseToken, { ...ASK, base: 'release' });
        expect(moved.json()).toMatchObject({ answer: 'pr', operation: 'reused', number: 1 });
        const patches = fake.calls().filter((c) => c.method === 'PATCH');
        expect(patches.map((c) => c.tokenKind)).toEqual(['user']);
        expect((await fake.pulls())[0]?.base.ref).toBe('release');
    });

    it('edits the title and body of the existing PR with the member token', async () => {
        await signMemberIn(grantsOver());
        const instance = await boot({ grants: grantsOver(), writer: writerOver() });
        const { id, claim } = await running();
        await ask(instance, id, claim.leaseToken);
        const edited = await ask(instance, id, claim.leaseToken, {
            ...ASK,
            edit: { title: 'New title', body: 'New body' },
        });
        expect(edited.json()).toMatchObject({ answer: 'pr', operation: 'reused', number: 1 });
        const patches = fake.calls().filter((c) => c.method === 'PATCH');
        expect(patches.map((c) => c.tokenKind)).toEqual(['user']);
        expect((await fake.pulls())[0]).toMatchObject({ title: 'New title', body: 'New body' });
    });
});

describe.skipIf(!enabled)('POST /api/jobs/:id/pull-request — a grant that cannot serve', () => {
    it('waits on a broken grant: a forge requirement opens and no PR is created', async () => {
        await signMemberIn(grantsOver());
        await sql`update integration_grant set status = 'reconnect_required' where org_id = ${ORG}`;
        const instance = await boot({ grants: grantsOver(), writer: writerOver() });
        const { id, claim } = await running();
        const response = await ask(instance, id, claim.leaseToken);
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({ answer: 'waiting', forge: 'github', reason: 'reconnect' });
        expect(await requirements(id)).toEqual([
            { provider: 'forge', target: 'github', reason: 'reconnect', satisfied_at: null },
        ]);
        expect(creates()).toHaveLength(0);
    });

    it('waits on a missing grant with reason missing', async () => {
        const instance = await boot({ grants: grantsOver(), writer: writerOver() });
        const { id, claim } = await running();
        expect((await ask(instance, id, claim.leaseToken)).json()).toEqual({
            answer: 'waiting',
            forge: 'github',
            reason: 'missing',
        });
        expect((await requirements(id))[0]).toMatchObject({ provider: 'forge', reason: 'missing' });
        expect(creates()).toHaveLength(0);
    });

    it('answers 503 for a refresh that fails with a 5xx, leaving the grant active and no requirement', async () => {
        await signMemberIn(grantsOver(), { expiresIn: 1 });
        tokenFetch = async () => new Response('bad gateway', { status: 502 });
        const instance = await boot({ grants: grantsOver(), writer: writerOver() });
        const { id, claim } = await running();
        const response = await ask(instance, id, claim.leaseToken);
        expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
        expect(response.json()).toMatchObject({ code: 'UNAVAILABLE' });
        expect(await grantStatus()).toBe('active');
        expect(await requirements(id)).toEqual([]);
        expect(creates()).toHaveLength(0);
    });

    it('answers 503, never waiting, when the secret read throws', async () => {
        await signMemberIn(grantsOver());
        const throwing = new Proxy(secrets, {
            get: (target, property) =>
                property === 'readActive'
                    ? async () => {
                          throw new Error('secret store down');
                      }
                    : Reflect.get(target, property),
        });
        const instance = await boot({ grants: grantsOver(throwing), writer: writerOver() });
        const { id, claim } = await running();
        const response = await ask(instance, id, claim.leaseToken);
        expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
        expect(await requirements(id)).toEqual([]);
        expect(await grantStatus()).toBe('active');
    });

    it('opens no requirement when the lease was superseded during the grant read', async () => {
        // an unknown refresh token: the refresh breaks the grant, and the route would wait — on a lease that moved
        await signMemberIn(grantsOver(), { expiresIn: 1, refreshToken: 'ghr_unknown' });
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered: () => void = () => {};
        const reached = new Promise<void>((resolve) => {
            entered = resolve;
        });
        tokenFetch = async (input, init) => {
            entered();
            await gate;
            return fetch(input, init);
        };
        const instance = await boot({ grants: grantsOver(), writer: writerOver() });
        const { id, claim } = await running();
        const pending = ask(instance, id, claim.leaseToken);
        await reached;
        await expireLease(sql, id);
        expect(((await jobs.claim('w2', LEASE_SECONDS)) as Claim).id).toBe(id);
        release();
        const response = await pending;
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json()).toMatchObject({ code: 'LEASE_LOST' });
        expect(await requirements(id)).toEqual([]);
    });
});

describe.skipIf(!enabled)('POST /api/jobs/:id/pull-request — the attempt checks', () => {
    it('refuses a wrong lease with 409, an unknown job with 404 and a job that is not running with 409', async () => {
        await signMemberIn(grantsOver());
        const instance = await boot({ grants: grantsOver(), writer: writerOver() });
        const { id, claim } = await running();
        const wrong = await ask(instance, id, crypto.randomUUID());
        expect(wrong.statusCode).toBe(HTTP_CONFLICT);
        expect(wrong.json()).toMatchObject({ code: 'LEASE_LOST' });
        expect((await ask(instance, crypto.randomUUID(), claim.leaseToken)).statusCode).toBe(HTTP_NOT_FOUND);
        await sql`update job set status = 'succeeded', finished_at = now() where id = ${id}`;
        expect((await ask(instance, id, claim.leaseToken)).statusCode).toBe(HTTP_CONFLICT);
        expect(creates()).toHaveLength(0);
    });

    it('refuses a malformed ask', async () => {
        const instance = await boot({ grants: grantsOver(), writer: writerOver() });
        const { id, claim } = await running();
        const bad = [
            { ...ASK, branch: '' },
            { ...ASK, base: 5 },
            { ...ASK, create: { title: 't'.repeat(257), body: '', draft: false } },
            { ...ASK, create: { title: 't', body: 'b'.repeat(65_537), draft: false } },
            { ...ASK, create: { title: 't', body: 'b', draft: 'no' } },
            { ...ASK, edit: { title: 5 } },
        ];
        for (const body of bad) expect((await ask(instance, id, claim.leaseToken, body)).statusCode).toBe(400);
    });
});

describe.skipIf(!enabled)('POST /api/jobs/:id/pull-request — AUTH_MODE=none uses the installation', () => {
    // none mode has the one local org: the board's worker routes resolve it, whatever org the job names
    const local = () => createJobStore({ sql, orgId: LOCAL_ORG_ID });
    it('creates as the installation, reads no grant and never opens a requirement, even on a 403', async () => {
        const installation = await fake.installationToken();
        const mint = async (): Promise<MintedToken> => ({
            token: installation,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: {},
            repositories: [],
        });
        const instance = await boot({ writer: writerOver(), mint, github: false });
        const { id, claim } = await running(local());
        const response = await ask(instance, id, claim.leaseToken);
        expect(response.json()).toMatchObject({ answer: 'pr', operation: 'created' });
        expect(creates().map((c) => c.tokenKind)).toEqual(['installation']);

        const forbidden = writerOver(async (input, init) =>
            init?.method === 'POST'
                ? new Response('{"message":"Resource not accessible by integration"}', { status: 403 })
                : fetch(input, init)
        );
        await app?.close();
        const again = await boot({ writer: forbidden, mint, github: false });
        const second = await running(local());
        const denied = await ask(again, second.id, second.claim.leaseToken, { ...ASK, branch: 'task/two' });
        expect(denied.json()).toEqual({ answer: 'denied' });
        expect(await requirements(second.id)).toEqual([]);
    });

    it('answers 409 GITHUB_UNAVAILABLE when the board holds no forge at all', async () => {
        const instance = await boot({ github: false });
        const { id, claim } = await running(local());
        const response = await ask(instance, id, claim.leaseToken);
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json()).toMatchObject({ code: 'GITHUB_UNAVAILABLE' });
    });
});

describe.skipIf(!enabled)('POST /api/jobs/:id/pull-request — a member without write access waits', () => {
    const HTTP_UNAUTHORIZED = 401;
    const FORGE_ACCESS = { answer: 'waiting', forge: 'github', reason: 'forge-access' };
    const VIEW_ONLY = { branch: ASK.branch, base: ASK.base };
    /** The fake GitHub, except that a request `refused` matches is answered with `status`. */
    const answering = (status: number, refused: (init?: RequestInit) => boolean = (init) => init?.method === 'POST') =>
        writerOver(async (input, init) =>
            refused(init) ? new Response('{"message":"Not Found"}', { status }) : fetch(input, init)
        );

    it.each([HTTP_NOT_FOUND, HTTP_FORBIDDEN])(
        'answers waiting forge-access on a %s create, keeps the grant active and creates nothing',
        async (status) => {
            await signMemberIn(grantsOver());
            const instance = await boot({ grants: grantsOver(), writer: answering(status) });
            const { id, claim } = await running();

            const response = await ask(instance, id, claim.leaseToken);

            expect(response.statusCode).toBe(HTTP_OK);
            expect(response.json()).toEqual(FORGE_ACCESS);
            expect(await requirements(id)).toEqual([
                { provider: 'forge', target: 'github', reason: 'forge-access', satisfied_at: null },
            ]);
            expect(await grantStatus()).toBe('active');
            expect(await fake.pulls()).toEqual([]);
        }
    );

    it('answers waiting forge-access when the member cannot even see the repository on the view', async () => {
        await signMemberIn(grantsOver());
        const instance = await boot({
            grants: grantsOver(),
            writer: answering(HTTP_NOT_FOUND, (init) => init?.method !== 'POST'),
        });
        const { id, claim } = await running();

        const response = await ask(instance, id, claim.leaseToken, VIEW_ONLY);

        expect(response.json()).toEqual(FORGE_ACCESS);
        expect((await requirements(id))[0]).toMatchObject({ reason: 'forge-access', satisfied_at: null });
    });

    it('closes the wait as bound when the member’s next ask creates the PR', async () => {
        await signMemberIn(grantsOver());
        const refusing = await boot({ grants: grantsOver(), writer: answering(HTTP_NOT_FOUND) });
        const { id, claim } = await running();
        expect((await ask(refusing, id, claim.leaseToken)).json()).toEqual(FORGE_ACCESS);
        await app?.close();

        const allowed = await boot({ grants: grantsOver(), writer: writerOver() });
        const response = await ask(allowed, id, claim.leaseToken);

        expect(response.json()).toMatchObject({ answer: 'pr', operation: 'created' });
        expect(await requirements(id)).toEqual([
            { provider: 'forge', target: 'github', reason: 'forge-access', satisfied_at: expect.any(Date) },
        ]);
        const [closed] = await sql<
            { outcome: string }[]
        >`select outcome from job_integration_requirement where root_job_id = ${id}`;
        expect(closed!.outcome).toBe('bound');
    });

    it('answers denied, never a wait, on a 401: the authorization itself is refused', async () => {
        await signMemberIn(grantsOver());
        const instance = await boot({ grants: grantsOver(), writer: answering(HTTP_UNAUTHORIZED) });
        const { id, claim } = await running();

        const response = await ask(instance, id, claim.leaseToken);

        expect(response.json()).toEqual({ answer: 'denied' });
        expect(await requirements(id)).toEqual([]);
    });

    it('opens nothing when the lease was superseded while GitHub answered', async () => {
        await signMemberIn(grantsOver());
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered: () => void = () => {};
        const reached = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const slow = writerOver(async () => {
            entered();
            await gate;
            return new Response('{"message":"Not Found"}', { status: HTTP_NOT_FOUND });
        });
        const instance = await boot({ grants: grantsOver(), writer: slow });
        const { id, claim } = await running();
        const pending = ask(instance, id, claim.leaseToken);
        await reached;
        await expireLease(sql, id);
        expect(((await jobs.claim('w2', LEASE_SECONDS)) as Claim).id).toBe(id);
        release();

        const response = await pending;

        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json()).toMatchObject({ code: 'LEASE_LOST' });
        expect(await requirements(id)).toEqual([]);
    });
});
