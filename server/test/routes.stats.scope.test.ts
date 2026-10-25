import { describe, expect, it } from 'vitest';
import type { UserRef } from '@factory-ai/core';
import {
    TEST_REPO,
    githubAuth,
    harness,
    memoryAuthStore,
    signedIn,
    stubTelemetryClient,
    usageFactsOf,
} from './helpers.js';
import { HTTP_BAD_REQUEST, trackApps } from './helpers-http.js';

const track = trackApps();

describe('GET /api/stats scope: rejections', () => {
    const scopedHarness = async (telemetry = stubTelemetryClient()) => {
        const store = memoryAuthStore();
        const h = await harness({ telemetry, auth: store, config: { auth: githubAuth() } });
        return { ...h, store };
    };

    it('names the org scope the figures were computed under', async () => {
        const h = await harness();
        const app = track(h.app);
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
        expect(body.meta.scope).toBe('org');
        expect(body.meta.scopeLogin).toBeNull();
    });

    it('rejects caller scope when nothing is signed in (open auth mode)', async () => {
        const h = await harness();
        const app = track(h.app);
        const res = await app.inject({ method: 'GET', url: '/api/stats?scope=mine' });
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json().code).toBe('SCOPE_REQUIRES_USER');
    });

    it('rejects caller scope for an organization token, which names no person', async () => {
        const h = await scopedHarness();
        const app = track(h.app);
        const token = h.store.seedAccessToken('test-org', 'org', { label: 'board reader' });
        const res = await app!.inject({
            method: 'GET',
            url: '/api/stats?scope=mine',
            headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json().code).toBe('SCOPE_REQUIRES_USER');
    });

    it('rejects a scope it does not know', async () => {
        const h = await harness();
        const app = track(h.app);
        const res = await app.inject({ method: 'GET', url: '/api/stats?scope=team' });
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json().code).toBe('BAD_SCOPE');
    });
});

describe('GET /api/stats scope: computed figures', () => {
    const ATTRIBUTED_TOKENS_INPUT = 1000;
    const ATTRIBUTED_TOKENS_OUTPUT = 500;
    const CAROL_AGENT_TURNS = 7;
    const DAVE_AGENT_TURNS = 3;

    it('computes every figure over only the caller attributed sessions, naming the member', async () => {
        // The telemetry is built around the caller: two sessions attributed to them, one to
        // another member, one unattributed — so a leak in any direction shows in the counts.
        const carol: UserRef = { id: 'u-carol', login: 'carol', name: 'Carol', avatarUrl: null };
        const dave = { id: 'u-dave', login: 'dave', name: null, avatarUrl: null };
        const at = '2026-08-20T00:00:00.000Z';
        const spec = (sessionId: string, taskId: string | null, authorId: string | null) => ({
            sessionId,
            taskId,
            authorId,
            input: ATTRIBUTED_TOKENS_INPUT,
            output: ATTRIBUTED_TOKENS_OUTPUT,
            at,
        });
        const runOf = (rootJobId: string, repo: string, createdBy: string, agentTurns: number) => ({
            rootJobId,
            repo,
            createdBy,
            createdAt: '2026-08-20T00:00:00.000Z',
            agentTurns,
            wallClockMs: 60_000,
        });
        // The caller's account id IS what the landed join resolves, so the fixture is built
        // around it once the member exists: one member's id, another's, and null.
        const store = memoryAuthStore();
        const caller = store.seedMember('test-org', 'carol');
        const mineUser = { ...carol, id: caller.user.id };
        const telemetry = stubTelemetryClient({
            facts: () => {
                return usageFactsOf(
                    [
                        spec('mine-1', 't-carol', mineUser.id),
                        spec('mine-2', 't-carol', mineUser.id),
                        spec('daves', 't-dave', dave.id),
                        // A task whose author the board never recorded: in the org, outside mine.
                        spec('unknown-author', 't-nobody', null),
                        // Hook only: no board task at all, so no author either.
                        spec('anon', null, null),
                        // Another organization's session id: nothing of it crosses.
                        spec('foreign', 't-foreign', dave.id),
                    ],
                    [mineUser, dave],
                    ['foreign']
                );
            },
            runs: () => [
                runOf('t-carol', TEST_REPO, caller.user.id, CAROL_AGENT_TURNS),
                runOf('t-dave', TEST_REPO, dave.id, DAVE_AGENT_TURNS),
            ],
        });
        const h = await harness({ telemetry, auth: store, config: { auth: githubAuth() } });
        const app = track(h.app);
        const cookie = await signedIn(store, caller);
        await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });
        await h.settle();

        const EXPECTED_MINE_SESSIONS = 2;
        // Both the unknown-author task's session and the hook-only one: outside mine, still named.
        const EXPECTED_UNATTRIBUTED = 2;
        const EXPECTED_MINE_INPUT_P50 = 2000;
        const EXPECTED_MINE_OUTPUT_P50 = 1000;
        const mine = (await app.inject({ method: 'GET', url: '/api/stats?scope=mine', headers: { cookie } })).json();
        expect(mine.meta.scope).toBe('mine');
        expect(mine.meta.scopeLogin).toBe('carol');
        expect(mine.telemetry.totals.sessions).toBe(EXPECTED_MINE_SESSIONS);
        expect(mine.telemetry.byUser.map((row: { user: { login: string } }) => row.user.login)).toEqual(['carol']);
        // Unattributed sessions stay out of the totals but keep their own figure.
        expect(mine.telemetry.unattributedSessions).toBe(EXPECTED_UNATTRIBUTED);
        // Tokens follow the trusted author on the board, not the session count: only carol's two sessions.
        expect(mine.telemetry.usage.totals.tokens).toMatchObject({ input: 2 * ATTRIBUTED_TOKENS_INPUT, output: 1000 });
        expect(mine.telemetry.usage.byUser.map((row: { userId: string }) => row.userId)).toEqual([caller.user.id]);
        // Coverage still describes the store, not the scope.
        expect(mine.telemetry.coverage.from).toBe('2026-08-20T00:00:00.000Z');
        // The task set narrows with the scope: only the caller's task survives.
        expect(mine.tasks.tokens.all.input).toMatchObject({ p50: EXPECTED_MINE_INPUT_P50, tasks: 1 });
        expect(mine.tasks.tokens.all.output).toMatchObject({ p50: EXPECTED_MINE_OUTPUT_P50, tasks: 1 });
        expect(mine.tasks.jobTurnsPerTask.tasks).toBe(1);
        expect(mine.tasks.agentTurnsPerTask).toMatchObject({ p50: CAROL_AGENT_TURNS, tasks: 1 });

        // And the same snapshot answers the whole organization from the SAME fetch — all four
        // sessions, the unattributed one included.
        const EXPECTED_ORG_SESSIONS = 5;
        const org = (await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } })).json();
        expect(org.telemetry.totals.sessions).toBe(EXPECTED_ORG_SESSIONS);
        // The foreign session is in no figure of this organization, not even a diagnostic.
        expect(org.telemetry.usage.totals.tokens.input).toBe(EXPECTED_ORG_SESSIONS * ATTRIBUTED_TOKENS_INPUT);
        expect(org.telemetry.usage.diagnostics.unresolvedOwnership.sessions).toBe(0);
        expect(JSON.stringify(org)).not.toContain('t-foreign');
        // t-carol, t-dave and the unknown-author task have usage; a task without a run banks a measured zero.
        expect(org.tasks.tokens.all.input).toMatchObject({ tasks: 3 });
        expect(org.tasks.agentTurnsPerTask).toMatchObject({ tasks: 3 });
    });

    it('serves org and mine from the one fetch the cache paid for', async () => {
        const store = memoryAuthStore();
        const caller = store.seedMember('test-org', 'carol');
        const telemetry = stubTelemetryClient();
        const h = await harness({ telemetry, auth: store, config: { auth: githubAuth() } });
        const app = track(h.app);
        const headers = { cookie: await signedIn(store, caller) };
        await app.inject({ method: 'GET', url: '/api/stats', headers });
        await h.settle();
        expect(telemetry.rollupCalls).toBe(1);

        await app.inject({ method: 'GET', url: '/api/stats?scope=mine', headers });
        await app.inject({ method: 'GET', url: '/api/stats?scope=org', headers });
        await h.settle();
        // A scope switch is a re-aggregation, never a second read.
        expect(telemetry.rollupCalls).toBe(1);
    });
});
