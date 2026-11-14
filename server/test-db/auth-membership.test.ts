import { randomUUID } from 'node:crypto';
import { ADMIN_ROLE, MEMBER_ROLE } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createMembershipGuard } from '../src/auth/membership-guard.js';
import { createMembershipReader } from '../src/auth/membership.js';
import { createMembershipStore } from '../src/auth/membership-store.js';
import { SESSION_COOKIE, hashToken, sign } from '../src/auth/session.js';
import { createAuthStore, type InstallationRef } from '../src/auth/store.js';
import { TEST_SESSION_SECRET } from '../test/helpers-config.js';
import { FAKE_GITHUB_API, fakeGitHubMembers, type MembershipAnswer } from '../test/helpers-github-members.js';
import { githubAuth, staticRegistry, telemetryStoreStub, testConfig } from '../test/helpers.js';
import { randomGithubId, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);
const TTL_MS = 10 * 60_000;
const db = useTestDb();

let sql: Sql;
beforeAll(() => {
    if (enabled) sql = db.sql;
});

interface Person {
    githubUserId: number;
    login: string;
    displayName: string;
    avatarUrl: null;
}

const person = (login: string): Person => ({
    githubUserId: randomGithubId(),
    login,
    displayName: login,
    avatarUrl: null,
});

/** One organization installation (members:read granted unless the fake says otherwise) and the board around it. */
const rig = () => {
    const github = fakeGitHubMembers();
    const login = `acme-${randomUUID().slice(0, 8)}`;
    const accountId = randomGithubId();
    github.orgs.set(login, accountId);
    const install: InstallationRef = { id: testOrg(), name: login, accountType: 'Organization', accountId };
    let nowMs = Date.now();
    const base = createAuthStore({ sql });
    const membership = createMembershipStore({ sql });
    const reader = createMembershipReader({
        apiUrl: FAKE_GITHUB_API,
        tokenFor: async () => 'ghs_installation',
        fetchFn: github.fetchFn,
        timeoutMs: 200,
    });
    const guard = createMembershipGuard({ store: base, membership, reader, ttlMs: TTL_MS, now: () => nowMs });
    const known = (who: Person) => github.users.set(who.githubUserId, who.login);
    const signIn = (who: Person, installs: InstallationRef[] = [install]) => {
        known(who);
        return guard.store.signIn(who, installs[0]!.id, installs);
    };
    const set = (who: Person, answer: MembershipAnswer) => github.answer(login, who.login, answer);
    const credentials = async (caller: { user: { id: string } }, orgId = install.id) => {
        const session = `session-${randomUUID()}`;
        const token = `fat_${randomUUID()}`;
        await base.createSession(hashToken(session), caller.user.id, new Date(nowMs + 86_400_000), orgId);
        await base.createAccessToken({
            kind: 'personal',
            orgId,
            userId: caller.user.id,
            createdBy: caller.user.id,
            label: 'cli',
            tokenHash: hashToken(token),
        });
        return { session: hashToken(session), token: hashToken(token), sessionValue: session, tokenValue: token };
    };
    const roleOf = async (userId: string): Promise<string | null> => {
        const rows = await sql<{ role: string }[]>`
            select role from org_membership where org_id = ${install.id} and user_id = ${userId}
        `;
        return rows[0]?.role ?? null;
    };
    return {
        github,
        install,
        base,
        membership,
        guard,
        signIn,
        set,
        credentials,
        roleOf,
        advance: (ms: number) => {
            nowMs += ms;
        },
    };
};

describe.runIf(enabled)('membership re-check against GitHub', () => {
    it('refuses a member removed on GitHub at the first request past the TTL: session and personal token both', async () => {
        const board = rig();
        const alice = person('alice');
        board.set(alice, 'member');
        const caller = await board.signIn(alice);
        const creds = await board.credentials(caller);

        board.set(alice, 'absent');
        // Within the TTL the stored check stands, and GitHub is not asked again.
        const asked = board.github.calls.length;
        expect(await board.guard.store.findSession(creds.session)).not.toBeNull();
        expect(await board.guard.store.findPersonalToken(creds.token)).not.toBeNull();
        expect(board.github.calls.length).toBe(asked);

        board.advance(TTL_MS + 1);
        expect(await board.guard.store.findSession(creds.session)).toBeNull();
        expect(await board.guard.store.findPersonalToken(creds.token)).toBeNull();

        // Revoked, not merely unjoined: the session row is gone and the token is marked.
        const sessions = await sql`select 1 from session where token_hash = ${creds.session}`;
        expect(sessions).toHaveLength(0);
        const [token] = await sql<{ revoked_at: Date | null }[]>`
            select revoked_at from access_token where token_hash = ${creds.token}
        `;
        expect(token?.revoked_at).not.toBeNull();
        expect(await board.roleOf(caller.user.id)).toBeNull();
    });

    it('answers 401 to the removed member’s cookie and bearer on a real route', async () => {
        const board = rig();
        const alice = person('alice');
        board.set(alice, 'member');
        const caller = await board.signIn(alice);
        const creds = await board.credentials(caller);
        const config = testConfig({ auth: githubAuth() });
        const app = await buildApp({
            config,
            orgs: staticRegistry({ config }),
            store: telemetryStoreStub(),
            auth: board.guard.store,
        });
        try {
            const cookie = `${SESSION_COOKIE}=${sign(creds.sessionValue, TEST_SESSION_SECRET)}`;
            const bearer = `Bearer ${creds.tokenValue}`;
            expect((await app.inject({ url: '/api/tokens', headers: { cookie } })).statusCode).toBe(200);
            board.set(alice, 'absent');
            board.advance(TTL_MS + 1);
            expect((await app.inject({ url: '/api/tokens', headers: { cookie } })).statusCode).toBe(401);
            expect((await app.inject({ url: '/api/tokens', headers: { authorization: bearer } })).statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('revokes an idle removed member in the interval pass', async () => {
        const board = rig();
        const alice = person('alice');
        const bob = person('bob');
        board.set(alice, 'admin');
        board.set(bob, 'member');
        await board.signIn(alice);
        const caller = await board.signIn(bob);
        const creds = await board.credentials(caller);

        board.set(bob, 'absent');
        await board.guard.pass();
        expect(await board.roleOf(caller.user.id)).toBe(MEMBER_ROLE);

        board.advance(TTL_MS + 1);
        await board.guard.pass();
        expect(await board.roleOf(caller.user.id)).toBeNull();
        expect(await board.base.findPersonalToken(creds.token)).toBeNull();
        const sessions = await sql`select 1 from session where token_hash = ${creds.session}`;
        expect(sessions).toHaveLength(0);
    });

    it.each<[string, MembershipAnswer]>([
        ['a server error', { status: 502, body: 'bad gateway' }],
        ['a malformed body', { status: 200, body: '<html>' }],
        ['an unexpected shape', { status: 200, body: '{"role":"member"}' }],
        ['a transport failure', 'throw'],
        ['a timeout', 'hang'],
        ['a missing members:read permission', { status: 403, body: '{"message":"Resource not accessible"}' }],
    ])('revokes nothing on %s', async (_, answer) => {
        const board = rig();
        const alice = person('alice');
        board.set(alice, 'member');
        const caller = await board.signIn(alice);
        const creds = await board.credentials(caller);

        board.set(alice, answer);
        board.advance(TTL_MS + 1);
        await board.guard.pass();
        board.advance(TTL_MS + 1);
        expect(await board.guard.store.findSession(creds.session)).not.toBeNull();
        expect(await board.guard.store.findPersonalToken(creds.token)).not.toBeNull();
        expect(await board.roleOf(caller.user.id)).not.toBeNull();
    });

    it('revokes nothing when a 404 cannot be confirmed (the org login now names another organization)', async () => {
        const board = rig();
        const alice = person('alice');
        board.set(alice, 'member');
        const caller = await board.signIn(alice);
        board.set(alice, 'absent');
        board.github.orgs.set(board.install.name, 1);
        board.advance(TTL_MS + 1);
        await board.guard.pass();
        expect(await board.roleOf(caller.user.id)).not.toBeNull();
    });

    it('signs a GitHub org owner in as admin, and a first signer who is not one as a member', async () => {
        const board = rig();
        const alice = person('alice');
        const owner = person('owner');
        board.set(alice, 'member');
        board.set(owner, 'admin');
        const first = await board.signIn(alice);
        expect(first.role).toBe(MEMBER_ROLE);
        const second = await board.signIn(owner);
        expect(second.role).toBe(ADMIN_ROLE);
    });

    it('promotes a member made a GitHub owner at the re-check, and never demotes an admin GitHub calls a member', async () => {
        const board = rig();
        const owner = person('owner');
        const alice = person('alice');
        board.set(owner, 'admin');
        board.set(alice, 'member');
        const ownerCaller = await board.signIn(owner);
        const aliceCaller = await board.signIn(alice);
        board.set(owner, 'member');
        board.set(alice, 'admin');
        board.advance(TTL_MS + 1);
        await board.guard.pass();
        expect(await board.roleOf(ownerCaller.user.id)).toBe(ADMIN_ROLE);
        expect(await board.roleOf(aliceCaller.user.id)).toBe(ADMIN_ROLE);
    });

    it('keeps an admin-removed member out at the next sign-in until an admin restores them', async () => {
        const board = rig();
        const owner = person('owner');
        const alice = person('alice');
        const other = {
            id: testOrg(),
            name: `other-${randomUUID().slice(0, 8)}`,
            accountType: 'Organization',
            accountId: 1,
        };
        board.github.orgs.set(other.name, 1);
        board.github.answer(other.name, alice.login, 'member');
        board.set(owner, 'admin');
        board.set(alice, 'member');
        const admin = await board.signIn(owner);
        const caller = await board.signIn(alice, [board.install, other]);
        const creds = await board.credentials(caller);

        expect(await board.membership.block(board.install.id, caller.user.id, admin.user.id)).toBe('removed');
        expect(await board.guard.store.findSession(creds.session)).toBeNull();
        expect(await board.guard.store.findPersonalToken(creds.token)).toBeNull();

        // GitHub still reports the installation; the block holds anyway, and the sign-in lands in the other org.
        const again = await board.signIn(alice, [board.install, other]);
        expect(again.org.id).toBe(other.id);
        expect(await board.roleOf(caller.user.id)).toBeNull();
        // Signing in with the blocked org alone resolves no membership at all.
        await expect(board.signIn(alice)).rejects.toThrow();
        expect(await board.roleOf(caller.user.id)).toBeNull();

        expect(await board.membership.restore(board.install.id, caller.user.id, admin.user.id)).toBe('restored');
        expect(await board.membership.restore(board.install.id, caller.user.id, admin.user.id)).toBe('missing');
        const restored = await board.signIn(alice);
        expect(restored.org.id).toBe(board.install.id);
        expect(restored.role).toBe(MEMBER_ROLE);
    });

    it('refuses removing the last admin, and reports a removal of nobody as missing', async () => {
        const board = rig();
        const owner = person('owner');
        board.set(owner, { status: 403, body: '{}' });
        const admin = await board.signIn(owner);
        expect(admin.role).toBe(ADMIN_ROLE);
        expect(await board.membership.block(board.install.id, admin.user.id, admin.user.id)).toBe('last-admin');
        expect(await board.roleOf(admin.user.id)).toBe(ADMIN_ROLE);
        expect(await board.membership.block(board.install.id, randomUUID(), admin.user.id)).toBe('missing');
    });

    it('keeps today’s first-sign-in bootstrap for an installation without members:read, and never demotes', async () => {
        const board = rig();
        const alice = person('alice');
        const bob = person('bob');
        const noPermission: MembershipAnswer = { status: 403, body: '{"message":"Resource not accessible"}' };
        board.set(alice, noPermission);
        board.set(bob, noPermission);
        const first = await board.signIn(alice);
        expect(first.role).toBe(ADMIN_ROLE);
        const second = await board.signIn(bob);
        expect(second.role).toBe(MEMBER_ROLE);
        board.advance(TTL_MS + 1);
        await board.guard.pass();
        expect(await board.roleOf(first.user.id)).toBe(ADMIN_ROLE);
        expect(await board.roleOf(second.user.id)).toBe(MEMBER_ROLE);
    });

    it('takes a user-account installation’s account as its owner', async () => {
        const board = rig();
        const me = person('solo');
        const other = person('collaborator');
        const install: InstallationRef = {
            id: testOrg(),
            name: me.login,
            accountType: 'User',
            accountId: me.githubUserId,
        };
        // Somebody else materializes the installation first; the account itself still lands admin.
        const first = await board.signIn(other, [install]);
        const caller = await board.signIn(me, [install]);
        expect(caller.role).toBe(ADMIN_ROLE);
        board.advance(TTL_MS + 1);
        await board.guard.pass();
        const rows = await sql<{ user_id: string }[]>`select user_id from org_membership where org_id = ${install.id}`;
        expect(rows.map((row) => row.user_id).sort()).toEqual([first.user.id, caller.user.id].sort());
        expect(board.github.calls.filter((path) => path.startsWith('/orgs/'))).toEqual([]);
    });
});

describe.runIf(enabled)('every membership deletion ends the credentials with it', () => {
    /** Alice in the board's org and a second one, with a session and a personal token in the board's org. */
    const twoOrgs = async () => {
        const board = rig();
        const alice = person('alice');
        const other: InstallationRef = {
            id: testOrg(),
            name: `other-${randomUUID().slice(0, 8)}`,
            accountType: 'Organization',
            accountId: 1,
        };
        board.github.orgs.set(other.name, 1);
        board.github.answer(other.name, alice.login, 'member');
        board.set(alice, 'member');
        const caller = await board.signIn(alice, [board.install, other]);
        const creds = await board.credentials(caller);
        return { board, alice, other, caller, creds };
    };

    const revoked = async (creds: { session: Buffer; token: Buffer }) => {
        const sessions = await sql`select 1 from session where token_hash = ${creds.session}`;
        const [token] = await sql<{ revoked_at: Date | null }[]>`
            select revoked_at from access_token where token_hash = ${creds.token}
        `;
        return sessions.length === 0 && token?.revoked_at !== null;
    };

    it('a confirmed non-member at sign-in', async () => {
        const { board, alice, other, creds } = await twoOrgs();
        board.set(alice, 'absent');
        const again = await board.signIn(alice, [board.install, other]);
        expect(again.org.id).toBe(other.id);
        expect(await revoked(creds)).toBe(true);
        // Rejoining on GitHub mints a membership, never revives the old credentials.
        board.set(alice, 'member');
        await board.signIn(alice, [board.install, other]);
        expect(await board.base.findSession(creds.session)).toBeNull();
        expect(await board.base.findPersonalToken(creds.token)).toBeNull();
    });

    it('an installation GitHub no longer reports at sign-in', async () => {
        const { board, alice, other, creds } = await twoOrgs();
        await board.signIn(alice, [other]);
        expect(await revoked(creds)).toBe(true);
    });

    it('the webhook’s GitHub-side removal', async () => {
        const { board, alice, creds } = await twoOrgs();
        expect(await board.base.removeMember(board.install.id, alice.githubUserId)).toBe(true);
        expect(await revoked(creds)).toBe(true);
    });
});

describe.runIf(enabled)('an admin’s removals, through the auth store', () => {
    it('lists the org’s removals with who removed them, restores one, and names who GitHub may still invite', async () => {
        const board = rig();
        const owner = person('owner');
        const alice = person('alice');
        const bob = person('bob');
        board.set(owner, 'admin');
        board.set(alice, 'member');
        board.set(bob, 'member');
        const admin = await board.signIn(owner);
        const caller = await board.signIn(alice);
        await board.signIn(bob);

        expect(await board.base.blockMember(board.install.id, caller.user.id, admin.user.id)).toBe('removed');
        expect(await board.base.blockMember(board.install.id, admin.user.id, admin.user.id)).toBe('last-admin');
        expect(await board.base.listRemovedMembers(board.install.id)).toEqual([
            { userId: caller.user.id, githubLogin: 'alice', removedAt: expect.any(String), removedBy: 'owner' },
        ]);
        expect(await board.base.listRemovedMembers(testOrg())).toEqual([]);
        await expect(board.signIn(alice)).rejects.toThrow();

        // Everyone signed in or removed is accounted for; the org is described for GitHub's member list.
        const basis = await board.base.invitationBasis(board.install.id);
        expect(basis?.org).toEqual(board.install);
        expect([...(basis?.githubUserIds ?? [])].sort()).toEqual(
            [owner.githubUserId, alice.githubUserId, bob.githubUserId].sort()
        );
        expect(await board.base.invitationBasis(testOrg())).toBeNull();

        expect(await board.base.restoreMember(board.install.id, caller.user.id, admin.user.id)).toBe('restored');
        expect(await board.base.restoreMember(board.install.id, caller.user.id, admin.user.id)).toBe('missing');
        expect(await board.base.listRemovedMembers(board.install.id)).toEqual([]);
        expect((await board.signIn(alice)).org.id).toBe(board.install.id);
    });
});
