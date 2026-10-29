import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createAuthStore } from '../src/auth/store.js';
import { type AttemptOfLease, createAttemptOfLease } from '../src/db/attempt-of-lease.js';
import { createConnectionGrants } from '../src/db/connection-grants.js';
import { createConnectionStore } from '../src/db/connection-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim } from '../src/db/jobs/job-store-types.js';
import type { GrantPayload } from '../src/integrations/grant-credentials.js';
import { createIntegrationRuntime } from '../src/integrations/integration-recovery.js';
import { createOrgRegistry } from '../src/orgs.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { createFakeOAuth } from '../test/integrations-fake-provider.js';
import { githubAuth, testConfig } from '../test/helpers-config.js';
import { expireLease, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import { attachJira, bindConnections, lineageHarness, seedGrantSecret, spied } from './integration-store-faults.js';

/**
 * The managed-connection broker (docs/connections.md) on a real database: a real attempt's pair, the real
 * resolver and lineage, the fake OAuth provider's hooks. The route's offline contract is
 * server/test/routes.connection-credential.test.ts.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const ALICE = testUser('broker-alice');
const BOB = testUser('broker-bob');
const OTHER_ALICE = testUser('broker-other-org');
const LEASE_SECONDS = 300;
const REPO = 'acme/widgets';
const SEED_TOKEN = 'access-seed-secret';
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [ALICE, BOB, OTHER_ALICE], max: 8 });

const payload = (scopes: string[], over: Partial<GrantPayload> = {}): GrantPayload => ({
    accessToken: SEED_TOKEN,
    accessExpiresAt: Date.now() + 3_600_000,
    refreshToken: 'refresh-0',
    authority: { scopes },
    ...over,
});

interface RigOptions {
    org?: string;
    user?: { id: string; login: string };
    scopes?: string[];
    payload?: Partial<GrantPayload>;
    secrets?: (store: SecretStore) => SecretStore;
    attempt?: (real: AttemptOfLease) => AttemptOfLease;
}

let apps: FastifyInstance[] = [];
afterEach(async () => {
    for (const app of apps) await app.close();
    apps = [];
});

/** A real running attempt of `user`'s, its thread root bound to one of the user's own connections, and an app over it. */
async function rig(options: RigOptions = {}) {
    const sql = db.sql;
    const org = options.org ?? ORG;
    const user = options.user ?? ALICE;
    const scopes = options.scopes ?? ['fake:read'];
    await sql`insert into org_membership (org_id, github_login, user_id) values (${org}, ${user.login}, ${user.id})
        on conflict do nothing`;
    const jobs = createJobStore({ sql, orgId: org });
    const created = await jobs.create('work the ticket', user.id, { repo: REPO, executor: null });
    if (typeof created === 'string') throw new Error(`create refused: ${created}`);
    const cloudId = `cloud-${randomUUID()}`;
    const attached = await attachJira(createConnectionGrants({ sql, orgId: org }), user.id, {
        externalAccountId: `acct-${randomUUID()}`,
        cloudId,
        scopes,
    });
    const h = lineageHarness(sql);
    const seed = await seedGrantSecret(sql, h.open(), attached.grant, payload(scopes, options.payload));
    await bindConnections(sql, { orgId: org, rootJobId: created.id, userId: user.id }, [attached.connectionId]);
    const claim = (await jobs.claim('w1', LEASE_SECONDS)) as Claim;
    expect(claim.id).toBe(created.id);

    const fake = createFakeOAuth();
    const spy = spied(options.secrets ? options.secrets(h.open()) : h.open());
    const runtime = createIntegrationRuntime({
        sql,
        secrets: spy.store,
        providers: (provider) => (provider === 'jira' ? fake.hooks : undefined),
        clients: () => undefined,
        callbackOrigin: null,
        timing: { retryDelayMs: 0 },
    });
    const real = createAttemptOfLease({ sql });
    const lines: string[] = [];
    const ready = Promise.resolve();
    const config = testConfig({ auth: githubAuth() });
    const app = await buildApp({
        config,
        orgs: createOrgRegistry({ sql, ready, config, withStores: false }),
        auth: createAuthStore({ sql, ready }),
        attemptOfLease: options.attempt ? options.attempt(real) : real,
        integrations: runtime,
        ready,
        version: '0.0.0',
        logger: { level: 'trace', stream: { write: (line: string) => lines.push(line) } },
    });
    apps.push(app);

    const askAs = (pair: { id: string; leaseToken: string }, connectionId: string = attached.connectionId) =>
        app.inject({
            method: 'POST',
            url: `/api/jobs/${pair.id}/credentials/connections/${connectionId}`,
            headers: { 'x-factory-job-id': pair.id, 'x-factory-job-lease-token': pair.leaseToken },
        });
    return {
        sql,
        app,
        lines,
        fake,
        spy,
        runtime,
        jobs,
        claim,
        rootId: created.id,
        grant: attached.grant,
        connectionId: attached.connectionId,
        cloudId,
        ref: seed.ref,
        ask: () => askAs({ id: claim.id, leaseToken: claim.leaseToken }),
        askAs,
    };
}

const noToken = (res: { body: string }) => {
    expect(res.body).not.toContain(SEED_TOKEN);
    expect(res.body).not.toContain('access-1');
};

describe.skipIf(!enabled)('the managed-connection broker — on a real attempt', () => {
    it("issues Alice's bound connection to Alice's live attempt, never cached", async () => {
        const r = await rig();
        const res = await r.ask();
        expect(res.statusCode).toBe(HTTP_OK);
        expect(res.headers['cache-control']).toBe('no-store');
        const body = res.json();
        expect(body).toMatchObject({
            token: SEED_TOKEN,
            scopes: ['fake:read'],
            resource: r.cloudId,
            refreshable: true,
            revocable: false,
        });
        expect(typeof body.expiresAt).toBe('string');
        expect(r.lines.join('\n')).not.toContain(SEED_TOKEN);
    });

    it("refuses another org's pair for this org's connection", async () => {
        const mine = await rig();
        const theirs = await rig({ org: OTHER_ORG, user: OTHER_ALICE });
        const res = await theirs.askAs({ id: theirs.claim.id, leaseToken: theirs.claim.leaseToken }, mine.connectionId);
        expect([HTTP_FORBIDDEN, HTTP_CONFLICT]).toContain(res.statusCode);
        noToken(res);
    });

    it("refuses a connection bound to a different user's root", async () => {
        const alice = await rig();
        const bob = await rig({ user: BOB });
        const res = await bob.askAs({ id: bob.claim.id, leaseToken: bob.claim.leaseToken }, alice.connectionId);
        expect([HTTP_FORBIDDEN, HTTP_CONFLICT]).toContain(res.statusCode);
        expect(res.json().outcome).toMatchObject({ outcome: 'integration_required', reason: 'missing' });
        noToken(res);
    });

    it('refuses an org-owned (legacy) connection in a worker', async () => {
        const r = await rig();
        const orgWide = await createConnectionStore({ sql: r.sql, orgId: ORG }).create({
            ownerUserId: null,
            site: 'example.atlassian.net',
            cloudId: `cloud-${randomUUID()}`,
            email: `a-${randomUUID()}@example.com`,
            apiToken: 'legacy-secret-token',
            access: 'read',
        });
        await bindConnections(r.sql, { orgId: ORG, rootJobId: r.rootId, userId: ALICE.id }, [orgWide.id]);
        const res = await r.askAs({ id: r.claim.id, leaseToken: r.claim.leaseToken }, orgWide.id);
        expect([HTTP_FORBIDDEN, HTTP_CONFLICT]).toContain(res.statusCode);
        expect(res.json().outcome).toBeDefined();
        expect(res.body).not.toContain('legacy-secret-token');
    });

    it('refuses a stale pair after a reclaim rotates the lease, and serves the new one', async () => {
        const r = await rig();
        expect((await r.ask()).statusCode).toBe(HTTP_OK);
        await expireLease(r.sql, r.claim.id);
        expect((await r.ask()).statusCode).toBe(HTTP_FORBIDDEN);
        const second = (await r.jobs.claim('w2', LEASE_SECONDS)) as Claim;
        expect(second.id).toBe(r.claim.id);
        const stale = await r.ask();
        expect(stale.statusCode).toBe(HTTP_FORBIDDEN);
        noToken(stale);
        expect((await r.askAs({ id: second.id, leaseToken: second.leaseToken })).statusCode).toBe(HTTP_OK);
    });

    it.each<{ name: string; settle: (r: Awaited<ReturnType<typeof rig>>) => Promise<unknown> }>([
        {
            name: 'a cancelled task',
            settle: (r) => r.sql`update job set cancel_requested_at = now() where id = ${r.claim.id}`,
        },
        {
            name: 'a finished task',
            settle: (r) => r.sql`update job set status = 'succeeded', finished_at = now() where id = ${r.claim.id}`,
        },
        {
            name: 'a task whose execution user is no longer a member',
            settle: (r) => r.sql`delete from org_membership where org_id = ${ORG} and user_id = ${ALICE.id}`,
        },
        {
            name: 'a reviewer row',
            settle: (r) => r.sql`
                update job set review_of = ${randomUUID()}, review_key = 'k', review_profile = 'security',
                               review_spec = ${r.sql.json({ name: 'security' })}, review_revision = 'abc',
                               review_ref = 'refs/factory/review/x'
                where id = ${r.claim.id}`,
        },
    ])('F1: serves a running attempt and, with no grace, refuses $name', async ({ settle }) => {
        const r = await rig();
        expect((await r.ask()).statusCode).toBe(HTTP_OK);
        await settle(r);
        const after = await r.ask();
        expect(after.statusCode).toBe(HTTP_FORBIDDEN);
        expect(after.json().code).toBe('CONNECTION_NOT_AUTHORIZED');
        noToken(after);
    });

    it.each(['deleted', 'unbound'] as const)(
        'answers integration_required{missing} for a %s connection',
        async (how) => {
            const r = await rig();
            expect((await r.ask()).statusCode).toBe(HTTP_OK);
            if (how === 'deleted') {
                await createConnectionStore({ sql: r.sql, orgId: ORG }).disconnect(r.connectionId, {
                    userId: ALICE.id,
                    admin: false,
                });
            } else {
                await r.sql`delete from job_connection_binding where root_job_id = ${r.rootId}`;
            }
            const res = await r.ask();
            expect(res.statusCode).toBe(HTTP_CONFLICT);
            expect(res.json()).toMatchObject({
                code: 'INTEGRATION_REQUIRED',
                outcome: { outcome: 'integration_required', reason: 'missing' },
            });
            noToken(res);
        }
    );

    it('refuses a broadened grant: grant scopes beyond the binding ceiling', async () => {
        const r = await rig();
        const lineage = r.runtime.lineageOf(ORG);
        const claim = await lineage.claimLineage(r.grant.id, 'reconsent', { rotates: false });
        if (!claim.ok) throw new Error(claim.reason);
        const committed = await lineage.commitLineage(claim.claim, payload(['fake:read', 'fake:write']));
        expect(committed).toMatchObject({ ok: true });
        const res = await r.ask();
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(res.json().outcome).toEqual({ outcome: 'forbidden', reason: 'binding-ceiling-exceeded' });
        noToken(res);
    });

    it('ignores any scope, resource or url the request names', async () => {
        const r = await rig();
        const plain = await r.ask();
        const named = await r.app.inject({
            method: 'POST',
            url: `/api/jobs/${r.claim.id}/credentials/connections/${r.connectionId}?scopes=admin&resource=other&url=https://evil.example`,
            headers: {
                'x-factory-job-id': r.claim.id,
                'x-factory-job-lease-token': r.claim.leaseToken,
                'content-type': 'application/json',
            },
            payload: { scopes: ['admin'], resource: 'other', url: 'https://evil.example' },
        });
        expect(named.statusCode).toBe(HTTP_OK);
        expect(named.json()).toEqual(plain.json());
    });

    it('withholds the token when Stop lands during a blocked refresh', async () => {
        const r = await rig({ payload: { accessExpiresAt: Date.now() - 1000 } });
        const parked = r.fake.parkNext();
        const pending = r.ask();
        await parked.accepted;
        await r.sql`update job set cancel_requested_at = now() where id = ${r.claim.id}`;
        parked.release();
        const res = await pending;
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        noToken(res);
        expect(r.lines.join('\n')).not.toContain('access-1');
    });

    it('withholds the token when the binding is removed during a blocked refresh', async () => {
        const r = await rig({ payload: { accessExpiresAt: Date.now() - 1000 } });
        const parked = r.fake.parkNext();
        const pending = r.ask();
        await parked.accepted;
        await r.sql`delete from job_connection_binding where root_job_id = ${r.rootId}`;
        parked.release();
        const res = await pending;
        expect([HTTP_FORBIDDEN, HTTP_CONFLICT]).toContain(res.statusCode);
        noToken(res);
        expect(r.lines.join('\n')).not.toContain('access-1');
    });

    it('an outage is retryable, not a verdict', async () => {
        const r = await rig({
            secrets: (store) => ({
                ...store,
                readActive: async () => {
                    throw new Error('store down');
                },
            }),
        });
        const res = await r.ask();
        expect(res.statusCode).toBe(HTTP_UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
        expect(res.json().code).not.toBe('INTEGRATION_REQUIRED');
    });

    it('a lease query that throws is 503, not 403', async () => {
        let thrown = false;
        const r = await rig({
            attempt: (real) => async (jobId, leaseToken) => {
                if (!thrown) {
                    thrown = true;
                    throw new Error('connection terminated');
                }
                return real(jobId, leaseToken);
            },
        });
        const first = await r.ask();
        expect(first.statusCode).toBe(HTTP_UNAVAILABLE);
        expect(first.json()).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
        expect((await r.ask()).statusCode).toBe(HTTP_OK);
    });

    // Case 16 of the plan (a provider 429 during refresh) is not reachable: the lineage surfaces a refresh
    // failure as `unavailable` or `integration_required`, never `rate_limited`. The route maps `rate_limited`
    // anyway (routes.connection-credential.test.ts).
});
