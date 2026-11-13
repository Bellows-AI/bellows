import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildApp } from '../src/app.js';
import { createDriverCredentialStore, type DriverCredentialStore } from '../src/auth/driver-credentials.js';
import { hashToken } from '../src/auth/session.js';
import { type AuthStore, createAuthStore } from '../src/auth/store.js';
import { createOrgOfJob, createOrgOfLease, createOrgOfReclaim } from '../src/db/jobs/job-store-org-resolvers.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { createServerMetrics } from '../src/metrics.js';
import { createOrgRegistry } from '../src/orgs.js';
import { githubAuth, testConfig, TEST_JOB_BOARD_TOKEN } from '../test/helpers-config.js';
import { testSecretDeps, testSecretStore } from './env-secrets-harness.js';
import { expireLease, randomGithubId, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * Per-driver credentials (docs/auth.md): the operator issues a credential for named organizations or for the pool,
 * stored as a hash and shown once. A credential for org A claims only org A's queue, is refused 403 on org B's job
 * routes (never the 404 a driver reads as "removed"), and is refused on a lease lookup naming org B's ids rather than
 * answered as if they were gone. A revoked credential is a 401 on its next call; a rotated one keeps working until
 * its overlap window ends. The board's JOB_BOARD_TOKEN still answers as a pool credential.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

const OK = 200;
const CREATED = 201;
const NO_CONTENT = 204;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CONFLICT = 409;
const UNAVAILABLE = 503;
const LEASE_S = 300;

interface Person {
    userId: string;
    githubUserId: number;
    token: string;
}

let sql: Sql;
let auth: AuthStore;
let credentials: DriverCredentialStore;
let app: FastifyInstance;
let orgA: string;
let orgB: string;
let operator: Person;
let memberA: Person;
let memberB: Person;

const repoOf = (orgId: string) => `owner-${orgId}/web`;

async function personIn(orgId: string): Promise<Person> {
    const githubUserId = randomGithubId();
    const login = `u-${randomUUID().slice(0, 8)}`;
    const caller = await auth.signIn({ githubUserId, login, displayName: login, avatarUrl: null }, orgId, [
        { id: orgId, name: `acct-${orgId}` },
    ]);
    const token = `fat_${randomUUID()}`;
    await auth.createAccessToken({
        kind: 'personal',
        orgId,
        userId: caller.user.id,
        createdBy: caller.user.id,
        label: 'driver-credentials',
        tokenHash: hashToken(token),
    });
    return { userId: caller.user.id, githubUserId, token };
}

/** An org whose member can queue a task: its one executor profile and a tracked repo. */
async function boardFor(orgId: string): Promise<Person> {
    const member = await personIn(orgId);
    await createUserExecutorStore({ sql, orgId, ...testSecretDeps(sql) }).createOrg({
        name: 'main',
        type: 'claude-code',
        config: {},
        createdBy: member.userId,
    });
    await sql`insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen)
              values (${orgId}, 'claude-code', ${`dc-${randomUUID()}`}, ${repoOf(orgId)}, 'main', now(), now())`;
    return member;
}

async function boot(store: DriverCredentialStore): Promise<void> {
    const ready = Promise.resolve();
    const config = testConfig({
        auth: githubAuth(),
        deploymentMode: 'cloud',
        planDefaults: { running: 5, queued: 20, wallSeconds: 3600 },
        operatorGithubIds: [operator.githubUserId],
    });
    app = await buildApp({
        config,
        orgs: createOrgRegistry({
            sql,
            ready,
            config,
            withStores: true,
            secrets: testSecretStore(sql),
            secretLog: () => {},
        }),
        auth,
        driverCredentials: store,
        orgOfLease: createOrgOfLease({ sql, ready }),
        orgOfJob: createOrgOfJob({ sql, ready }),
        orgOfReclaim: createOrgOfReclaim({ sql, ready }),
        metrics: createServerMetrics({
            admission: { global: 8, org: 4 },
            occupancy: async () => ({ global: 0, orgMax: 0, repoMax: 0 }),
        }),
        ready,
        version: '0.0.0',
    });
}

const call = (method: 'GET' | 'POST', url: string, bearer: string, payload?: unknown) =>
    app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${bearer}` },
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

async function queue(member: Person, orgId: string): Promise<string> {
    const created = await call('POST', '/api/jobs', member.token, { repo: repoOf(orgId), command: 'work' });
    expect(created.statusCode, created.body).toBe(CREATED);
    return created.json<{ id: string }>().id;
}

const claim = (bearer: string) =>
    call('POST', '/api/jobs/claim', bearer, { worker: `driver-${randomUUID().slice(0, 8)}`, leaseSeconds: LEASE_S });

async function issue(body: Record<string, unknown>): Promise<{ id: string; token: string }> {
    const issued = await call('POST', '/api/operator/driver-credentials', operator.token, body);
    expect(issued.statusCode, issued.body).toBe(CREATED);
    const { credential, token } = issued.json<{ credential: { id: string }; token: string }>();
    return { id: credential.id, token };
}

beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    auth = createAuthStore({ sql });
    credentials = createDriverCredentialStore({ sql });
    [orgA, orgB] = [testOrg(), testOrg()];
    memberA = await boardFor(orgA);
    memberB = await boardFor(orgB);
    operator = await personIn(testOrg());
    await boot(credentials);
});

afterEach(async () => {
    if (enabled) await app?.close();
});

describe.skipIf(!enabled)('per-driver credentials', () => {
    it('stores only the hash and shows the token once, at issue', async () => {
        const { id, token } = await issue({ label: 'east', orgs: [orgA] });
        expect(token.startsWith('drv_')).toBe(true);

        const [row] = await sql<{ token_hash: Buffer }[]>`select token_hash from driver_credential where id = ${id}`;
        expect(Buffer.compare(row!.token_hash, hashToken(token))).toBe(0);
        const listed = await call('GET', '/api/operator/driver-credentials', operator.token);
        expect(listed.statusCode).toBe(OK);
        expect(listed.body).not.toContain(token);
        expect(listed.json<{ credentials: unknown[] }>().credentials).toEqual([
            expect.objectContaining({ id, label: 'east', pool: false, orgs: [orgA], revokedAt: null, expiresAt: null }),
        ]);
    });

    it('is the operator’s surface only', async () => {
        const asked = await call('POST', '/api/operator/driver-credentials', memberA.token, { label: 'x', pool: true });
        expect(asked.statusCode).toBe(FORBIDDEN);
        expect((await call('GET', '/api/operator/driver-credentials', memberA.token)).statusCode).toBe(FORBIDDEN);
    });

    it('refuses an issue naming no scope, both scopes, or an unknown organization', async () => {
        const path = '/api/operator/driver-credentials';
        expect((await call('POST', path, operator.token, { label: 'x' })).statusCode).toBe(400);
        expect((await call('POST', path, operator.token, { label: 'x', pool: true, orgs: [orgA] })).statusCode).toBe(
            400
        );
        expect((await call('POST', path, operator.token, { label: 'x', orgs: [] })).statusCode).toBe(400);
        const unknown = await call('POST', path, operator.token, { label: 'x', orgs: [orgA, testOrg()] });
        expect(unknown.statusCode).toBe(NOT_FOUND);
        expect((await sql`select 1 from driver_credential`).length).toBe(0);
    });

    it('claims only its own organizations’ queue', async () => {
        const { token } = await issue({ label: 'org-a', orgs: [orgA] });
        await queue(memberB, orgB);

        expect((await claim(token)).statusCode).toBe(NO_CONTENT);

        const jobA = await queue(memberA, orgA);
        const claimed = await claim(token);
        expect(claimed.statusCode).toBe(OK);
        expect(claimed.json<{ id: string }>().id).toBe(jobA);
    });

    it('is refused 403, not 404, on another organization’s job routes', async () => {
        const { token } = await issue({ label: 'org-a', orgs: [orgA] });
        const jobB = await queue(memberB, orgB);
        const held = await claim(TEST_JOB_BOARD_TOKEN);
        expect(held.json<{ id: string }>().id).toBe(jobB);
        const { leaseToken } = held.json<{ leaseToken: string }>();

        const beat = await call('POST', `/api/jobs/${jobB}/heartbeat`, token, { leaseToken, leaseSeconds: LEASE_S });
        expect(beat.statusCode).toBe(FORBIDDEN);
        expect(beat.json<{ code: string }>().code).toBe('FORBIDDEN');
        const done = await call('POST', `/api/jobs/${jobB}/complete`, token, { leaseToken, exitCode: 0 });
        expect(done.statusCode).toBe(FORBIDDEN);

        // The refusal moved nothing: the pool credential's lease still holds.
        const still = await call('POST', `/api/jobs/${jobB}/heartbeat`, TEST_JOB_BOARD_TOKEN, {
            leaseToken,
            leaseSeconds: LEASE_S,
        });
        expect(still.statusCode).toBe(OK);
    });

    it('refuses a lease lookup naming another organization’s job instead of answering it absent', async () => {
        const { token } = await issue({ label: 'org-a', orgs: [orgA] });
        const jobA = await queue(memberA, orgA);
        const jobB = await queue(memberB, orgB);

        const mixed = await call('POST', '/api/jobs/leases', token, { ids: [jobA, jobB] });
        expect(mixed.statusCode).toBe(FORBIDDEN);

        const own = await call('POST', '/api/jobs/leases', token, { ids: [jobA, randomUUID()] });
        expect(own.statusCode).toBe(OK);
        expect(own.json<{ jobs: { id: string }[] }>().jobs.map((row) => row.id)).toEqual([jobA]);
    });

    it('keeps the board-wide metrics to a pool credential', async () => {
        const scoped = await issue({ label: 'org-a', orgs: [orgA] });
        const pool = await issue({ label: 'pool', pool: true });
        expect((await call('GET', '/api/metrics', scoped.token)).statusCode).toBe(FORBIDDEN);
        expect((await call('GET', '/api/metrics', pool.token)).statusCode).toBe(OK);
    });

    it('a pool credential claims every organization’s queue, like the board token', async () => {
        const { token } = await issue({ label: 'pool', pool: true });
        const jobB = await queue(memberB, orgB);
        const claimed = await claim(token);
        expect(claimed.statusCode).toBe(OK);
        expect(claimed.json<{ id: string }>().id).toBe(jobB);
    });

    it('a revoked credential is refused 401 on its next call, and its job stays for another driver', async () => {
        const { id, token } = await issue({ label: 'org-a', orgs: [orgA] });
        const jobA = await queue(memberA, orgA);
        const held = await claim(token);
        const { leaseToken } = held.json<{ leaseToken: string }>();

        const revoked = await call('POST', `/api/operator/driver-credentials/${id}/revoke`, operator.token);
        expect(revoked.statusCode).toBe(OK);
        expect(revoked.json<{ credential: { revokedAt: string | null } }>().credential.revokedAt).not.toBeNull();

        expect((await claim(token)).statusCode).toBe(UNAUTHORIZED);
        const beat = await call('POST', `/api/jobs/${jobA}/heartbeat`, token, { leaseToken, leaseSeconds: LEASE_S });
        expect(beat.statusCode).toBe(UNAUTHORIZED);

        // The revocation ended nothing: the row is still running, and the pool sees it.
        const [row] = await sql<{ status: string }[]>`select status from job where id = ${jobA}`;
        expect(row!.status).toBe('running');
        const leases = await call('POST', '/api/jobs/leases', TEST_JOB_BOARD_TOKEN, { ids: [jobA] });
        expect(leases.json<{ jobs: { id: string; leaseToken: string }[] }>().jobs).toEqual([
            expect.objectContaining({ id: jobA, leaseToken }),
        ]);

        // Its lease lapses unrenewed, and another driver adopts the run under a new claim sequence.
        await expireLease(sql, jobA);
        const adopted = await claim(TEST_JOB_BOARD_TOKEN);
        expect(adopted.statusCode).toBe(OK);
        const taken = adopted.json<{ id: string; leaseToken: string; claimSeq: number }>();
        expect(taken.id).toBe(jobA);
        expect(taken.leaseToken).not.toBe(leaseToken);
        expect(taken.claimSeq).toBeGreaterThan(held.json<{ claimSeq: number }>().claimSeq);
    });

    it('a rotated credential keeps working inside its overlap window and is refused after it', async () => {
        const old = await issue({ label: 'org-a', orgs: [orgA] });
        const rotated = await call('POST', `/api/operator/driver-credentials/${old.id}/rotate`, operator.token, {
            overlapSeconds: 600,
        });
        expect(rotated.statusCode, rotated.body).toBe(CREATED);
        const fresh = rotated.json<{
            credential: { id: string; rotatedFrom: string; orgs: string[] };
            token: string;
        }>();
        expect(fresh.credential.rotatedFrom).toBe(old.id);
        expect(fresh.credential.orgs).toEqual([orgA]);
        expect(fresh.token).not.toBe(old.token);

        expect((await claim(old.token)).statusCode).toBe(NO_CONTENT);
        expect((await claim(fresh.token)).statusCode).toBe(NO_CONTENT);

        // A second rotation of the same credential is refused: its successor already exists.
        const again = await call('POST', `/api/operator/driver-credentials/${old.id}/rotate`, operator.token, {});
        expect(again.statusCode).toBe(CONFLICT);

        // The window ends: the old credential's expiry passes.
        await sql`update driver_credential set expires_at = now() - interval '1 second' where id = ${old.id}`;
        expect((await claim(old.token)).statusCode).toBe(UNAUTHORIZED);
        expect((await claim(fresh.token)).statusCode).toBe(NO_CONTENT);
    });

    it('a rotation with no overlap refuses the old credential at once', async () => {
        const old = await issue({ label: 'pool', pool: true });
        const rotated = await call('POST', `/api/operator/driver-credentials/${old.id}/rotate`, operator.token, {
            overlapSeconds: 0,
        });
        expect(rotated.statusCode).toBe(CREATED);
        expect((await claim(old.token)).statusCode).toBe(UNAUTHORIZED);
        expect((await claim(rotated.json<{ token: string }>().token)).statusCode).toBe(NO_CONTENT);
    });

    it('a lookup that cannot answer is a 503, never a 401 or an accept', async () => {
        const { token } = await issue({ label: 'org-a', orgs: [orgA] });
        await app.close();
        await boot({
            ...credentials,
            resolve: async () => {
                throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
            },
        });
        expect((await claim(token)).statusCode).toBe(UNAVAILABLE);
        // The board token needs no lookup.
        expect((await claim(TEST_JOB_BOARD_TOKEN)).statusCode).toBe(NO_CONTENT);
    });

    it('deleting an organization drops it from its credentials, and the credential reaches nothing', async () => {
        const { id, token } = await issue({ label: 'org-b', orgs: [orgB] });
        await sql`delete from organization where id = ${orgB}`;
        const listed = await call('GET', '/api/operator/driver-credentials', operator.token);
        expect(listed.json<{ credentials: { id: string; orgs: string[] }[] }>().credentials).toEqual([
            expect.objectContaining({ id, orgs: [] }),
        ]);
        expect((await claim(token)).statusCode).toBe(UNAVAILABLE);
    });
});
