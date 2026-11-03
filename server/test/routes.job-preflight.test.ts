import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ConnectionStore, ConnectionView } from '../src/db/connection-store.js';
import type { Resolution, ResolveRefusal } from '../src/db/connection-bindings.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import {
    githubAuth,
    memoryAuthStore,
    memoryUserExecutorStore,
    signedIn,
    staticRegistry,
    testConfig,
} from './helpers.js';
import { HTTP_BAD_REQUEST, HTTP_OK, HTTP_UNAUTHORIZED, trackApps } from './helpers-http.js';

/**
 * Offline: `POST /api/jobs/preflight` answers the advisory checks the CLI used to make from four GETs.
 * Connections are judged by the store's `preview`, the create's own resolver; its SQL is covered in
 * server/test-db/connection-store.test.ts.
 */

const track = trackApps();
const CONN_A = '22222222-2222-4222-8222-222222222222';
const CONN_B = '33333333-3333-4333-8333-333333333333';

const view = (id: string, extra: Partial<ConnectionView> = {}): ConnectionView => ({
    id,
    provider: 'jira',
    credential: 'oauth_grant',
    ownership: 'personal',
    principal: 'self',
    site: 'acme.example',
    account: 'me@example.com',
    access: 'write',
    status: 'active',
    needsReconnect: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
});

const binding = (connectionId: string, source: 'explicit' | 'default'): Resolution['bindings'][number] => ({
    connectionId,
    provider: 'jira',
    credential: 'oauth_grant',
    externalAccountId: null,
    resource: 'cloud',
    grantId: null,
    authority: {},
    access: 'write',
    source,
});

interface Scenario {
    listed?: ConnectionView[] | Error;
    /** The connections this caller may bind. */
    allowed?: string[];
    /** What the resolver answers once every explicit id is bindable. */
    resolution?: Resolution | Error;
    repos?: { owner: string; name: string }[];
    repoError?: string | Error;
}

async function boot(scenario: Scenario = {}) {
    const auth = memoryAuthStore();
    const member = auth.seedMember('test-org', 'octocat');
    const other = auth.seedMember('test-org', 'hubot');
    const executors = memoryUserExecutorStore();
    await executors.replace(member.user.id, [{ name: 'main', type: 'claude-code', config: {} }]);
    const asked: { userId: string; explicit: string[] }[] = [];
    const allowed = new Set(scenario.allowed ?? []);
    const connections = {
        async list() {
            if (scenario.listed instanceof Error) throw scenario.listed;
            return scenario.listed ?? [];
        },
        async preview(input: { executionUser: string; explicit: string[] }): Promise<Resolution | ResolveRefusal> {
            asked.push({ userId: input.executionUser, explicit: input.explicit });
            if (input.explicit.some((id) => !allowed.has(id))) return { ok: false, reason: 'not-authorized' };
            const resolution = scenario.resolution ?? { ok: true, bindings: [], requirements: [] };
            if (resolution instanceof Error) throw resolution;
            return resolution;
        },
    } as unknown as ConnectionStore;
    const base = staticRepoSource(scenario.repos ?? [{ owner: 'acme', name: 'web' }]);
    const repos =
        scenario.repoError === undefined
            ? base
            : {
                  ...base,
                  detail: async () => {
                      if (scenario.repoError instanceof Error) throw scenario.repoError;
                      return { repos: [], installation: null, error: scenario.repoError ?? null };
                  },
              };
    const config = testConfig({ auth: githubAuth() });
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, repos, connections, userExecutors: executors }),
        auth,
    });
    track(app);
    return {
        app,
        executors,
        asked,
        member,
        cookie: await signedIn(auth, member),
        otherCookie: await signedIn(auth, other),
    };
}

type Booted = Awaited<ReturnType<typeof boot>>;
const preflight = (booted: Booted, payload: unknown, cookie = booted.cookie) =>
    booted.app.inject({ method: 'POST', url: '/api/jobs/preflight', headers: { cookie }, payload: payload as object });
const verdict = async (booted: Booted, payload: unknown, subject: string, name?: string) => {
    const response = await preflight(booted, payload);
    expect(response.statusCode).toBe(HTTP_OK);
    const body = response.json() as {
        ready: boolean;
        checks: { subject: string; name: string | null; status: string; detail: string }[];
    };
    return { body, check: body.checks.find((c) => c.subject === subject && (name === undefined || c.name === name)) };
};

describe('POST /api/jobs/preflight repo', () => {
    it('is ok for a tracked repo', async () => {
        const { check } = await verdict(await boot(), { repo: 'acme/web', executor: 'main' }, 'repo');
        expect(check).toMatchObject({ name: 'acme/web', status: 'ok' });
    });

    it('is blocked for a repo the board does not track', async () => {
        const { check, body } = await verdict(await boot(), { repo: 'acme/other', executor: 'main' }, 'repo');
        expect(check).toMatchObject({ status: 'blocked' });
        expect(body.ready).toBe(false);
    });

    it('is blocked when no repo is named', async () => {
        const { check } = await verdict(await boot(), { executor: 'main' }, 'repo');
        expect(check).toMatchObject({ name: null, status: 'blocked' });
    });

    it('is unverified when the tracked list carries an error', async () => {
        const { check, body } = await verdict(
            await boot({ repos: [], repoError: 'rate limited' }),
            { repo: 'acme/web', executor: 'main' },
            'repo'
        );
        expect(check).toMatchObject({ status: 'unverified' });
        expect(check?.detail).toContain('rate limited');
        expect(body.ready).toBe(true);
    });

    it('is unverified when the tracked list cannot be read', async () => {
        const { check } = await verdict(
            await boot({ repoError: new Error('boom') }),
            { repo: 'acme/web', executor: 'main' },
            'repo'
        );
        expect(check).toMatchObject({ status: 'unverified' });
    });
});

describe('POST /api/jobs/preflight executor', () => {
    it("is ok for the caller's own profile", async () => {
        const { check } = await verdict(await boot(), { repo: 'acme/web', executor: 'main' }, 'executor');
        expect(check).toMatchObject({ name: 'main', status: 'ok' });
    });

    it('is blocked when the profile is missing', async () => {
        const { check } = await verdict(await boot(), { repo: 'acme/web', executor: 'nope' }, 'executor');
        expect(check).toMatchObject({ name: 'nope', status: 'blocked' });
    });

    it('is blocked when nothing is selected, naming the default', async () => {
        const { check } = await verdict(await boot(), { repo: 'acme/web' }, 'executor');
        expect(check).toMatchObject({ name: null, status: 'blocked' });
        expect(check?.detail).toContain('your default is user main');
    });

    it('is blocked when the profile is suspended', async () => {
        const booted = await boot();
        const [row] = booted.executors.rows();
        await booted.executors.setPersonalSuspended(booted.member.user.id, row!.id, true);
        const { check } = await verdict(booted, { repo: 'acme/web', executor: 'main' }, 'executor');
        expect(check).toMatchObject({ status: 'blocked' });
        expect(check?.detail).toContain('suspended');
    });

    it('is blocked for an org executor the org does not hold, even when the caller has that name', async () => {
        const { check } = await verdict(
            await boot(),
            { repo: 'acme/web', executor: 'main', executorScope: 'org' },
            'executor'
        );
        expect(check).toMatchObject({ status: 'blocked' });
        expect(check?.detail).toContain('org');
    });

    it('is ok for an org executor the org holds', async () => {
        const booted = await boot();
        await booted.executors.createOrg({
            name: 'shared',
            type: 'claude-code',
            config: {},
            createdBy: booted.member.user.id,
        });
        const { check } = await verdict(
            booted,
            { repo: 'acme/web', executor: 'shared', executorScope: 'org' },
            'executor'
        );
        expect(check).toMatchObject({ status: 'ok' });
    });

    it("does not show one member another member's profile", async () => {
        const booted = await boot();
        const response = await preflight(booted, { repo: 'acme/web', executor: 'main' }, booted.otherCookie);
        const check = response.json().checks.find((c: { subject: string }) => c.subject === 'executor');
        expect(check).toMatchObject({ status: 'blocked' });
    });
});

describe('POST /api/jobs/preflight skills', () => {
    const base = { repo: 'acme/web', executor: 'main' };

    it('is blocked for a skill the board does not have', async () => {
        const { check } = await verdict(await boot(), { ...base, skills: ['no-such-skill'] }, 'skill');
        expect(check).toMatchObject({ name: 'no-such-skill', status: 'blocked' });
    });

    it('is ok for an installed skill that needs no connection', async () => {
        const { check } = await verdict(await boot(), { ...base, skills: ['review'] }, 'skill');
        expect(check?.status).toBe('ok');
    });

    it('is unverified for a requirement the task never selects', async () => {
        const { check } = await verdict(await boot(), { ...base, skills: ['github'] }, 'skill', 'github');
        expect(check).toMatchObject({ status: 'unverified' });
    });

    it('selects the one personal connection as the default', async () => {
        const resolution: Resolution = { ok: true, bindings: [binding(CONN_A, 'default')], requirements: [] };
        const booted = await boot({ resolution, listed: [view(CONN_A)] });
        const { check } = await verdict(booted, { ...base, skills: ['jira'] }, 'skill', 'jira');
        expect(check).toMatchObject({ status: 'ok' });
        expect(check?.detail).toContain('jira');
        expect(booted.asked.at(-1)?.userId).toBe(booted.member.user.id);
    });

    it('is blocked as ambiguous when several personal connections could serve', async () => {
        const resolution: Resolution = {
            ok: true,
            bindings: [],
            requirements: [{ provider: 'jira', reason: 'ambiguous' }],
        };
        const { check } = await verdict(
            await boot({ resolution, listed: [view(CONN_A), view(CONN_B)] }),
            { ...base, skills: ['jira'] },
            'skill',
            'jira'
        );
        expect(check).toMatchObject({ status: 'blocked' });
        expect(check?.detail).toMatch(/several/);
    });

    it('is blocked as missing when the caller has no connection, distinct from ambiguous', async () => {
        const resolution: Resolution = {
            ok: true,
            bindings: [],
            requirements: [{ provider: 'jira', reason: 'missing' }],
        };
        const { check } = await verdict(await boot({ resolution }), { ...base, skills: ['jira'] }, 'skill', 'jira');
        expect(check).toMatchObject({ status: 'blocked' });
        expect(check?.detail).toMatch(/no jira connection/);
    });

    it('reports a connection whose grant lapsed as needing reconnect, not as absent', async () => {
        const resolution: Resolution = {
            ok: true,
            bindings: [],
            requirements: [{ provider: 'jira', reason: 'missing' }],
        };
        const { check } = await verdict(
            await boot({ resolution, listed: [view(CONN_A, { needsReconnect: true })] }),
            { ...base, skills: ['jira'] },
            'skill',
            'jira'
        );
        expect(check).toMatchObject({ status: 'blocked' });
        expect(check?.detail).toMatch(/reconnect/);
    });

    it('is ok when an explicit connection serves the skill, with no "a selection is present" shortcut', async () => {
        const resolution: Resolution = { ok: true, bindings: [binding(CONN_A, 'explicit')], requirements: [] };
        const { check } = await verdict(
            await boot({ resolution, allowed: [CONN_A], listed: [view(CONN_A)] }),
            { ...base, skills: ['jira'], connections: [CONN_A] },
            'skill',
            'jira'
        );
        expect(check).toMatchObject({ status: 'ok' });
    });

    it('stays blocked when the explicit connection does not serve the skill and none is the default', async () => {
        const resolution: Resolution = {
            ok: true,
            bindings: [],
            requirements: [{ provider: 'jira', reason: 'missing' }],
        };
        const { check } = await verdict(
            await boot({ resolution, allowed: [CONN_A], listed: [view(CONN_A, { provider: 'other' })] }),
            { ...base, skills: ['jira'], connections: [CONN_A] },
            'skill',
            'jira'
        );
        expect(check).toMatchObject({ status: 'blocked' });
    });

    it('is unverified, never blocked, when the resolver cannot be read', async () => {
        const { check, body } = await verdict(
            await boot({ resolution: new Error('db down') }),
            { ...base, skills: ['jira'] },
            'skill',
            'jira'
        );
        expect(check).toMatchObject({ status: 'unverified' });
        expect(body.ready).toBe(true);
    });
});

describe('POST /api/jobs/preflight connections', () => {
    const base = { repo: 'acme/web', executor: 'main' };

    it('is ok for a connection the caller may bind', async () => {
        const { check } = await verdict(
            await boot({ allowed: [CONN_A], listed: [view(CONN_A)] }),
            { ...base, connections: [CONN_A] },
            'connection'
        );
        expect(check).toMatchObject({ name: CONN_A, status: 'ok' });
        expect(check?.detail).toContain('acme.example');
    });

    it('is blocked for a connection that is not available to the caller, saying no more', async () => {
        const booted = await boot({ allowed: [], listed: [] });
        const { check, body } = await verdict(booted, { ...base, connections: [CONN_A] }, 'connection');
        expect(check).toMatchObject({ name: CONN_A, status: 'blocked', detail: 'no such connection available to you' });
        expect(body.ready).toBe(false);
    });

    it("is blocked as needing reconnect when the caller's own grant lapsed", async () => {
        const { check } = await verdict(
            await boot({ allowed: [], listed: [view(CONN_A, { needsReconnect: true })] }),
            { ...base, connections: [CONN_A] },
            'connection'
        );
        expect(check).toMatchObject({ status: 'blocked' });
        expect(check?.detail).toMatch(/reconnect/);
    });

    it('is unverified when the resolver cannot be read, never blocked', async () => {
        const { check } = await verdict(
            await boot({ allowed: [CONN_A], resolution: new Error('db down') }),
            { ...base, connections: [CONN_A] },
            'connection'
        );
        expect(check).toMatchObject({ status: 'unverified' });
    });

    it('is ready when the only non-ok checks are unverified', async () => {
        const { body } = await verdict(await boot(), { ...base, skills: ['github'] }, 'skill');
        expect(body.checks.some((c) => c.status === 'unverified')).toBe(true);
        expect(body.ready).toBe(true);
    });

    it('stays ok when only the display list cannot be read', async () => {
        const { check } = await verdict(
            await boot({ allowed: [CONN_A], listed: new Error('db down') }),
            { ...base, connections: [CONN_A] },
            'connection'
        );
        expect(check).toMatchObject({ status: 'ok' });
    });
});

describe('POST /api/jobs/preflight body', () => {
    it('refuses an unknown field', async () => {
        const response = await preflight(await boot(), { repo: 'acme/web', command: 'do it' });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
    });

    it('refuses a repeated connection id', async () => {
        const response = await preflight(await boot(), { connections: [CONN_A, CONN_A] });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
    });

    it('needs a signed-in caller', async () => {
        const booted = await boot();
        const response = await booted.app.inject({ method: 'POST', url: '/api/jobs/preflight', payload: {} });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});
