import { executorMissingMessage, noExecutorMessage } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { JobActionStore } from '../src/db/jobs/job-store-action-types.js';
import {
    githubAuth,
    memoryAuthStore,
    memoryUserExecutorStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
    jobStoreSlice,
} from './helpers.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_CONFLICT,
    HTTP_CREATED,
    HTTP_FORBIDDEN,
    HTTP_NOT_FOUND,
    HTTP_OK,
    trackApps,
} from './helpers-http.js';

/**
 * Offline: the HTTP contract of the executor lifecycle (issue 440) — removing and suspending a
 * personal profile by id, suspending an org profile, the default/fallback that skips a suspended
 * row, and the refusal of a task that targets one. The SQL under it is covered by
 * server/test-db/user-executor-store.test.ts and job-store.executor-scope.test.ts.
 */

const track = trackApps();

const READY_REPO = { owner: 'acme', name: 'web' };

const entry = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    type: 'claude-code',
    config: { model: 'sonnet' },
    ...extra,
});

type RepoSkills = NonNullable<Parameters<typeof staticRegistry>[0]>['repoSkills'];

async function boot(repoSkills?: RepoSkills, overrides: Parameters<typeof testConfig>[0] = {}) {
    const auth = memoryAuthStore();
    const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
    const member = auth.seedMember('test-org', 'octocat');
    const other = auth.seedMember('test-org', 'hubot');
    const executors = memoryUserExecutorStore();
    // A task needs a tracked repository: the board tracks one, so these tests keep exercising the
    // executor refusal rather than the repository's.
    const repos = staticRepoSource([READY_REPO]);
    const queued: {
        command: string;
        executor: string | null;
        scope: string | undefined;
        agentType?: string | null | undefined;
        agentModel?: string | null | undefined;
    }[] = [];
    const jobs = jobStoreSlice<JobActionStore>({
        async create(command: string, _by: string | null, target: Parameters<JobActionStore['create']>[2]) {
            const { agentType, agentModel } = target;
            queued.push({
                command,
                executor: target.executor ?? null,
                scope: target.executorScope,
                // Recorded only when create stamps an agent default, so the profile cases keep their exact shape.
                ...(agentType || agentModel ? { agentType, agentModel } : {}),
            });
            return { id: '11111111-1111-4111-8111-111111111111' };
        },
    });
    const config = testConfig({ auth: githubAuth(), ...overrides });
    const instance = await buildApp({
        config,
        orgs: staticRegistry({
            config,
            jobs,
            repos,
            userExecutors: executors,
            repoSkills,
            telemetry: stubTelemetryClient(),
        }),
        auth,
    });
    track(instance);
    return {
        instance,
        executors,
        repos,
        memberId: member.user.id,
        queued,
        adminCookie: await signedIn(auth, admin),
        memberCookie: await signedIn(auth, member),
        otherCookie: await signedIn(auth, other),
    };
}

type Booted = Awaited<ReturnType<typeof boot>>;

const putPersonal = (b: Booted, cookie: string, executors: unknown[]) =>
    b.instance.inject({ method: 'PUT', url: '/api/workspace/executors', headers: { cookie }, payload: { executors } });

const createOrg = async (b: Booted, name: string) =>
    (
        await b.instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: b.adminCookie },
            payload: entry(name),
        })
    ).json().id as string;

const poll = async (b: Booted, cookie: string) =>
    (await b.instance.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();

const personalId = (b: Booted, name: string, cookie: string) =>
    poll(b, cookie).then((p) => p.executors.find((row: { name: string }) => row.name === name).id as string);

const suspend = (b: Booted, url: string, cookie: string, suspended: boolean) =>
    b.instance.inject({ method: 'POST', url, headers: { cookie }, payload: { suspended } });

const queue = (b: Booted, cookie: string, executor: string, executorScope: 'user' | 'org') =>
    b.instance.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { cookie },
        payload: { command: 'echo hi', executor, executorScope, repo: `${READY_REPO.owner}/${READY_REPO.name}` },
    });

describe('personal profiles: remove by id', () => {
    it('removes only the named row and leaves the rest of the list', async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('keep'), entry('drop')]);
        const id = await personalId(b, 'drop', b.memberCookie);

        const response = await b.instance.inject({
            method: 'DELETE',
            url: `/api/workspace/executors/${id}`,
            headers: { cookie: b.memberCookie },
        });
        expect(response.statusCode).toBe(HTTP_OK);
        expect((await poll(b, b.memberCookie)).executors.map((r: { name: string }) => r.name)).toEqual(['keep']);
    });

    it("never removes another member's row or an organization row, and says 404 without touching data", async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        const orgId = await createOrg(b, 'shared');
        const mineId = await personalId(b, 'mine', b.memberCookie);

        for (const [cookie, id] of [
            [b.otherCookie, mineId],
            [b.memberCookie, orgId],
        ] as const) {
            const response = await b.instance.inject({
                method: 'DELETE',
                url: `/api/workspace/executors/${id}`,
                headers: { cookie },
            });
            expect(response.statusCode).toBe(HTTP_NOT_FOUND);
        }
        expect(b.executors.rows().map((r) => r.name)).toEqual(expect.arrayContaining(['mine', 'shared']));
        expect(b.executors.rows()).toHaveLength(2);
    });
});

describe('personal profiles: suspend and resume', () => {
    it('persists the suspension, keeps config and shows it in the poll', async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        const id = await personalId(b, 'mine', b.memberCookie);

        const response = await suspend(b, `/api/workspace/executors/${id}/suspension`, b.memberCookie, true);
        expect(response.statusCode).toBe(HTTP_OK);
        expect((await poll(b, b.memberCookie)).executors[0]).toMatchObject({ name: 'mine', suspended: true });
        expect(b.executors.rows()[0]).toMatchObject({ config: { model: 'sonnet' }, suspended: true });

        await suspend(b, `/api/workspace/executors/${id}/suspension`, b.memberCookie, false);
        expect((await poll(b, b.memberCookie)).executors[0].suspended).toBe(false);
    });

    it("refuses another member's row and an org row with 404, and a non-boolean body with 400", async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        const orgId = await createOrg(b, 'shared');
        const mineId = await personalId(b, 'mine', b.memberCookie);

        expect(
            (await suspend(b, `/api/workspace/executors/${mineId}/suspension`, b.otherCookie, true)).statusCode
        ).toBe(HTTP_NOT_FOUND);
        expect(
            (await suspend(b, `/api/workspace/executors/${orgId}/suspension`, b.memberCookie, true)).statusCode
        ).toBe(HTTP_NOT_FOUND);
        const bad = await b.instance.inject({
            method: 'POST',
            url: `/api/workspace/executors/${mineId}/suspension`,
            headers: { cookie: b.memberCookie },
            payload: { suspended: 'yes' },
        });
        expect(bad.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(b.executors.rows().every((r) => !r.suspended)).toBe(true);
    });

    it('survives a whole-list save of the same names, and a rename that carries the flag', async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('a'), entry('b')]);
        await suspend(
            b,
            `/api/workspace/executors/${await personalId(b, 'a', b.memberCookie)}/suspension`,
            b.memberCookie,
            true
        );

        await putPersonal(b, b.memberCookie, [entry('a', { gateFixRounds: 1 }), entry('b')]);
        expect(b.executors.rows().map((r) => [r.name, r.suspended])).toEqual([
            ['a', true],
            ['b', false],
        ]);

        await putPersonal(b, b.memberCookie, [entry('a2', { suspended: true }), entry('b')]);
        expect(b.executors.rows().map((r) => [r.name, r.suspended])).toEqual([
            ['a2', true],
            ['b', false],
        ]);
    });
});

describe('organization profiles: suspend and resume', () => {
    it('is admin-only: a member gets 403 and the row is unchanged', async () => {
        const b = await boot();
        const id = await createOrg(b, 'shared');

        const response = await suspend(b, `/api/org/executors/${id}/suspension`, b.memberCookie, true);
        expect(response.statusCode).toBe(HTTP_FORBIDDEN);
        expect(b.executors.rows()[0]!.suspended).toBe(false);
    });

    it('an admin suspends it for every member without exposing the config, and resumes it', async () => {
        const b = await boot();
        const id = await createOrg(b, 'shared');

        const response = await suspend(b, `/api/org/executors/${id}/suspension`, b.adminCookie, true);
        expect(response.statusCode).toBe(HTTP_OK);
        const seen = await poll(b, b.memberCookie);
        expect(seen.orgExecutors).toEqual([expect.objectContaining({ name: 'shared', suspended: true })]);
        expect(JSON.stringify(seen)).not.toContain('sonnet');
        const list = (
            await b.instance.inject({ method: 'GET', url: '/api/org/executors', headers: { cookie: b.memberCookie } })
        ).json();
        expect(list.executors[0]).toMatchObject({ suspended: true });
        expect(list.executors[0].config).toBeUndefined();

        await suspend(b, `/api/org/executors/${id}/suspension`, b.adminCookie, false);
        expect((await poll(b, b.memberCookie)).orgExecutors[0].suspended).toBe(false);
    });

    it('answers 404 for an unknown id and for a personal row reached through the org door', async () => {
        const b = await boot();
        await putPersonal(b, b.adminCookie, [entry('mine')]);
        const mineId = await personalId(b, 'mine', b.adminCookie);

        expect((await suspend(b, `/api/org/executors/${mineId}/suspension`, b.adminCookie, true)).statusCode).toBe(
            HTTP_NOT_FOUND
        );
        expect(b.executors.rows()[0]!.suspended).toBe(false);
    });
});

describe('defaults and the fallback chain', () => {
    it('refuses a suspended profile as the default with EXECUTOR_SUSPENDED and stores nothing', async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        await suspend(
            b,
            `/api/workspace/executors/${await personalId(b, 'mine', b.memberCookie)}/suspension`,
            b.memberCookie,
            true
        );

        const response = await b.instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors/default',
            headers: { cookie: b.memberCookie },
            payload: { executor: 'mine', executorScope: 'user' },
        });
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('EXECUTOR_SUSPENDED');
        expect(b.executors.defaults()).toEqual([]);
    });

    it('falls back past suspended rows, personal before org, and restores the stored preference on resume', async () => {
        const b = await boot();
        const orgId = await createOrg(b, 'shared');
        await putPersonal(b, b.memberCookie, [entry('first'), entry('second')]);
        await b.instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors/default',
            headers: { cookie: b.memberCookie },
            payload: { executor: 'second', executorScope: 'user' },
        });
        const secondId = await personalId(b, 'second', b.memberCookie);
        const firstId = await personalId(b, 'first', b.memberCookie);

        await suspend(b, `/api/workspace/executors/${secondId}/suspension`, b.memberCookie, true);
        expect((await poll(b, b.memberCookie)).defaultExecutor).toEqual({ scope: 'user', name: 'first' });

        await suspend(b, `/api/workspace/executors/${firstId}/suspension`, b.memberCookie, true);
        expect((await poll(b, b.memberCookie)).defaultExecutor).toEqual({ scope: 'org', name: 'shared' });

        await suspend(b, `/api/org/executors/${orgId}/suspension`, b.adminCookie, true);
        expect((await poll(b, b.memberCookie)).defaultExecutor).toBeNull();

        // The stored preference was never rewritten, so resuming restores it.
        await suspend(b, `/api/workspace/executors/${secondId}/suspension`, b.memberCookie, false);
        expect((await poll(b, b.memberCookie)).defaultExecutor).toEqual({ scope: 'user', name: 'second' });
    });
});

describe('POST /api/jobs against a suspended profile', () => {
    it('refuses with 409 EXECUTOR_SUSPENDED naming the profile, and queues nothing', async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        await suspend(
            b,
            `/api/workspace/executors/${await personalId(b, 'mine', b.memberCookie)}/suspension`,
            b.memberCookie,
            true
        );

        const response = await queue(b, b.memberCookie, 'mine', 'user');
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('EXECUTOR_SUSPENDED');
        expect(response.json().error).toContain('"mine"');
        expect(b.queued).toEqual([]);
    });

    it('keeps scope identity: a suspended personal profile does not block the same-named org one', async () => {
        const b = await boot();
        await createOrg(b, 'same');
        await putPersonal(b, b.memberCookie, [entry('same')]);
        await suspend(
            b,
            `/api/workspace/executors/${await personalId(b, 'same', b.memberCookie)}/suspension`,
            b.memberCookie,
            true
        );

        expect((await queue(b, b.memberCookie, 'same', 'user')).statusCode).toBe(HTTP_CONFLICT);
        expect((await queue(b, b.memberCookie, 'same', 'org')).statusCode).toBe(HTTP_CREATED);
        expect(b.queued).toEqual([expect.objectContaining({ executor: 'same', scope: 'org' })]);
    });

    it('accepts a profile again once it is resumed', async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        const url = `/api/workspace/executors/${await personalId(b, 'mine', b.memberCookie)}/suspension`;
        await suspend(b, url, b.memberCookie, true);
        await suspend(b, url, b.memberCookie, false);

        expect((await queue(b, b.memberCookie, 'mine', 'user')).statusCode).toBe(HTTP_CREATED);
    });
});

describe('POST /api/jobs naming no executor', () => {
    const queueBare = (b: Booted, cookie: string, extra: Record<string, unknown> = {}) =>
        b.instance.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: { cookie },
            payload: { command: 'echo hi', repo: `${READY_REPO.owner}/${READY_REPO.name}`, ...extra },
        });

    it("stamps the caller's resolved default, so the claim has a profile to run", async () => {
        const b = await boot();
        await createOrg(b, 'Main');
        const response = await queueBare(b, b.memberCookie);
        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(b.queued).toEqual([{ command: 'echo hi', executor: 'Main', scope: 'org' }]);
    });

    it('prefers a personal profile over the org one, as the fallback chain does', async () => {
        const b = await boot();
        await createOrg(b, 'Main');
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        expect((await queueBare(b, b.memberCookie)).statusCode).toBe(HTTP_CREATED);
        expect(b.queued).toEqual([{ command: 'echo hi', executor: 'mine', scope: 'user' }]);
    });

    const putAgentDefault = (b: Booted, cookie: string, owner: 'personal' | 'org', model: string) =>
        b.instance.inject({
            method: 'PUT',
            url: `/api/agent-default/${owner}`,
            headers: { cookie },
            payload: { agentType: 'opencode', model },
        });

    it("freezes the caller's agent default on the task when no profile exists: no executor, the agent and its model", async () => {
        const b = await boot();
        expect((await putAgentDefault(b, b.memberCookie, 'personal', 'mine-model')).statusCode).toBe(200);

        const response = await queueBare(b, b.memberCookie);

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(b.queued).toEqual([
            { command: 'echo hi', executor: null, scope: 'user', agentType: 'opencode', agentModel: 'mine-model' },
        ]);
    });

    it("a chosen model wins over the agent default's model and keeps its agent", async () => {
        const b = await boot();
        expect((await putAgentDefault(b, b.memberCookie, 'personal', 'mine-model')).statusCode).toBe(200);

        expect((await queueBare(b, b.memberCookie, { model: 'picked' })).statusCode).toBe(HTTP_CREATED);
        expect(b.queued).toEqual([
            { command: 'echo hi', executor: null, scope: 'user', agentType: 'opencode', agentModel: 'picked' },
        ]);
    });

    it('a chosen model rides a profile task alone: the profile stays, no agent is frozen', async () => {
        const b = await boot();
        await createOrg(b, 'Main');

        expect((await queueBare(b, b.memberCookie, { model: 'picked' })).statusCode).toBe(HTTP_CREATED);
        expect(b.queued).toStrictEqual([
            { command: 'echo hi', executor: 'Main', scope: 'org', agentType: undefined, agentModel: 'picked' },
        ]);
    });

    it("the organization's agent default outranks a profile, as the resolution order says", async () => {
        const b = await boot();
        await createOrg(b, 'Main');
        expect((await putAgentDefault(b, b.adminCookie, 'org', 'team-model')).statusCode).toBe(200);

        expect((await queueBare(b, b.memberCookie)).statusCode).toBe(HTTP_CREATED);
        expect(b.queued).toEqual([
            { command: 'echo hi', executor: null, scope: 'user', agentType: 'opencode', agentModel: 'team-model' },
        ]);
    });

    it('runs on the platform model once the model setup saved it: no profile, no key, no NO_EXECUTOR', async () => {
        const b = await boot(undefined, { platformModelProvided: true });
        const saved = await b.instance.inject({
            method: 'PUT',
            url: '/api/model-setup',
            headers: { cookie: b.memberCookie },
            payload: { scope: 'personal', provider: 'platform', agentType: 'claude-code', model: 'claude-sonnet-4-5' },
        });
        expect(saved.statusCode).toBe(200);

        expect((await queueBare(b, b.memberCookie)).statusCode).toBe(HTTP_CREATED);
        expect(b.queued).toEqual([
            {
                command: 'echo hi',
                executor: null,
                scope: 'user',
                agentType: 'claude-code',
                agentModel: 'claude-sonnet-4-5',
            },
        ]);
    });

    it('refuses with 409 NO_EXECUTOR, naming where to configure one, when the caller has no usable profile', async () => {
        const b = await boot();
        const response = await queueBare(b, b.memberCookie);
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('NO_EXECUTOR');
        expect(response.json().error).toBe(noExecutorMessage);
        expect(response.json().error).toMatch(/Settings/);
        expect(b.queued).toEqual([]);
    });
});

describe('POST /api/jobs against an executor the scope does not hold', () => {
    it('refuses a missing personal executor with 404 UNKNOWN_EXECUTOR and queues nothing', async () => {
        const b = await boot();
        const response = await queue(b, b.memberCookie, 'ghost', 'user');
        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
        expect(response.json().code).toBe('UNKNOWN_EXECUTOR');
        expect(response.json().error).toBe(executorMissingMessage('user', 'ghost'));
        expect(b.queued).toEqual([]);
    });

    it('does not resolve a personal name under the org scope, nor the reverse', async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        await createOrg(b, 'shared');

        expect((await queue(b, b.memberCookie, 'mine', 'org')).statusCode).toBe(HTTP_NOT_FOUND);
        expect((await queue(b, b.memberCookie, 'shared', 'user')).statusCode).toBe(HTTP_NOT_FOUND);
        expect(b.queued).toEqual([]);
        expect((await queue(b, b.memberCookie, 'shared', 'org')).statusCode).toBe(HTTP_CREATED);
    });

    it('refuses before it checks the repository', async () => {
        const b = await boot();
        const response = await b.instance.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: { cookie: b.memberCookie },
            payload: { command: 'echo hi', executor: 'ghost', executorScope: 'user', repo: 'acme/other' },
        });
        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
        expect(response.json().code).toBe('UNKNOWN_EXECUTOR');
        expect(b.queued).toEqual([]);
    });
});

describe('POST /api/jobs against a repository the board does not track', () => {
    const launch = (b: Booted, payload: Record<string, unknown>) =>
        b.instance.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: { cookie: b.memberCookie },
            payload: { command: 'echo hi', executor: 'mine', executorScope: 'user', ...payload },
        });

    const bootWithExecutor = async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        return b;
    };

    it('refuses a task with no repository', async () => {
        const b = await bootWithExecutor();
        const response = await launch(b, {});
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_REPO');
        expect(b.queued).toEqual([]);
    });

    it('refuses a repository the board does not track', async () => {
        const b = await bootWithExecutor();
        const response = await launch(b, { repo: 'acme/other' });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('UNKNOWN_REPO');
        expect(b.queued).toEqual([]);
    });

    it('still refuses a suspended profile before it checks the repository', async () => {
        const b = await bootWithExecutor();
        await suspend(
            b,
            `/api/workspace/executors/${await personalId(b, 'mine', b.memberCookie)}/suspension`,
            b.memberCookie,
            true
        );
        const response = await launch(b, { repo: 'acme/other' });
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('EXECUTOR_SUSPENDED');
    });

    it('queues a task against a tracked repository', async () => {
        const b = await bootWithExecutor();
        expect((await launch(b, { repo: 'acme/web' })).statusCode).toBe(HTTP_CREATED);
        expect(b.queued).toHaveLength(1);
    });
});

describe('POST /api/jobs selecting a repo skill that only the executor CLI scans', () => {
    /** A reader that holds `oc-only` only when asked for the opencode directories. */
    const dirAware: RepoSkills = async (_repo, _branch, dirs) => ({
        revision: 'sha',
        skills: dirs.includes('.opencode/skills') ? [{ name: 'oc-only', description: 'd' }] : [],
        unreadable: [],
        complete: true,
    });
    const queueSkill = (b: Booted, executor: string) =>
        b.instance.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: { cookie: b.memberCookie },
            payload: {
                command: 'echo hi',
                executor,
                repo: `${READY_REPO.owner}/${READY_REPO.name}`,
                skills: ['oc-only'],
            },
        });

    it('accepts it on an opencode profile', async () => {
        const b = await boot(dirAware);
        await putPersonal(b, b.memberCookie, [entry('claude'), entry('oc', { type: 'opencode' })]);
        expect((await queueSkill(b, 'oc')).statusCode).toBe(HTTP_CREATED);
        expect(b.queued).toHaveLength(1);
    });

    it('refuses it with 404 UNKNOWN_SKILL on a claude profile', async () => {
        const b = await boot(dirAware);
        await putPersonal(b, b.memberCookie, [entry('claude'), entry('oc', { type: 'opencode' })]);
        const response = await queueSkill(b, 'claude');
        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
        expect(response.json().code).toBe('UNKNOWN_SKILL');
        expect(b.queued).toEqual([]);
    });
});

describe('configured default executors', () => {
    const putDefault = (b: Booted, cookie: string, payload: Record<string, unknown>) =>
        b.instance.inject({ method: 'PUT', url: '/api/workspace/executors/default', headers: { cookie }, payload });
    const putOrgDefault = (b: Booted, cookie: string, executorId: string) =>
        b.instance.inject({
            method: 'PUT',
            url: '/api/org/executors/default',
            headers: { cookie },
            payload: { executorId },
        });
    const clearOrgDefault = (b: Booted, cookie: string) =>
        b.instance.inject({ method: 'DELETE', url: '/api/org/executors/default', headers: { cookie } });
    const queueBare = (b: Booted, cookie: string) =>
        b.instance.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: { cookie },
            payload: { command: 'echo hi', repo: `${READY_REPO.owner}/${READY_REPO.name}` },
        });

    it('a member selects a default by id: it outranks the legacy chain and survives a rename by id', async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('first'), entry('second')]);
        const secondId = await personalId(b, 'second', b.memberCookie);
        const firstId = await personalId(b, 'first', b.memberCookie);

        const put = await putDefault(b, b.memberCookie, { executorId: secondId });
        expect(put.statusCode).toBe(HTTP_OK);
        expect(put.json().defaultExecutor).toEqual({ scope: 'user', name: 'second' });
        expect((await queueBare(b, b.memberCookie)).statusCode).toBe(HTTP_CREATED);
        expect(b.queued.at(-1)).toMatchObject({ executor: 'second', scope: 'user' });

        // The rename keeps the identity: the same row is still the default under its new label.
        await putPersonal(b, b.memberCookie, [entry('first', { id: firstId }), entry('renamed', { id: secondId })]);
        expect((await poll(b, b.memberCookie)).defaultExecutor).toEqual({ scope: 'user', name: 'renamed' });
        expect((await queueBare(b, b.memberCookie)).statusCode).toBe(HTTP_CREATED);
        expect(b.queued.at(-1)).toMatchObject({ executor: 'renamed', scope: 'user' });

        // An explicit executor still wins.
        await queue(b, b.memberCookie, 'first', 'user');
        expect(b.queued.at(-1)).toMatchObject({ executor: 'first', scope: 'user' });
    });

    it('refuses an omitted default until it is replaced or cleared, and an id the caller does not own', async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('keep'), entry('drop')]);
        const dropId = await personalId(b, 'drop', b.memberCookie);
        await putDefault(b, b.memberCookie, { executorId: dropId });

        const omitted = await putPersonal(b, b.memberCookie, [entry('keep')]);
        expect(omitted.statusCode).toBe(HTTP_CONFLICT);
        expect(omitted.json().code).toBe('EXECUTOR_IS_DEFAULT');
        const removed = await b.instance.inject({
            method: 'DELETE',
            url: `/api/workspace/executors/${dropId}`,
            headers: { cookie: b.memberCookie },
        });
        expect(removed.statusCode).toBe(HTTP_CONFLICT);
        expect((await poll(b, b.memberCookie)).executors).toHaveLength(2);

        const foreign = await putPersonal(b, b.otherCookie, [entry('mine', { id: dropId })]);
        expect(foreign.statusCode).toBe(HTTP_BAD_REQUEST);

        const cleared = await b.instance.inject({
            method: 'DELETE',
            url: '/api/workspace/executors/default',
            headers: { cookie: b.memberCookie },
        });
        expect(cleared.json()).toEqual({ cleared: true });
        expect((await putPersonal(b, b.memberCookie, [entry('keep')])).statusCode).toBe(HTTP_OK);
    });

    it('an admin configures the organization default: members launch on it, personal beats it, only admins write it', async () => {
        const b = await boot();
        const orgId = await createOrg(b, 'shared');
        await putPersonal(b, b.memberCookie, [entry('mine')]);

        expect((await putOrgDefault(b, b.memberCookie, orgId)).statusCode).toBe(HTTP_FORBIDDEN);
        expect((await putOrgDefault(b, b.adminCookie, orgId)).statusCode).toBe(HTTP_OK);
        // The poll marks the organization's configured default for the admin's Clear action.
        expect((await poll(b, b.otherCookie)).orgExecutors).toEqual([
            expect.objectContaining({ id: orgId, name: 'shared', orgDefault: true }),
        ]);

        // The member has a personal executor but never chose it: the configured org default beats the legacy first row.
        expect((await queueBare(b, b.memberCookie)).statusCode).toBe(HTTP_CREATED);
        expect(b.queued.at(-1)).toMatchObject({ executor: 'shared', scope: 'org' });
        expect((await queueBare(b, b.otherCookie)).statusCode).toBe(HTTP_CREATED);
        expect(b.queued.at(-1)).toMatchObject({ executor: 'shared', scope: 'org' });

        await putDefault(b, b.memberCookie, { executorId: await personalId(b, 'mine', b.memberCookie) });
        await queueBare(b, b.memberCookie);
        expect(b.queued.at(-1)).toMatchObject({ executor: 'mine', scope: 'user' });

        // A personal executor cannot be the organization default, and the organization default is protected.
        const personalTarget = await putOrgDefault(b, b.adminCookie, await personalId(b, 'mine', b.memberCookie));
        expect(personalTarget.statusCode).toBe(HTTP_NOT_FOUND);
        const removed = await b.instance.inject({
            method: 'DELETE',
            url: `/api/org/executors/${orgId}`,
            headers: { cookie: b.adminCookie },
        });
        expect(removed.statusCode).toBe(HTTP_CONFLICT);
        expect(removed.json().code).toBe('EXECUTOR_IS_DEFAULT');

        expect((await clearOrgDefault(b, b.adminCookie)).json()).toEqual({ cleared: true });
        const after = await b.instance.inject({
            method: 'DELETE',
            url: `/api/org/executors/${orgId}`,
            headers: { cookie: b.adminCookie },
        });
        expect(after.statusCode).toBe(HTTP_OK);
    });

    it('a suspended configured default refuses a bare launch instead of falling through, and resuming restores it', async () => {
        const b = await boot();
        const orgId = await createOrg(b, 'shared');
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        await putOrgDefault(b, b.adminCookie, orgId);
        const queuedBefore = b.queued.length;

        await suspend(b, `/api/org/executors/${orgId}/suspension`, b.adminCookie, true);
        const refused = await queueBare(b, b.otherCookie);
        expect(refused.statusCode).toBe(HTTP_CONFLICT);
        expect(refused.json().code).toBe('EXECUTOR_SUSPENDED');
        expect(b.queued).toHaveLength(queuedBefore);
        // The poll names the stale default, with the reason, rather than inventing another.
        expect((await poll(b, b.otherCookie)).defaultExecutor).toEqual({
            scope: 'org',
            name: 'shared',
            unusable: 'suspended',
        });
        // An explicit executor is not a bare launch: it still wins.
        expect((await queue(b, b.otherCookie, 'shared', 'org')).statusCode).toBe(HTTP_CONFLICT);

        await suspend(b, `/api/org/executors/${orgId}/suspension`, b.adminCookie, false);
        expect((await queueBare(b, b.otherCookie)).statusCode).toBe(HTTP_CREATED);
    });
});
