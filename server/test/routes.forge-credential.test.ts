import { gitlabForgeOf, type RepoRef } from '@factory-ai/core';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AttemptCheck } from '../src/db/attempt-of-lease.js';
import type { MemberForgeGrants, MemberTokenResult } from '../src/integrations/member-forge-grant.js';
import { forgeCredentialRoutes } from '../src/routes/forge-credential.js';

/**
 * Offline: the attempt's GitLab credential answer (docs/connections.md) against a stub attempt check and a stub grant.
 * The grant's refresh, the wait and a cancel against real rows are pinned by server/test-db/gitlab-credential.test.ts
 * and gitlab-loss.test.ts.
 */

const HOST = 'gitlab.example.test';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const STARTER = '66666666-6666-4666-8666-666666666666';
const TOKEN = 'glpat-route-test-secret-token';
const EXPIRES_MS = Date.parse('2026-10-16T13:00:00.000Z');
const OK = 200;
const FORBIDDEN = 403;
const UNAVAILABLE = 503;
const PAIR = { 'x-factory-job-id': JOB_ID, 'x-factory-job-lease-token': LEASE };
const gitlabRepo = (host: string, path: string): RepoRef => ({ forge: 'gitlab', host, path });
const LIVE: AttemptCheck = {
    ok: true,
    orgId: 'local',
    jobId: JOB_ID,
    rootJobId: JOB_ID,
    repo: 'grp/web',
    rootRepo: 'grp/web',
    ref: gitlabRepo(HOST, 'grp/web'),
    rootRef: gitlabRepo(HOST, 'grp/web'),
    executionUserId: STARTER,
    claimSeq: 1,
};

interface Boot {
    answers?: AttemptCheck[];
    grant?: (userId: string, forge: string) => Promise<MemberTokenResult>;
}

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function boot({ answers = [LIVE], grant }: Boot = {}) {
    const asked: { userId: string; forge: string }[] = [];
    let call = 0;
    const memberGrants = {
        accessToken: async (_org: string, userId: string, forge: string) => {
            asked.push({ userId, forge });
            return grant ? grant(userId, forge) : { ok: true as const, accessToken: TOKEN, expiresAt: EXPIRES_MS };
        },
    } as unknown as MemberForgeGrants;
    const app = Fastify();
    apps.push(app);
    await app.register(
        forgeCredentialRoutes({
            attemptOfLease: async (jobId, leaseToken) => {
                const answer = answers[Math.min(call, answers.length - 1)] ?? { ok: false, pending: false };
                call += 1;
                return jobId === JOB_ID && leaseToken === LEASE ? answer : { ok: false, pending: false };
            },
            memberGrants,
            orgs: { for: async () => undefined } as never,
            publicUrl: 'https://board.example.test',
        })
    );
    const post = (headers: Record<string, string> = PAIR) =>
        app.inject({ method: 'POST', url: `/api/jobs/${JOB_ID}/credentials/gitlab`, headers });
    return { post, asked, calls: () => call };
}

describe('POST /api/jobs/:id/credentials/gitlab', () => {
    it('answers the starter’s access token and its expiry, never cached', async () => {
        const { post, asked } = await boot();
        const res = await post();
        expect(res.statusCode).toBe(OK);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.json()).toEqual({
            forge: gitlabForgeOf(HOST),
            standing: 'live',
            token: TOKEN,
            expiresAt: '2026-10-16T13:00:00.000Z',
        });
        // The root execution user's grant, on the claim-derived host.
        expect(asked).toEqual([{ userId: STARTER, forge: gitlabForgeOf(HOST) }]);
    });

    it('answers a null expiry for a token that carries none', async () => {
        const { post } = await boot({ grant: async () => ({ ok: true, accessToken: TOKEN, expiresAt: null }) });
        expect((await post()).json()).toMatchObject({ token: TOKEN, expiresAt: null });
    });

    it('checks the attempt again after the token is read, and withholds it from a superseded pair', async () => {
        const { post, calls } = await boot({ answers: [LIVE, { ok: false, pending: true }] });
        const res = await post();
        expect(calls()).toBe(2);
        expect(res.statusCode).toBe(UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'LEASE_PENDING' });
        expect(res.body).not.toContain(TOKEN);
    });

    it('withholds the token from an attempt cancelled or settled during the refresh', async () => {
        const { post } = await boot({ answers: [LIVE, { ok: false, pending: false }] });
        const res = await post();
        expect(res.statusCode).toBe(FORBIDDEN);
        expect(res.body).not.toContain(TOKEN);
    });

    it('withholds the token when the pair now names another org or claim', async () => {
        const moved = await boot({ answers: [LIVE, { ...LIVE, orgId: 'other' }] });
        expect((await moved.post()).statusCode).toBe(FORBIDDEN);
        const reclaimed = await boot({ answers: [LIVE, { ...LIVE, claimSeq: 2 }] });
        expect((await reclaimed.post()).statusCode).toBe(FORBIDDEN);
    });

    it('answers a superseded pair 503 LEASE_PENDING without asking for a token, and an unknown pair 403', async () => {
        const pending = await boot({ answers: [{ ok: false, pending: true }] });
        expect((await pending.post()).json()).toMatchObject({ code: 'LEASE_PENDING' });
        expect(pending.asked).toEqual([]);
        const stranger = await boot();
        const res = await stranger.post({
            ...PAIR,
            'x-factory-job-lease-token': '33333333-3333-4333-8333-333333333333',
        });
        expect(res.statusCode).toBe(FORBIDDEN);
        expect(stranger.asked).toEqual([]);
    });

    it('refuses a task whose repository is not on GitLab, and a root on another repository', async () => {
        const other = await boot({ answers: [{ ...LIVE, ref: gitlabRepo(HOST, 'grp/other') }] });
        expect((await other.post()).statusCode).toBe(FORBIDDEN);
        expect(other.asked).toEqual([]);
    });

    it('answers unavailable, never a denial, when the grant or the lease read throws', async () => {
        const grant = await boot({
            grant: async () => {
                throw new Error('secret store down');
            },
        });
        const res = await grant.post();
        expect(res.statusCode).toBe(UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
        const lease = await boot();
        const failing = Fastify();
        apps.push(failing);
        await failing.register(
            forgeCredentialRoutes({
                attemptOfLease: async () => {
                    throw new Error('connection terminated');
                },
                memberGrants: {} as MemberForgeGrants,
                orgs: {} as never,
                publicUrl: '',
            })
        );
        const down = await failing.inject({
            method: 'POST',
            url: `/api/jobs/${JOB_ID}/credentials/gitlab`,
            headers: PAIR,
        });
        expect(down.statusCode).toBe(UNAVAILABLE);
        expect(lease.asked).toEqual([]);
    });
});
