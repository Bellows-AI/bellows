import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import postgres, { type Sql } from 'postgres';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/auth/session.js';
import { createMembershipStore } from '../src/auth/membership-store.js';
import { type AuthStore, createAuthStore } from '../src/auth/store.js';
import type { AuditEventView } from '../src/db/audit-log.js';
import { createConnectionStore } from '../src/db/connection-store.js';
import { createEnvVarStore } from '../src/db/env-var-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { createOrgRegistry } from '../src/orgs.js';
import { type FakeAtlassian, startFakeAtlassian } from '../test/fake-atlassian.js';
import { githubAuth, testConfig } from '../test/helpers-config.js';
import { testSecretStore } from './env-secrets-harness.js';
import { mustCreate, oauthConnection, randomGithubId, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import { begin, connectionsOf, jiraRuntime, newTag, READ_SCOPE, script, WRITE_SCOPE } from './jira-rig.js';

/**
 * The organization's audit log: every audited action writes exactly one row naming its actor, action and target in
 * its own transaction, with no credential value anywhere in the row; an admin exports `[from,to)` as NDJSON and a
 * member is refused; the table refuses update and delete but for the organization's own cascade.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

const OK = 200;
const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const LEASE_SECONDS = 300;

interface Person {
    userId: string;
    token: string;
}

let sql: Sql;
let auth: AuthStore;
let app: FastifyInstance;
let org: string;
let otherOrg: string;
let admin: Person;
let member: Person;

interface Row {
    org_id: string;
    actor_kind: string;
    actor_id: string | null;
    action: string;
    target: string | null;
    detail: Record<string, unknown>;
}

/** The org's rows of `action`, oldest first; `kind` narrows them to one actor kind. */
const rowsOf = (action: string, orgId = org, kind: string | null = null) =>
    sql<Row[]>`
        select org_id, actor_kind, actor_id, action, target, detail from audit_event
        where org_id = ${orgId} and action = ${action} and (${kind}::text is null or actor_kind = ${kind})
        order by at, id
    `;

/** Exactly one row of `action` (of actor `kind`, if given), which holds none of `secrets` anywhere in it. */
async function onlyRow(action: string, secrets: readonly string[] = [], kind: string | null = null): Promise<Row> {
    const rows = await rowsOf(action, org, kind);
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows[0]);
    for (const secret of secrets) expect(text).not.toContain(secret);
    return rows[0]!;
}

async function personIn(orgId: string): Promise<Person> {
    const login = `u-${randomUUID().slice(0, 8)}`;
    const caller = await auth.signIn(
        { githubUserId: randomGithubId(), login, displayName: login, avatarUrl: null },
        orgId,
        [{ id: orgId, name: orgId }]
    );
    const token = `fat_${randomUUID()}`;
    await auth.createAccessToken({
        kind: 'personal',
        orgId,
        userId: caller.user.id,
        createdBy: caller.user.id,
        label: 'audit',
        tokenHash: hashToken(token),
    });
    return { userId: caller.user.id, token };
}

async function boot(store: AuthStore = auth): Promise<void> {
    const ready = Promise.resolve();
    const config = testConfig({ auth: githubAuth() });
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
        auth: store,
        ready,
        version: '0.0.0',
    });
}

beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    [org, otherOrg] = [testOrg(), testOrg()];
    for (const id of [org, otherOrg]) await sql`insert into organization (id, name) values (${id}, ${id})`;
    auth = createAuthStore({ sql });
    // The first account into an org is its admin; the next one is a member.
    admin = await personIn(org);
    member = await personIn(org);
    await boot();
});

afterEach(async () => {
    if (enabled) await app?.close();
});

const call = (who: Person, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object) =>
    app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${who.token}` },
        ...(payload === undefined ? {} : { payload }),
    });

describe.skipIf(!enabled)('audited actions write one row each', () => {
    it('a sign-in: the session row and its audit row, with no token hash', async () => {
        const hash = hashToken(`session-${randomUUID()}`);
        await auth.createSession(hash, member.userId, new Date(Date.now() + 60_000), org);
        const row = await onlyRow('auth.sign_in', [hash.toString('hex')]);
        expect(row).toMatchObject({ actor_kind: 'user', actor_id: member.userId, target: member.userId });
    });

    it('a personal token mint and revoke, neither holding the token', async () => {
        const token = `fat_${randomUUID()}`;
        const minted = await auth.createAccessToken({
            kind: 'personal',
            orgId: otherOrg,
            userId: admin.userId,
            createdBy: admin.userId,
            label: 'laptop',
            tokenHash: hashToken(token),
        });
        const mints = await rowsOf('token.personal.mint', otherOrg);
        expect(mints).toHaveLength(1);
        expect(mints[0]).toMatchObject({ actor_kind: 'user', actor_id: admin.userId, target: minted.id });
        expect(JSON.stringify(mints[0])).not.toContain(token);
        expect(JSON.stringify(mints[0])).not.toContain(hashToken(token).toString('hex'));

        expect(await auth.revokePersonalToken(otherOrg, admin.userId, minted.id)).toBe('revoked');
        expect(await auth.revokePersonalToken(otherOrg, admin.userId, minted.id)).toBe('missing');
        const revokes = await rowsOf('token.personal.revoke', otherOrg);
        expect(revokes).toHaveLength(1);
        expect(revokes[0]).toMatchObject({ actor_kind: 'user', actor_id: admin.userId, target: minted.id });
    });

    it('an org token mint and revoke, neither holding the token', async () => {
        const token = `oat_${randomUUID()}`;
        const minted = await auth.createAccessToken({
            kind: 'org',
            orgId: org,
            userId: null,
            createdBy: admin.userId,
            label: 'ci',
            tokenHash: hashToken(token),
        });
        const mint = await onlyRow('token.org.mint', [token, hashToken(token).toString('hex')]);
        expect(mint).toMatchObject({ actor_kind: 'user', actor_id: admin.userId, target: minted.id });

        expect(await auth.revokeOrgToken(org, minted.id, admin.userId)).toBe('revoked');
        expect(await auth.revokeOrgToken(org, minted.id, admin.userId)).toBe('missing');
        const revoke = await onlyRow('token.org.revoke');
        expect(revoke).toMatchObject({ actor_kind: 'user', actor_id: admin.userId, target: minted.id });
    });

    it('a role change through the route, and none for a refused or unchanged one', async () => {
        const url = `/api/org/members/${member.userId}/role`;
        // The sole admin's demotion is refused, so it records nothing.
        expect(
            (await call(admin, 'PUT', `/api/org/members/${admin.userId}/role`, { role: 'member' })).statusCode
        ).not.toBe(OK);
        expect((await call(admin, 'PUT', url, { role: 'admin' })).statusCode).toBe(OK);
        expect((await call(admin, 'PUT', url, { role: 'admin' })).statusCode).toBe(OK);
        const row = await onlyRow('member.role', [], 'user');
        expect(row).toMatchObject({ actor_kind: 'user', actor_id: admin.userId, target: member.userId });
        expect(row.detail).toEqual({ from: 'member', to: 'admin' });
    });

    it('the first member’s admin bootstrap, as the board’s own role change', async () => {
        const row = await onlyRow('member.role', [], 'system');
        expect(row).toMatchObject({ actor_id: null, target: admin.userId });
        expect(row.detail).toEqual({ from: 'member', to: 'admin', reason: 'first-member' });
    });

    it('an owner promotion at the GitHub re-check, and none when the role already holds', async () => {
        const memberships = createMembershipStore({ sql });
        await memberships.record(org, member.userId, { kind: 'active', owner: true }, new Date());
        await memberships.record(org, member.userId, { kind: 'active', owner: true }, new Date());
        const rows = (await rowsOf('member.role', org, 'system')).filter((row) => row.target === member.userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.detail).toEqual({ from: 'member', to: 'admin', reason: 'github-owner' });
    });

    it('a membership GitHub ends: at the re-check, by the webhook and at a sign-in that no longer reaches the org', async () => {
        const memberships = createMembershipStore({ sql });
        await memberships.record(org, member.userId, { kind: 'not-member' }, new Date());

        const third = await personIn(org);
        const [account] = await sql<{ github_user_id: string; github_login: string }[]>`
            select github_user_id::text as github_user_id, github_login from app_user where id = ${third.userId}::uuid
        `;
        expect(await auth.removeMember(org, Number(account!.github_user_id))).toBe(true);

        const fourth = await personIn(org);
        const [again] = await sql<{ github_user_id: string; github_login: string }[]>`
            select github_user_id::text as github_user_id, github_login from app_user where id = ${fourth.userId}::uuid
        `;
        await auth.signIn(
            {
                githubUserId: Number(again!.github_user_id),
                login: again!.github_login,
                displayName: null,
                avatarUrl: null,
            },
            otherOrg,
            [{ id: otherOrg, name: otherOrg }]
        );

        const rows = await rowsOf('member.remove', org, 'system');
        expect(rows.map((row) => [row.target, row.detail.reason])).toEqual([
            [member.userId, 'github-not-member'],
            [third.userId, 'github-webhook'],
            [fourth.userId, 'sign-in-sweep'],
        ]);
    });

    it('a member removal and restore through the routes', async () => {
        expect((await call(admin, 'DELETE', `/api/org/members/${member.userId}`)).statusCode).toBe(OK);
        const removed = await onlyRow('member.remove');
        expect(removed).toMatchObject({ actor_kind: 'user', actor_id: admin.userId, target: member.userId });

        expect((await call(admin, 'DELETE', `/api/org/members/removed/${member.userId}`)).statusCode).toBe(OK);
        const restored = await onlyRow('member.restore');
        expect(restored).toMatchObject({ actor_kind: 'user', actor_id: admin.userId, target: member.userId });
    });

    it('an env write at the org and workspace scopes through the routes, naming no secret value', async () => {
        const secret = `sekrit-${randomUUID()}`;
        const vars = [
            { name: 'PLAIN', value: 'p', isSecret: false },
            { name: 'API_KEY', value: secret, isSecret: true },
        ];
        expect((await call(admin, 'PUT', '/api/env/org', { vars })).statusCode).toBe(OK);
        expect((await call(member, 'PUT', '/api/env/workspace', { vars })).statusCode).toBe(OK);

        const rows = await rowsOf('env.write');
        expect(rows).toHaveLength(2);
        expect(JSON.stringify(rows)).not.toContain(secret);
        expect(rows[0]).toMatchObject({
            actor_id: admin.userId,
            target: 'org',
            detail: { names: ['API_KEY', 'PLAIN'] },
        });
        expect(rows[1]).toMatchObject({ actor_id: member.userId, target: `workspace/${member.userId}` });
    });

    it('an env write at the repository scope, naming no secret value', async () => {
        const secret = `sekrit-${randomUUID()}`;
        const env = createEnvVarStore({ sql, orgId: org, secrets: testSecretStore(sql), secretLog: () => {} });
        await env.replaceRepo(admin.userId, 'acme', 'web', [{ name: 'TOKEN', value: secret, isSecret: true }]);
        const row = await onlyRow('env.write', [secret]);
        expect(row).toMatchObject({ actor_kind: 'user', actor_id: admin.userId, target: 'repo/acme/web' });
    });

    it('a connection connect and disconnect', async () => {
        const made = await oauthConnection(sql, org, member.userId, { site: 'audit.atlassian.net' });
        const connect = await onlyRow('connection.connect');
        expect(connect).toMatchObject({ actor_kind: 'user', actor_id: member.userId, target: made.id });
        expect(connect.detail).toMatchObject({ provider: 'jira', site: 'audit.atlassian.net', access: 'read' });

        const store = createConnectionStore({ sql, orgId: org });
        expect((await store.disconnect(made.id, { userId: member.userId })).disconnected).toBe(true);
        expect((await store.disconnect(made.id, { userId: member.userId })).disconnected).toBe(false);
        const disconnect = await onlyRow('connection.disconnect');
        expect(disconnect).toMatchObject({ actor_kind: 'user', actor_id: member.userId, target: made.id });
    });

    describe('a connection access change', () => {
        let fake: FakeAtlassian;
        beforeEach(async () => {
            fake = await startFakeAtlassian();
        });
        afterEach(async () => {
            await fake.close();
        });

        it('a write consent changing a connection’s access writes one row, with no credential', async () => {
            const tag = newTag();
            const runtime = jiraRuntime(sql, fake);
            script(fake, { tag, sites: ['one'], scope: READ_SCOPE });
            await (await begin(runtime, org, member.userId)).complete();
            const [one] = await connectionsOf(sql, tag);
            script(fake, { tag, sites: ['one'], scope: WRITE_SCOPE });
            await (await begin(runtime, org, member.userId, { connectionId: one!.id, access: 'write' })).complete();

            const row = await onlyRow('connection.access', ['client-secret-1']);
            expect(row).toMatchObject({ actor_kind: 'user', actor_id: member.userId, target: one!.id });
            expect(row.detail).toMatchObject({ access: 'write' });
        });
    });

    describe('an admin action on another member’s task', () => {
        let store: JobStore;
        beforeEach(() => {
            store = createJobStore({ sql, orgId: org });
        });

        const claimOf = async (id: string): Promise<Claim> => {
            const claim = await store.claim(`w-${randomUUID()}`, LEASE_SECONDS);
            if (claim?.id !== id) throw new Error(`job ${id} was not claimed`);
            return claim;
        };

        const finish = async (claim: Claim): Promise<void> => {
            await store.session(claim.id, claim.leaseToken, randomUUID());
            await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        };

        it('a follow-up by an admin on a member’s task, and none for the owner’s own', async () => {
            const { id } = await mustCreate(store.create('member task', member.userId, { repo: null, executor: null }));
            await finish(await claimOf(id));

            const turn = await store.createFollowUp(id, 'admin says', admin.userId, undefined, undefined, true);
            if (typeof turn === 'string') throw new Error(`refused: ${turn}`);
            const row = await onlyRow('task.admin_action');
            expect(row).toMatchObject({ actor_kind: 'user', actor_id: admin.userId, target: turn.id });
            expect(row.detail).toMatchObject({ action: 'follow-up', owner: member.userId });

            // The owner's own follow-up is no admin action.
            await finish(await claimOf(turn.id));
            expect(typeof (await store.createFollowUp(turn.id, 'owner says', member.userId))).not.toBe('string');
            await onlyRow('task.admin_action');
        });
    });
});

describe.skipIf(!enabled)('the audit table is append-only', () => {
    it('refuses an update and a delete of a live organization’s row', async () => {
        const [row] = await sql<{ id: string }[]>`select id from audit_event where org_id = ${org} limit 1`;
        await expect(sql`update audit_event set action = 'forged' where id = ${row!.id}`).rejects.toMatchObject({
            constraint_name: 'audit_event_append_only',
        });
        await expect(sql`delete from audit_event where id = ${row!.id}`).rejects.toMatchObject({
            constraint_name: 'audit_event_append_only',
        });
        await expect(sql`update audit_event set org_id = ${otherOrg} where id = ${row!.id}`).rejects.toMatchObject({
            constraint_name: 'audit_event_append_only',
        });
    });

    it('lets the organization’s own cascade move and purge its rows', async () => {
        const before = (await sql`select id from audit_event where org_id = ${org}`).length;
        expect(before).toBeGreaterThan(0);
        const moved = `${org}-moved`;
        await sql`update organization set id = ${moved} where id = ${org}`;
        expect(await sql`select id from audit_event where org_id = ${moved}`).toHaveLength(before);
        await sql`delete from organization where id = ${moved}`;
        expect(await sql`select id from audit_event where org_id = ${moved}`).toHaveLength(0);
    });
});

const ndjson = (body: string): AuditEventView[] =>
    body
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as AuditEventView);

describe.skipIf(!enabled)('GET /api/audit', () => {
    /** Three rows an hour apart in the org, one in another org. */
    async function seedHours(): Promise<string[]> {
        const at = ['2026-01-01T10:00:00.000Z', '2026-01-01T11:00:00.000Z', '2026-01-01T12:00:00.000Z'];
        for (const [i, stamp] of at.entries()) {
            await sql`
                insert into audit_event (org_id, at, actor_kind, actor_id, action, target)
                values (${org}, ${stamp}, 'user', ${admin.userId}, 'test.hour', ${`t${i}`})
            `;
        }
        await sql`
            insert into audit_event (org_id, at, actor_kind, actor_id, action, target)
            values (${otherOrg}, ${at[1]!}, 'user', ${admin.userId}, 'test.hour', 'elsewhere')
        `;
        return at;
    }

    it('streams the org’s rows in [from,to) as NDJSON to an admin', async () => {
        const at = await seedHours();
        const response = await call(admin, 'GET', `/api/audit?from=${at[0]}&to=${at[2]}`);
        expect(response.statusCode).toBe(OK);
        expect(response.headers['content-type']).toContain('application/x-ndjson');
        const rows = ndjson(response.body);
        expect(rows.map((row) => row.target)).toEqual(['t0', 't1']);
        expect(rows[0]).toMatchObject({ actorKind: 'user', actorId: admin.userId, action: 'test.hour', at: at[0] });
        expect(rows[0]!.actorLogin).toMatch(/^u-/);
    });

    it('refuses a member with 403', async () => {
        const at = await seedHours();
        const response = await call(member, 'GET', `/api/audit?from=${at[0]}&to=${at[2]}`);
        expect(response.statusCode).toBe(FORBIDDEN);
    });

    it('refuses a missing, unparseable or empty range with 400 BAD_RANGE', async () => {
        for (const query of ['', '?from=2026-01-01', '?from=nope&to=2026-01-02', '?from=2026-01-02&to=2026-01-01']) {
            const response = await call(admin, 'GET', `/api/audit${query}`);
            expect(response.statusCode, query).toBe(BAD_REQUEST);
            expect(response.json().code).toBe('BAD_RANGE');
        }
    });

    it('settles when the read fails mid-stream', async () => {
        await app.close();
        const failing: AuthStore = {
            ...auth,
            async *auditEvents() {
                yield { id: '1', at: '2026-01-01T00:00:00.000Z' } as AuditEventView;
                throw new Error('read failed');
            },
        };
        await boot(failing);
        const settled = await Promise.race([
            call(admin, 'GET', '/api/audit?from=2026-01-01&to=2026-01-02').then(
                () => 'settled',
                () => 'settled'
            ),
            new Promise((resolve) => setTimeout(() => resolve('hung'), 5_000)),
        ]);
        expect(settled).toBe('settled');
    });

    it('ends the read when the client goes away mid-stream', async () => {
        await app.close();
        let ended = false;
        const endless: AuthStore = {
            ...auth,
            async *auditEvents() {
                try {
                    for (let i = 0; ; i += 1) {
                        yield { id: String(i), at: '2026-01-01T00:00:00.000Z' } as AuditEventView;
                        await new Promise((resolve) => setTimeout(resolve, 5));
                    }
                } finally {
                    ended = true;
                }
            },
        };
        await boot(endless);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const { port } = app.server.address() as AddressInfo;
        await new Promise<void>((resolve, reject) => {
            const request = get(
                {
                    host: '127.0.0.1',
                    port,
                    path: '/api/audit?from=2026-01-01&to=2026-01-02',
                    headers: { authorization: `Bearer ${admin.token}` },
                },
                (response) => {
                    response.once('data', () => {
                        request.destroy();
                        resolve();
                    });
                }
            );
            request.on('error', (error) => (request.destroyed ? resolve() : reject(error)));
        });
        await expect.poll(() => ended, { timeout: 5_000 }).toBe(true);
    });

    it('the store’s read releases its connection when the consumer stops early', async () => {
        await seedHours();
        const one = postgres(db.url!, { max: 1 });
        try {
            const store = createAuthStore({ sql: one });
            for await (const row of store.auditEvents(org, {
                from: new Date('2026-01-01T00:00:00Z'),
                to: new Date('2026-01-02T00:00:00Z'),
            })) {
                expect(row.action).toBe('test.hour');
                break;
            }
            const [answer] = await Promise.race([
                one<{ ok: number }[]>`select 1 as ok`,
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('pool held')), 5_000)),
            ]);
            expect(answer?.ok).toBe(1);
        } finally {
            await one.end();
        }
    });
});
