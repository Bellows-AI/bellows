import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
    createConnectionOfLease,
    createConnectionStore,
    type ConnectionOfLease,
    type ConnectionStore,
} from '../src/db/connection-store.js';
import { createConnectionGrants } from '../src/db/connection-grants.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { expireLease, testOrg, testUser } from './fixtures.js';

/** The managed connections (051, issue #546): scoping and the proxy's per-call check, on a real database. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const LEASE_SECONDS = 300;
const OWNER = testUser('conn-owner');
const STRANGER = testUser('conn-stranger');
const API_TOKEN = 'db-test-token';

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [OWNER, STRANGER] });

let sql: Sql;
let store: ConnectionStore;
let otherOrgStore: ConnectionStore;
let jobs: JobStore;
let check: ConnectionOfLease;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createConnectionStore({ sql, orgId: ORG });
    otherOrgStore = createConnectionStore({ sql, orgId: OTHER_ORG });
    jobs = createJobStore({ sql, orgId: ORG });
    check = createConnectionOfLease({ sql });
});

const newConnection = (ownerUserId: string | null, access: 'read' | 'write' = 'read') =>
    store.create({
        ownerUserId,
        site: 'example.atlassian.net',
        cloudId: 'cloud-1',
        email: 'agent@example.com',
        apiToken: API_TOKEN,
        access,
    });

const join = (user: { id: string; login: string }) =>
    sql`insert into org_membership (org_id, github_login, user_id) values (${ORG}, ${user.login}, ${user.id})
        on conflict do nothing`;

/** A running task authored by OWNER that selected `connectionId`, under a live lease. */
async function running(connectionId: string | null): Promise<{ id: string; claim: Claim }> {
    await join(OWNER);
    const ref = await jobs.create('look at ABC-1', OWNER.id, {
        repo: null,
        executor: null,
        connectionIds: connectionId ? [connectionId] : [],
    });
    if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
    const claim = (await jobs.claim('w1', LEASE_SECONDS)) as Claim;
    expect(claim.id).toBe(ref.id);
    return { id: ref.id, claim };
}

describe.skipIf(!enabled)('connection store — scoping', () => {
    it('lists org-owned connections and the caller own, never another member own or another org', async () => {
        const orgOwned = await newConnection(null);
        const mine = await newConnection(OWNER.id);
        const theirs = await newConnection(STRANGER.id);
        const foreign = await otherOrgStore.create({
            ownerUserId: null,
            site: 'other.atlassian.net',
            cloudId: 'cloud-2',
            email: 'x@example.com',
            apiToken: API_TOKEN,
            access: 'read',
        });

        const ids = (await store.list(OWNER.id)).map((c) => c.id);
        expect(ids).toEqual(expect.arrayContaining([orgOwned.id, mine.id]));
        expect(ids).not.toContain(theirs.id);
        expect(ids).not.toContain(foreign.id);
        expect(JSON.stringify(await store.list(OWNER.id))).not.toContain(API_TOKEN);
    });

    it('disconnects personal for its owner and org-owned only for an admin', async () => {
        const orgOwned = await newConnection(null);
        const mine = await newConnection(OWNER.id);
        expect(await store.disconnect(mine.id, { userId: STRANGER.id, admin: true })).toBe(false);
        expect(await store.disconnect(orgOwned.id, { userId: OWNER.id, admin: false })).toBe(false);
        expect(await store.disconnect(mine.id, { userId: OWNER.id, admin: false })).toBe(true);
        expect(await store.disconnect(orgOwned.id, { userId: OWNER.id, admin: true })).toBe(true);
    });
});

describe.skipIf(!enabled)('connection store — generic view (094)', () => {
    it("lists the caller's personal and the org's legacy, never another member's personal", async () => {
        const mine = await newConnection(OWNER.id);
        const legacy = await newConnection(null);
        const theirs = await newConnection(STRANGER.id);
        const views = await store.list(OWNER.id);
        const byId = new Map(views.map((v) => [v.id, v]));
        expect(byId.get(mine.id)).toMatchObject({
            provider: 'jira',
            credential: 'legacy_api_token',
            ownership: 'personal',
            principal: 'self',
            site: 'example.atlassian.net',
            account: 'agent@example.com',
            status: 'active',
        });
        expect(byId.get(legacy.id)).toMatchObject({ ownership: 'legacy-org', principal: null });
        expect(byId.has(theirs.id)).toBe(false);
        expect(JSON.stringify(views)).not.toContain(API_TOKEN);
    });

    it("candidates(user, jira) excludes disconnected, other users' and legacy org rows", async () => {
        const [row] = await sql<{ id: string }[]>`
            insert into app_user (github_user_id, github_login)
            values (${Math.floor(Math.random() * 1e9) + 1e6}, ${`conn-cand-${crypto.randomUUID()}`})
            returning id
        `;
        const user = row!.id;
        await newConnection(null);
        await newConnection(STRANGER.id);
        const gone = await store.create({
            ownerUserId: user,
            site: 'example.atlassian.net',
            cloudId: 'cloud-1',
            email: 'agent@example.com',
            apiToken: API_TOKEN,
            access: 'read',
        });
        await store.disconnect(gone.id, { userId: user, admin: false });
        const live = await store.create({
            ownerUserId: user,
            site: 'example.atlassian.net',
            cloudId: 'cloud-1',
            email: 'agent@example.com',
            apiToken: API_TOKEN,
            access: 'read',
        });
        expect((await store.candidates(user, 'jira')).map((c) => c.id)).toEqual([live.id]);
        expect(await store.candidates(user, 'github')).toEqual([]);
    });

    it('disconnect is soft: the row remains, api_token is null and status is disconnected', async () => {
        const mine = await newConnection(OWNER.id);
        expect(await store.disconnect(mine.id, { userId: OWNER.id, admin: false })).toBe(true);
        const [row] = await sql<{ api_token: string | null; status: string; disconnected_at: Date | null }[]>`
            select api_token, status, disconnected_at from connector_connection where id = ${mine.id}
        `;
        expect(row).toMatchObject({ api_token: null, status: 'disconnected' });
        expect(row!.disconnected_at).not.toBeNull();
        expect((await store.list(OWNER.id)).map((v) => v.id)).not.toContain(mine.id);
        expect(await store.disconnect(mine.id, { userId: OWNER.id, admin: false })).toBe(false);
    });

    it('a binding keeps its frozen account after the connection is disconnected', async () => {
        await join(OWNER);
        const mine = await newConnection(OWNER.id);
        const bound = await running(mine.id);
        await store.disconnect(mine.id, { userId: OWNER.id, admin: false });
        const [binding] = await sql<{ connection_id: string; external_account_id: string; source: string }[]>`
            select connection_id, external_account_id, source from job_connection_binding where root_job_id = ${bound.id}
        `;
        expect(binding).toEqual({
            connection_id: mine.id,
            external_account_id: 'agent@example.com',
            source: 'explicit',
        });
    });

    it('disconnecting the last connection of a grant revokes the grant; another active connection keeps it active', async () => {
        const grants = createConnectionGrants({ sql, orgId: ORG });
        const attach = async () => {
            const result = await grants.attachGrantConnection({
                principal: { kind: 'user', userId: OWNER.id },
                provider: 'jira',
                externalAccountId: `acct-${crypto.randomUUID()}`,
                authority: {},
                connection: { site: 'example.atlassian.net', cloudId: `c-${crypto.randomUUID()}`, access: 'read' },
            });
            if (!result.ok) throw new Error(result.reason);
            return result;
        };
        const solo = await attach();
        expect(await store.disconnect(solo.connectionId, { userId: OWNER.id, admin: false })).toBe(true);
        const [revoked] = await sql<
            { status: string }[]
        >`select status from integration_grant where id = ${solo.grant.id}`;
        expect(revoked!.status).toBe('revoked');

        const first = await attach();
        const sibling = await grants.attachGrantConnection({
            principal: { kind: 'user', userId: OWNER.id },
            provider: 'jira',
            externalAccountId: (
                await sql<
                    { external_account_id: string }[]
                >`select external_account_id from integration_grant where id = ${first.grant.id}`
            )[0]!.external_account_id,
            authority: {},
            connection: { site: 'example.atlassian.net', cloudId: `c-${crypto.randomUUID()}`, access: 'read' },
        });
        expect(sibling.ok).toBe(true);
        await store.disconnect(first.connectionId, { userId: OWNER.id, admin: false });
        const [kept] = await sql<
            { status: string }[]
        >`select status from integration_grant where id = ${first.grant.id}`;
        expect(kept!.status).toBe('active');
    });

    it('cross-org: a connection id from org B is invisible to org A', async () => {
        const foreign = await otherOrgStore.create({
            ownerUserId: OWNER.id,
            site: 'other.atlassian.net',
            cloudId: 'cloud-2',
            email: 'x@example.com',
            apiToken: API_TOKEN,
            access: 'read',
        });
        expect((await store.list(OWNER.id)).map((v) => v.id)).not.toContain(foreign.id);
        expect((await store.candidates(OWNER.id, 'jira')).map((v) => v.id)).not.toContain(foreign.id);
        expect(await store.disconnect(foreign.id, { userId: OWNER.id, admin: true })).toBe(false);
        expect((await otherOrgStore.list(OWNER.id)).map((v) => v.id)).toContain(foreign.id);
    });
});

/** Binds `connectionId` to the thread of `rootId` as the next revision, frozen from the connection row. */
async function bind(rootId: string, connectionId: string, source: 'migrated' | 'explicit' = 'explicit') {
    await sql`
        insert into job_connection_binding
            (org_id, root_job_id, revision, connection_id, provider, credential, external_account_id, resource,
             access, source)
        select c.org_id, ${rootId}, coalesce((select max(revision) from job_connection_binding
                                              where org_id = c.org_id and root_job_id = ${rootId}), 0) + 1,
               c.id, c.provider, c.credential, c.external_account_id, c.cloud_id, c.access, ${source}
        from connector_connection c where c.id = ${connectionId}`;
}

describe.skipIf(!enabled)('connection of lease — the proxy check', () => {
    it('resolves the root selection for a live attempt, with the credential', async () => {
        const connection = await newConnection(null, 'write');
        const { id, claim } = await running(connection.id);
        expect(await check(id, claim.leaseToken)).toEqual({
            ok: true,
            cloudId: 'cloud-1',
            email: 'agent@example.com',
            apiToken: API_TOKEN,
            access: 'write',
        });
    });

    it('refuses an unselected task, a wrong token and an unknown job', async () => {
        const { id, claim } = await running(null);
        expect(await check(id, claim.leaseToken)).toEqual({ ok: false, reason: 'unselected' });
        expect(await check(id, crypto.randomUUID())).toEqual({ ok: false, reason: 'lease' });
        expect(await check(crypto.randomUUID(), claim.leaseToken)).toEqual({ ok: false, reason: 'lease' });
    });

    // Disconnect is soft (094): the row stays selected by the thread, so the refusal is `revoked`, not `unselected`.
    it('stops at once when the connection is disconnected, even under a live lease', async () => {
        const connection = await newConnection(null);
        const { id, claim } = await running(connection.id);
        expect((await check(id, claim.leaseToken)).ok).toBe(true);
        await store.disconnect(connection.id, { userId: OWNER.id, admin: true });
        expect(await check(id, claim.leaseToken)).toEqual({ ok: false, reason: 'revoked' });
    });

    // Each case is its own test: an expired job is claimable again, so a second `running()` in one
    // test would re-claim it instead of the job the case just created.
    it('refuses the superseded attempt once a reclaim rotates the lease token', async () => {
        const connection = await newConnection(null);
        const first = await running(connection.id);
        await expireLease(sql, first.id);
        expect(await check(first.id, first.claim.leaseToken)).toEqual({ ok: false, reason: 'lease' });

        const second = (await jobs.claim('w2', LEASE_SECONDS)) as Claim;
        expect(second.id).toBe(first.id);
        expect(second.leaseToken).not.toBe(first.claim.leaseToken);
        expect(await check(first.id, first.claim.leaseToken)).toEqual({ ok: false, reason: 'lease' });
        expect((await check(second.id, second.leaseToken)).ok).toBe(true);
    });

    it.each<{ name: string; settle: (id: string) => Promise<unknown> }>([
        {
            name: 'refuses an attempt that was asked to stop',
            settle: (id) => sql`update job set cancel_requested_at = now() where id = ${id}`,
        },
        {
            name: 'refuses a finished attempt at once, with no tail grace',
            settle: (id) => sql`update job set finished_at = now() where id = ${id}`,
        },
    ])('$name', async ({ settle }) => {
        const connection = await newConnection(null);
        const attempt = await running(connection.id);
        await settle(attempt.id);
        expect(await check(attempt.id, attempt.claim.leaseToken)).toEqual({ ok: false, reason: 'lease' });
    });

    it('refuses an org-owned connection too once the task author is no longer a member', async () => {
        const connection = await newConnection(null, 'write');
        const { id, claim } = await running(connection.id);
        expect((await check(id, claim.leaseToken)).ok).toBe(true);
        await sql`delete from org_membership where org_id = ${ORG} and user_id = ${OWNER.id}`;
        expect(await check(id, claim.leaseToken)).toEqual({ ok: false, reason: 'revoked' });
    });

    it('refuses a personal connection once its owner is no longer a member, and for another author', async () => {
        await join(OWNER);
        const mine = await newConnection(OWNER.id);
        const { id, claim } = await running(mine.id);
        expect((await check(id, claim.leaseToken)).ok).toBe(true);

        await sql`delete from org_membership where org_id = ${ORG} and user_id = ${OWNER.id}`;
        expect(await check(id, claim.leaseToken)).toEqual({ ok: false, reason: 'revoked' });

        await join(OWNER);
        const strangers = await newConnection(STRANGER.id);
        await join(STRANGER);
        // The create would refuse another member's connection; a binding written around it must still not serve.
        await store.disconnect(mine.id, { userId: OWNER.id, admin: false });
        const other = await running(null);
        await bind(other.id, strangers.id);
        expect(await check(other.id, other.claim.leaseToken)).toEqual({ ok: false, reason: 'revoked' });
    });

    it("live check serves the thread's migrated binding", async () => {
        const connection = await newConnection(null, 'write');
        const { id, claim } = await running(null);
        await bind(id, connection.id, 'migrated');
        expect(await check(id, claim.leaseToken)).toEqual({
            ok: true,
            cloudId: 'cloud-1',
            email: 'agent@example.com',
            apiToken: API_TOKEN,
            access: 'write',
        });
    });

    it('a disconnected connection is refused revoked on the next call', async () => {
        // The task is created first: with a personal connection already there it would bind that one by default.
        const { id, claim } = await running(null);
        const connection = await newConnection(OWNER.id);
        await bind(id, connection.id);
        expect((await check(id, claim.leaseToken)).ok).toBe(true);
        await store.disconnect(connection.id, { userId: OWNER.id, admin: false });
        expect(await check(id, claim.leaseToken)).toEqual({ ok: false, reason: 'revoked' });
    });

    it('a hard-deleted connection is a confirmed absence: revoked, not unselected', async () => {
        const connection = await newConnection(null);
        const { id, claim } = await running(null);
        await bind(id, connection.id);
        await sql`delete from connector_connection where id = ${connection.id}`;
        expect(await check(id, claim.leaseToken)).toEqual({ ok: false, reason: 'revoked' });
    });

    it('an account mismatch between binding and connection is refused', async () => {
        const connection = await newConnection(null);
        const { id, claim } = await running(null);
        await bind(id, connection.id);
        await sql`update connector_connection set external_account_id = 'someone-else@example.com'
                  where id = ${connection.id}`;
        expect(await check(id, claim.leaseToken)).toEqual({ ok: false, reason: 'revoked' });
    });

    it('an execution user no longer a member is refused', async () => {
        const connection = await newConnection(null);
        const { id, claim } = await running(null);
        await bind(id, connection.id);
        expect((await check(id, claim.leaseToken)).ok).toBe(true);
        await sql`delete from org_membership where org_id = ${ORG} and user_id = ${OWNER.id}`;
        expect(await check(id, claim.leaseToken)).toEqual({ ok: false, reason: 'revoked' });
    });

    it('two live jira bindings on one thread are refused ambiguous; a disconnected one does not count', async () => {
        const first = await newConnection(OWNER.id);
        const second = await newConnection(OWNER.id);
        const { id, claim } = await running(null);
        await bind(id, first.id);
        await bind(id, second.id);
        expect(await check(id, claim.leaseToken)).toEqual({ ok: false, reason: 'ambiguous' });
        await store.disconnect(first.id, { userId: OWNER.id, admin: false });
        expect((await check(id, claim.leaseToken)).ok).toBe(true);
    });

    it("a reviewer row's lease gets nothing even if its root had bindings", async () => {
        const connection = await newConnection(null);
        const { id, claim } = await running(null);
        await bind(id, connection.id);
        await sql`
            update job set review_of = ${crypto.randomUUID()}, review_key = 'k', review_profile = 'security',
                           review_spec = ${sql.json({ name: 'security' })}, review_revision = 'abc',
                           review_ref = 'refs/factory/review/x'
            where id = ${id}`;
        expect(await check(id, claim.leaseToken)).toEqual({ ok: false, reason: 'lease' });
    });

    // Regression pin: the lease predicate already refuses a superseded attempt; the binding join must not loosen it.
    it('a superseded lease resolves nothing, even with a live binding', async () => {
        const connection = await newConnection(null);
        const { id, claim: first } = await running(null);
        await bind(id, connection.id);
        await expireLease(sql, id);
        const second = (await jobs.claim('w3', LEASE_SECONDS)) as Claim;
        expect(second.id).toBe(id);
        expect(await check(id, first.leaseToken)).toEqual({ ok: false, reason: 'lease' });
        expect((await check(id, second.leaseToken)).ok).toBe(true);
    });
});
