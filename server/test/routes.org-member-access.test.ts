import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { MembershipReader, RosterAnswer } from '../src/auth/membership.js';
import { githubAuth, memoryAuthStore, signedIn, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';
import type { MemoryAuthStore } from './helpers-auth-store.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_CONFLICT,
    HTTP_NOT_FOUND,
    HTTP_OK,
    HTTP_UNAUTHORIZED,
    trackApps,
} from './helpers-http.js';

/**
 * Offline: the HTTP contract of an admin's member access routes — remove, the removed list, restore, and the
 * invitation read (the shareable sign-in link beside GitHub's members who have not signed in) — against the
 * in-memory store double. The block row's SQL, and that a removed account's next sign-in stays out, are
 * server/test-db/auth-membership.test.ts's.
 */

const track = trackApps();
const ORG = 'test-org';

async function boot(roster?: Pick<MembershipReader, 'roster'>): Promise<{
    instance: FastifyInstance;
    auth: MemoryAuthStore;
    admin: ReturnType<MemoryAuthStore['seedMember']>;
    member: ReturnType<MemoryAuthStore['seedMember']>;
    adminCookie: string;
    memberCookie: string;
}> {
    const auth = memoryAuthStore();
    const admin = auth.seedMember(ORG, 'admin-cat', 'admin');
    const member = auth.seedMember(ORG, 'octocat');
    const config = testConfig({ auth: githubAuth({ publicUrl: 'https://board.example.test' }) });
    const instance = await buildApp({
        config,
        orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
        auth,
        ...(roster ? { githubRoster: roster } : {}),
    });
    track(instance);
    return {
        instance,
        auth,
        admin,
        member,
        adminCookie: await signedIn(auth, admin),
        memberCookie: await signedIn(auth, member),
    };
}

const as = (cookie: string) => ({ cookie });

describe('DELETE /api/org/members/:userId', () => {
    it('removes a member: their cookie is refused at once, the roster drops them, the removed list names them', async () => {
        const { instance, auth, admin, member, adminCookie, memberCookie } = await boot();

        const removed = await instance.inject({
            method: 'DELETE',
            url: `/api/org/members/${member.user.id}`,
            headers: as(adminCookie),
        });
        expect(removed.statusCode).toBe(HTTP_OK);
        expect(removed.json()).toEqual({ userId: member.user.id, removed: true });

        expect(
            (await instance.inject({ method: 'GET', url: '/api/tokens', headers: as(memberCookie) })).statusCode
        ).toBe(HTTP_UNAUTHORIZED);
        expect((await auth.listMembers(ORG)).map((m) => m.githubLogin)).toEqual(['admin-cat']);

        const list = await instance.inject({
            method: 'GET',
            url: '/api/org/members/removed',
            headers: as(adminCookie),
        });
        expect(list.statusCode).toBe(HTTP_OK);
        expect(list.json()).toEqual({
            removed: [
                {
                    userId: member.user.id,
                    githubLogin: 'octocat',
                    removedAt: expect.any(String),
                    removedBy: admin.user.login,
                },
            ],
        });
    });

    it('refuses removing the last admin, an unknown id and a non-uuid, and changes nothing', async () => {
        const { instance, auth, admin, adminCookie } = await boot();
        const last = await instance.inject({
            method: 'DELETE',
            url: `/api/org/members/${admin.user.id}`,
            headers: as(adminCookie),
        });
        expect(last.statusCode).toBe(HTTP_CONFLICT);
        expect(last.json()).toMatchObject({ code: 'LAST_ADMIN' });

        const elsewhere = auth.seedMember('other-org', 'elsewhere-cat');
        for (const id of [elsewhere.user.id, crypto.randomUUID()]) {
            const missing = await instance.inject({
                method: 'DELETE',
                url: `/api/org/members/${id}`,
                headers: as(adminCookie),
            });
            expect(missing.statusCode).toBe(HTTP_NOT_FOUND);
        }
        const bad = await instance.inject({ method: 'DELETE', url: '/api/org/members/nope', headers: as(adminCookie) });
        expect(bad.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(bad.json()).toMatchObject({ code: 'BAD_ID' });

        expect((await auth.listMembers(ORG)).map((m) => m.githubLogin)).toEqual(['admin-cat', 'octocat']);
        expect(await auth.listRemovedMembers(ORG)).toEqual([]);
        expect(await auth.listRemovedMembers('other-org')).toEqual([]);
    });
});

describe('DELETE /api/org/members/removed/:userId', () => {
    it('restores a removal once; a second restore, or one of nobody, is 404', async () => {
        const { instance, member, adminCookie } = await boot();
        await instance.inject({
            method: 'DELETE',
            url: `/api/org/members/${member.user.id}`,
            headers: as(adminCookie),
        });

        const url = `/api/org/members/removed/${member.user.id}`;
        const restored = await instance.inject({ method: 'DELETE', url, headers: as(adminCookie) });
        expect(restored.statusCode).toBe(HTTP_OK);
        expect(restored.json()).toEqual({ userId: member.user.id, restored: true });
        expect(
            (await instance.inject({ method: 'GET', url: '/api/org/members/removed', headers: as(adminCookie) })).json()
        ).toEqual({ removed: [] });

        expect((await instance.inject({ method: 'DELETE', url, headers: as(adminCookie) })).statusCode).toBe(
            HTTP_NOT_FOUND
        );
        const bad = await instance.inject({
            method: 'DELETE',
            url: '/api/org/members/removed/nope',
            headers: as(adminCookie),
        });
        expect(bad.statusCode).toBe(HTTP_BAD_REQUEST);
    });
});

describe('GET /api/org/members/invitations', () => {
    // `reselect=1` opens the selection screen even for an account that already tracks other organizations, so the
    // invitee (or a restored member) can tick this one; the org arrives marked as requested.
    const SIGN_IN = `https://board.example.test/api/auth/github?org=${ORG}&reselect=1`;

    it('lists GitHub’s members who have neither signed in nor been removed, each reached by the sign-in link', async () => {
        const asked: string[] = [];
        let removedId = 0;
        const roster = {
            async roster(org: { id: string; login: string }): Promise<RosterAnswer> {
                asked.push(`${org.id}:${org.login}`);
                return {
                    kind: 'listed',
                    members: [
                        { githubUserId: 9001, login: 'zeta-cat' },
                        { githubUserId: 1, login: 'admin-cat' },
                        { githubUserId: removedId, login: 'octocat' },
                        { githubUserId: 9002, login: 'alpha-cat' },
                    ],
                };
            },
        };
        const { instance, member, adminCookie } = await boot(roster);
        removedId = member.user.githubUserId;
        await instance.inject({
            method: 'DELETE',
            url: `/api/org/members/${member.user.id}`,
            headers: as(adminCookie),
        });

        const response = await instance.inject({
            method: 'GET',
            url: '/api/org/members/invitations',
            headers: as(adminCookie),
        });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({
            signInUrl: SIGN_IN,
            github: {
                state: 'listed',
                people: [
                    { githubUserId: 9002, login: 'alpha-cat' },
                    { githubUserId: 9001, login: 'zeta-cat' },
                ],
            },
        });
        expect(asked).toEqual([`${ORG}:${ORG}`]);
    });

    it('still serves the sign-in link when GitHub’s member list cannot be read, and says so', async () => {
        const unknown = { roster: async (): Promise<RosterAnswer> => ({ kind: 'unknown', reason: 'answered 403' }) };
        for (const roster of [unknown, undefined]) {
            const { instance, adminCookie } = await boot(roster);
            const body = (
                await instance.inject({
                    method: 'GET',
                    url: '/api/org/members/invitations',
                    headers: as(adminCookie),
                })
            ).json();
            expect(body.signInUrl).toBe(SIGN_IN);
            expect(body.github).toMatchObject({ state: 'unavailable', reason: expect.any(String) });
        }
    });
});
