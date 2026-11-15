import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
    githubAuth,
    memoryAuthStore,
    memoryUserExecutorStore,
    signedIn,
    staticRegistry,
    testConfig,
} from './helpers.js';
import type { MemoryUserExecutorStore } from './helpers-user-executor-store.js';
import { HTTP_BAD_REQUEST, HTTP_FORBIDDEN, HTTP_OK, HTTP_UNAVAILABLE, trackApps } from './helpers-http.js';

/**
 * Offline: the HTTP contract of `/api/agent-default` against the in-memory store double. The SQL and the
 * resolution order are covered by server/test-db/user-executor-store.test.ts.
 */
const track = trackApps();

const CLAUDE = { agentType: 'claude-code', model: 'claude-sonnet-4-5' };
const OPENCODE = { agentType: 'opencode', model: 'anthropic/claude-sonnet-4-5' };

/** `null` boots a board with no executor store. */
async function boot(executors: MemoryUserExecutorStore | null = memoryUserExecutorStore()) {
    const auth = memoryAuthStore();
    const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
    const member = auth.seedMember('test-org', 'octocat');
    const config = testConfig({ auth: githubAuth() });
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, userExecutors: executors ?? undefined }),
        auth,
    });
    track(app);
    return {
        app,
        executors,
        admin,
        member,
        adminCookie: await signedIn(auth, admin),
        memberCookie: await signedIn(auth, member),
    };
}

type Booted = Awaited<ReturnType<typeof boot>>;
const call = (booted: Booted, cookie: string) => (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    booted.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

describe('GET /api/agent-default', () => {
    it('answers the org row and the caller’s own, each null when unset', async () => {
        const booted = await boot();
        expect((await call(booted, booted.memberCookie)('GET', '/api/agent-default')).json()).toEqual({
            org: null,
            personal: null,
        });

        await booted.executors!.setAgentDefault(null, CLAUDE as never);
        await booted.executors!.setAgentDefault(booted.member.user.id, OPENCODE as never);
        const member = await call(booted, booted.memberCookie)('GET', '/api/agent-default');
        expect(member.statusCode).toBe(HTTP_OK);
        expect(member.json()).toEqual({ org: CLAUDE, personal: OPENCODE });
        // The member's row is theirs: the admin sees the org row and no personal one.
        expect((await call(booted, booted.adminCookie)('GET', '/api/agent-default')).json()).toEqual({
            org: CLAUDE,
            personal: null,
        });
    });

    it('is a 503, never "no default", when the read fails', async () => {
        const executors = memoryUserExecutorStore();
        executors.agentDefaults = async () => {
            throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        };
        const booted = await boot(executors);
        const response = await call(booted, booted.memberCookie)('GET', '/api/agent-default');
        expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
        expect(response.json()).not.toHaveProperty('org');
    });

    it('is a 503 on a board with no executor store', async () => {
        const booted = await boot(null);
        expect((await call(booted, booted.memberCookie)('GET', '/api/agent-default')).statusCode).toBe(
            HTTP_UNAVAILABLE
        );
    });
});

describe('PUT and DELETE /api/agent-default/org', () => {
    it('refuses a member with 403 and writes nothing', async () => {
        const booted = await boot();
        const put = await call(booted, booted.memberCookie)('PUT', '/api/agent-default/org', CLAUDE);
        expect(put.statusCode).toBe(HTTP_FORBIDDEN);
        const del = await call(booted, booted.memberCookie)('DELETE', '/api/agent-default/org');
        expect(del.statusCode).toBe(HTTP_FORBIDDEN);
        expect((await booted.executors!.agentDefaults(booted.member.user.id)).org).toBeNull();
    });

    it('lets an admin write, overwrite and remove the org row', async () => {
        const booted = await boot();
        const put = await call(booted, booted.adminCookie)('PUT', '/api/agent-default/org', CLAUDE);
        expect(put.statusCode).toBe(HTTP_OK);
        expect(put.json()).toEqual(CLAUDE);
        await call(booted, booted.adminCookie)('PUT', '/api/agent-default/org', OPENCODE);
        expect((await booted.executors!.agentDefaults(booted.member.user.id)).org).toEqual(OPENCODE);

        const del = await call(booted, booted.adminCookie)('DELETE', '/api/agent-default/org');
        expect(del.statusCode).toBe(HTTP_OK);
        expect(del.json()).toEqual({ removed: true });
        expect((await call(booted, booted.adminCookie)('DELETE', '/api/agent-default/org')).json()).toEqual({
            removed: false,
        });
        expect((await booted.executors!.agentDefaults(booted.member.user.id)).org).toBeNull();
    });
});

describe('PUT and DELETE /api/agent-default/personal', () => {
    it('lets a member write and remove their own row, never another member’s', async () => {
        const booted = await boot();
        const put = await call(booted, booted.memberCookie)('PUT', '/api/agent-default/personal', OPENCODE);
        expect(put.statusCode).toBe(HTTP_OK);
        expect(await booted.executors!.agentDefaults(booted.member.user.id)).toEqual({ org: null, personal: OPENCODE });
        expect((await booted.executors!.agentDefaults(booted.admin.user.id)).personal).toBeNull();

        const del = await call(booted, booted.memberCookie)('DELETE', '/api/agent-default/personal');
        expect(del.json()).toEqual({ removed: true });
        expect((await booted.executors!.agentDefaults(booted.member.user.id)).personal).toBeNull();
    });

    it.each<[string, object]>([
        ['an unknown agent', { agentType: 'codex', model: 'gpt-5' }],
        ['a missing agent', { model: 'claude-sonnet-4-5' }],
        ['an empty model', { agentType: 'claude-code', model: '' }],
        ['a blank model', { agentType: 'claude-code', model: '   ' }],
        ['a model over 200 characters', { agentType: 'claude-code', model: 'm'.repeat(201) }],
        ['a non-string model', { agentType: 'claude-code', model: 7 }],
        ['an unknown field', { ...CLAUDE, provider: 'anthropic' }],
    ])('refuses %s with 400 and writes nothing', async (_, payload) => {
        const booted = await boot();
        for (const url of ['/api/agent-default/personal', '/api/agent-default/org']) {
            const response = await call(booted, booted.adminCookie)('PUT', url, payload);
            expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        }
        expect(await booted.executors!.agentDefaults(booted.admin.user.id)).toEqual({ org: null, personal: null });
    });
});
