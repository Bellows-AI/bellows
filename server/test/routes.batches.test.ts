import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { JobStore } from '../src/db/job-store-types.js';
import type { UserExecutorStore } from '../src/db/user-executor-store.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import {
    githubAuth,
    memoryAuthStore,
    memoryBatchStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
} from './helpers.js';

/**
 * Offline: the HTTP contract of the batch routes against an in-memory store double. The store's
 * own rules — the composite keys, the optimistic version, the immutable plan — are covered by
 * server/test-db/batch-store.test.ts, which needs a database.
 */

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;

const ORG = 'test-org';
const OTHER_ORG = 'other-org';
const WEB = { owner: 'Bellows-AI', name: 'bellows.ai' };
const API = { owner: 'Bellows-AI', name: 'api' };

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

const task = (key: string, extra: Record<string, unknown> = {}) => ({
    key,
    objective: `do ${key}`,
    acceptance: 'it works',
    verification: 'npm test',
    ...extra,
});

const plan = (overrides: Record<string, unknown> = {}) => ({
    planVersion: 1,
    title: 'Upgrade',
    targets: [{ key: 'web', repo: 'Bellows-AI/bellows.ai' }],
    defaultTarget: 'web',
    stages: [
        { key: 'one', tasks: [task('a'), task('b')] },
        { key: 'two', tasks: [task('c')] },
    ],
    ...overrides,
});

const twoRepoPlan = () =>
    plan({
        targets: [
            { key: 'web', repo: 'Bellows-AI/bellows.ai' },
            { key: 'api', repo: 'Bellows-AI/api' },
        ],
        stages: [{ key: 'one', tasks: [task('a'), task('b', { target: 'api' })] }],
    });

/** A repo source whose installation listing carries default branches, as the real one does. */
function reposWithDefaults(entries: { owner: string; name: string; defaultBranch: string | null }[]) {
    const base = staticRepoSource(entries.map(({ owner, name }) => ({ owner, name })));
    return {
        ...base,
        detail: async () => ({
            repos: entries.map((entry) => ({ ...entry, private: false, pushedAt: null })),
            installation: null,
        }),
    };
}

async function setup(
    options: {
        repos?: { owner: string; name: string; defaultBranch: string | null }[];
        userExecutors?: UserExecutorStore;
        /** The org's board holds an installation it can merge through. */
        canMerge?: boolean;
    } = {}
) {
    const auth = memoryAuthStore();
    const member = auth.seedMember(ORG, 'octocat');
    const other = auth.seedMember(OTHER_ORG, 'hubot');
    const batches = memoryBatchStore();
    const otherBatches = memoryBatchStore();
    const jobCreates: string[] = [];
    const jobs = {
        async create(command: string) {
            jobCreates.push(command);
            return { id: 'never' };
        },
    } as unknown as JobStore;
    const config = testConfig({ auth: githubAuth() });
    const repos = reposWithDefaults(
        options.repos ?? [
            { ...WEB, defaultBranch: 'main' },
            { ...API, defaultBranch: 'main' },
        ]
    );
    app = await buildApp({
        config,
        orgs: staticRegistry({
            config,
            repos,
            jobs,
            telemetry: stubTelemetryClient(),
            batchesByOrg: { [ORG]: batches, [OTHER_ORG]: otherBatches },
            ...(options.canMerge ? { batchMerger: { mergeDue: async () => 0 } } : {}),
            ...(options.userExecutors ? { userExecutors: options.userExecutors } : {}),
        }),
        auth,
    });
    const memberCookie = await signedIn(auth, member);
    const otherCookie = await signedIn(auth, other);
    /** The member's call unless `as` says otherwise: another cookie, none at all, or extra headers. */
    const call = (
        method: 'GET' | 'POST' | 'PUT',
        url: string,
        payload?: unknown,
        as: { cookie?: string | null; headers?: Record<string, string> } = {}
    ) => {
        const cookie = as.cookie === undefined ? memberCookie : as.cookie;
        return app!.inject({
            method,
            url,
            ...(payload === undefined ? {} : { payload: payload as object }),
            headers: { ...(cookie ? { cookie } : {}), ...as.headers },
        });
    };
    const create = async (body: unknown = plan()) => {
        const response = await call('POST', '/api/batches', { plan: body });
        return response.json() as { id: string; version: number };
    };
    return { call, create, batches, otherBatches, jobCreates, memberCookie, otherCookie };
}

describe('POST /api/batches', () => {
    it('creates a draft and reads it back with the three task states and wait reason', async () => {
        const { call, batches } = await setup();
        const response = await call('POST', '/api/batches', { plan: plan() });
        expect(response.statusCode).toBe(HTTP_CREATED);
        const { id, status, version } = response.json();
        expect(status).toBe('draft');
        expect(version).toBe(1);
        expect(batches.writes).toEqual(['create']);

        const read = await call('GET', `/api/batches/${id}`);
        expect(read.statusCode).toBe(HTTP_OK);
        const record = read.json();
        expect(record).toMatchObject({ id, status: 'draft', version: 1 });
        expect(record.plan.stages.map((stage: { key: string }) => stage.key)).toEqual(['one', 'two']);
        expect(record.tasks).toHaveLength(3);
        expect(record.tasks[0]).toMatchObject({
            key: 'a',
            execution: 'pending',
            pr: 'none',
            gate: 'open',
            waitReason: null,
        });
    });

    it('lists the org’s batches', async () => {
        const { call, create } = await setup();
        const { id } = await create();
        const list = await call('GET', '/api/batches');
        expect(list.statusCode).toBe(HTTP_OK);
        expect(list.json().batches).toMatchObject([{ id, title: 'Upgrade', status: 'draft', taskCount: 3 }]);
    });

    it('narrows the list to the batches a thread backs a task of (?task=)', async () => {
        const { call, create, batches } = await setup();
        const { id } = await create();
        await create();
        const thread = '4b1f0c2e-8a6d-4e0f-9a51-0f6a5b1c2d3e';
        batches.mark(id, 'a', { rootJobId: thread });

        const hit = await call('GET', `/api/batches?task=${thread}`);
        expect(hit.json().batches.map((batch: { id: string }) => batch.id)).toEqual([id]);
        const miss = await call('GET', '/api/batches?task=0e9f7d6c-1b2a-4c3d-8e4f-5a6b7c8d9e0f');
        expect(miss.json().batches).toEqual([]);
        const notAThread = await call('GET', '/api/batches?task=nope');
        expect(notAThread.statusCode).toBe(HTTP_OK);
        expect(notAThread.json().batches).toEqual([]);
    });

    it('refuses an invalid plan with path-addressed issues and writes nothing', async () => {
        const { call, batches } = await setup();
        const response = await call('POST', '/api/batches', {
            plan: plan({ stages: [{ key: 'one', dependsOn: ['x'], tasks: [task('a', { target: 'nope' })] }] }),
        });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_BATCH');
        expect(response.json().issues.map((issue: { path: string }) => issue.path)).toEqual([
            'stages[0].dependsOn',
            'stages[0].tasks[0].target',
        ]);
        expect(batches.writes).toEqual([]);
    });

    it('persists a two-repository plan: structural validity is not execution capability', async () => {
        const { call, create } = await setup();
        const { id } = await create(twoRepoPlan());
        const record = (await call('GET', `/api/batches/${id}`)).json();
        expect(record.plan.targets.map((target: { repo: string }) => target.repo)).toEqual([
            'Bellows-AI/bellows.ai',
            'Bellows-AI/api',
        ]);
    });

    it.each(['org', 'orgId', 'status', 'outcome'])('refuses a body field naming %s', async (field) => {
        const { call, batches } = await setup();
        const response = await call('POST', '/api/batches', { plan: plan(), [field]: 'x' });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_BODY');
        expect(response.json().error).toContain('decided by the board');
        expect(batches.writes).toEqual([]);
    });

    it('refuses a plan document that names its own org or status', async () => {
        const { call } = await setup();
        const response = await call('POST', '/api/batches', { plan: plan({ org: 'x', status: 'started' }) });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().issues.map((issue: { path: string }) => issue.path)).toEqual(['org', 'status']);
    });

    it('replays under Idempotency-Key, and refuses the key reused for a different plan', async () => {
        const { call, batches } = await setup();
        const headers = { 'idempotency-key': 'create-key-0001' };
        const first = await call('POST', '/api/batches', { plan: plan() }, { headers });
        const second = await call('POST', '/api/batches', { plan: plan() }, { headers });
        expect(second.statusCode).toBe(HTTP_CREATED);
        expect(second.json()).toEqual(first.json());
        expect(second.headers['idempotency-replayed']).toBe('true');
        expect(first.headers['idempotency-replayed']).toBeUndefined();
        expect(batches.writes).toEqual(['create']);

        const reused = await call('POST', '/api/batches', { plan: plan({ title: 'Other' }) }, { headers });
        expect(reused.statusCode).toBe(HTTP_CONFLICT);
        expect(reused.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
});

describe('PUT /api/batches/:id', () => {
    it('replaces the whole draft and bumps the version', async () => {
        const { call, create } = await setup();
        const { id } = await create();
        const response = await call('PUT', `/api/batches/${id}`, { version: 1, plan: plan({ title: 'Renamed' }) });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({ id, status: 'draft', version: 2 });
        expect((await call('GET', `/api/batches/${id}`)).json().plan.title).toBe('Renamed');
    });

    it('answers 409 BATCH_STALE for an old version and changes nothing', async () => {
        const { call, create, batches } = await setup();
        const { id } = await create();
        await call('PUT', `/api/batches/${id}`, { version: 1, plan: plan({ title: 'Winner' }) });
        const stale = await call('PUT', `/api/batches/${id}`, { version: 1, plan: plan({ title: 'Loser' }) });
        expect(stale.statusCode).toBe(HTTP_CONFLICT);
        expect(stale.json()).toMatchObject({ code: 'BATCH_STALE', version: 2 });
        expect((await call('GET', `/api/batches/${id}`)).json().plan.title).toBe('Winner');
        expect(batches.writes).toEqual(['create', 'replace']);
    });

    it('refuses an invalid plan and a missing version without writing', async () => {
        const { call, create, batches } = await setup();
        const { id } = await create();
        const invalid = await call('PUT', `/api/batches/${id}`, { version: 1, plan: plan({ stages: [] }) });
        expect(invalid.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(invalid.json().code).toBe('BAD_BATCH');
        const unversioned = await call('PUT', `/api/batches/${id}`, { plan: plan() });
        expect(unversioned.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(unversioned.json().code).toBe('BAD_BODY');
        expect(batches.writes).toEqual(['create']);
    });

    it('answers 409 BATCH_STARTED once the batch is started', async () => {
        const { call, create } = await setup();
        const { id } = await create();
        await call('POST', `/api/batches/${id}/start`, { version: 1 });
        const response = await call('PUT', `/api/batches/${id}`, { version: 1, plan: plan({ title: 'Late' }) });
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('BATCH_STARTED');
    });
});

describe('launch checks: validate and start', () => {
    it('validate runs the checks, answers the resolved plan and writes nothing', async () => {
        const { call, create, batches } = await setup();
        const { id } = await create();
        const response = await call('POST', `/api/batches/${id}/validate`, {});
        expect(response.statusCode).toBe(HTTP_OK);
        const body = response.json();
        expect(body).toMatchObject({ valid: true, version: 1 });
        expect(body.plan.targets).toEqual([{ key: 'web', repo: 'Bellows-AI/bellows.ai', branch: 'main' }]);
        expect(batches.writes).toEqual(['create']);
    });

    it('refuses a repository the installation cannot see, for validate and start alike', async () => {
        const { call, create, batches } = await setup({ repos: [{ ...API, defaultBranch: 'main' }] });
        const { id } = await create();
        for (const [path, payload] of [
            ['validate', {}],
            ['start', { version: 1 }],
        ] as const) {
            const response = await call('POST', `/api/batches/${id}/${path}`, payload);
            expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
            expect(response.json().code).toBe('UNKNOWN_REPO');
        }
        expect(batches.writes).toEqual(['create']);
    });

    it('refuses a repository that reports no default branch', async () => {
        const { call, create } = await setup({ repos: [{ ...WEB, defaultBranch: null }] });
        const { id } = await create();
        const response = await call('POST', `/api/batches/${id}/validate`, {});
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('BATCH_NO_DEFAULT_BRANCH');
    });

    it('answers 409 BATCH_UNSUPPORTED for a multi-target start and creates no job', async () => {
        const { call, create, jobCreates, batches } = await setup();
        const { id } = await create(twoRepoPlan());
        const response = await call('POST', `/api/batches/${id}/start`, { version: 1 });
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json()).toMatchObject({ code: 'BATCH_UNSUPPORTED', reason: 'multi_target' });
        expect(jobCreates).toEqual([]);
        expect(batches.writes).toEqual(['create']);
        expect((await call('GET', `/api/batches/${id}`)).json().status).toBe('draft');
    });

    it('answers 409 BATCH_UNSUPPORTED for a branch other than the default', async () => {
        const { call, create } = await setup();
        const { id } = await create(
            plan({ targets: [{ key: 'web', repo: 'Bellows-AI/bellows.ai', branch: 'release' }] })
        );
        const response = await call('POST', `/api/batches/${id}/validate`, {});
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json()).toMatchObject({ code: 'BATCH_UNSUPPORTED', reason: 'non_default_branch' });
    });

    it('answers 409 BATCH_UNSUPPORTED for an automerge stage on a board that cannot merge', async () => {
        const { call, create, batches } = await setup();
        const { id } = await create(plan({ policy: 'automerge' }));
        const response = await call('POST', `/api/batches/${id}/start`, { version: 1 });
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json()).toMatchObject({ code: 'BATCH_UNSUPPORTED', reason: 'automerge' });
        expect(batches.writes).toEqual(['create']);
    });

    it('starts an automerge stage on a board that can merge', async () => {
        const { call, create } = await setup({ canMerge: true });
        const { id } = await create(plan({ policy: 'automerge' }));
        const response = await call('POST', `/api/batches/${id}/start`, { version: 1 });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toMatchObject({ id, status: 'started' });
    });

    it('freezes a single-target batch through the same shape; dispatch is the store’s, not the route’s', async () => {
        const { call, create, jobCreates } = await setup();
        const { id } = await create(plan({ policy: 'human', executor: 'claude' }));
        const response = await call('POST', `/api/batches/${id}/start`, { version: 1 });
        expect(response.statusCode).toBe(HTTP_OK);
        const record = response.json();
        expect(record).toMatchObject({ id, status: 'started', version: 1 });
        expect(record.startedBy).not.toBeNull();
        expect(record.plan.targets[0].branch).toBe('main');
        expect(record.plan.stages.map((stage: { policy: string }) => stage.policy)).toEqual(['human', 'human']);
        expect(record.plan.stages[0].tasks[0]).toMatchObject({ target: 'web', executor: 'claude' });
        expect(record.tasks.every((state: { execution: string }) => state.execution === 'pending')).toBe(true);
        expect(jobCreates).toEqual([]);
    });

    it('answers 409 BATCH_STALE for a start at an old version, and BATCH_STARTED the second time', async () => {
        const { call, create } = await setup();
        const { id } = await create();
        await call('PUT', `/api/batches/${id}`, { version: 1, plan: plan({ title: 'Edited' }) });
        const stale = await call('POST', `/api/batches/${id}/start`, { version: 1 });
        expect(stale.statusCode).toBe(HTTP_CONFLICT);
        expect(stale.json().code).toBe('BATCH_STALE');
        expect((await call('POST', `/api/batches/${id}/start`, { version: 2 })).statusCode).toBe(HTTP_OK);
        const again = await call('POST', `/api/batches/${id}/start`, { version: 2 });
        expect(again.statusCode).toBe(HTTP_CONFLICT);
        expect(again.json().code).toBe('BATCH_STARTED');
    });

    it('replays a start under Idempotency-Key instead of answering BATCH_STARTED', async () => {
        const { call, create, batches } = await setup();
        const { id } = await create();
        const headers = { 'idempotency-key': 'start-key-0001' };
        const first = await call('POST', `/api/batches/${id}/start`, { version: 1 }, { headers });
        const second = await call('POST', `/api/batches/${id}/start`, { version: 1 }, { headers });
        expect(first.statusCode).toBe(HTTP_OK);
        expect(second.statusCode).toBe(HTTP_OK);
        expect(second.headers['idempotency-replayed']).toBe('true');
        expect(second.json().status).toBe('started');
        // The replay answered before any launch check, write or dispatch: one start, one pass.
        expect(batches.writes).toEqual(['create', 'start', 'reconcile']);
    });

    it('refuses a suspended executor', async () => {
        const userExecutors = {
            async configFor() {
                return { type: 'claude-code', config: {}, gateFixRounds: 2, suspended: true };
            },
        } as unknown as UserExecutorStore;
        const { call, create } = await setup({ userExecutors });
        const { id } = await create(plan({ executor: 'work' }));
        const response = await call('POST', `/api/batches/${id}/validate`, {});
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('EXECUTOR_SUSPENDED');
    });

    it('looks each executor up in the scope the plan names, and names a suspended org one', async () => {
        const asked: [string, string][] = [];
        const userExecutors = {
            async configFor(_user: string, name: string, scope: string) {
                asked.push([name, scope]);
                return { type: 'claude-code', config: {}, gateFixRounds: 2, suspended: scope === 'org' };
            },
        } as unknown as UserExecutorStore;
        const { call, create } = await setup({ userExecutors });
        const { id } = await create(plan({ executor: 'Main ORG', executorScope: 'org' }));
        const response = await call('POST', `/api/batches/${id}/validate`, {});
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json()).toMatchObject({ code: 'EXECUTOR_SUSPENDED' });
        expect(response.json().error).toContain('organization executor "Main ORG"');
        expect(asked).toEqual([['Main ORG', 'org']]);
    });

    it('refuses an executor the named scope does not hold, on validate and on start, before anything dispatches', async () => {
        const userExecutors = {
            async configFor() {
                return null;
            },
        } as unknown as UserExecutorStore;
        const { call, create, batches } = await setup({ userExecutors });
        const { id } = await create(plan({ executor: 'Main ORG' }));
        for (const route of ['validate', 'start']) {
            const response = await call('POST', `/api/batches/${id}/${route}`, route === 'start' ? { version: 1 } : {});
            expect(response.statusCode, route).toBe(HTTP_NOT_FOUND);
            expect(response.json(), route).toMatchObject({ code: 'UNKNOWN_EXECUTOR' });
            expect(response.json().error, route).toContain('personal executor "Main ORG"');
        }
        expect(batches.writes).toEqual(['create']);
    });

    it('refuses an unknown or non-string version', async () => {
        const { call, create } = await setup();
        const { id } = await create();
        const response = await call('POST', `/api/batches/${id}/start`, { version: '1' });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_BODY');
    });
});

describe('org scoping and availability', () => {
    it('answers 404 for another org’s batch id on every route', async () => {
        const { call, create, otherCookie } = await setup();
        const { id } = await create();
        const asOther = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
            call(method, url, payload, { cookie: otherCookie });
        expect((await asOther('GET', `/api/batches/${id}`)).statusCode).toBe(HTTP_NOT_FOUND);
        expect((await asOther('PUT', `/api/batches/${id}`, { version: 1, plan: plan() })).statusCode).toBe(
            HTTP_NOT_FOUND
        );
        expect((await asOther('POST', `/api/batches/${id}/validate`, {})).statusCode).toBe(HTTP_NOT_FOUND);
        expect((await asOther('POST', `/api/batches/${id}/start`, { version: 1 })).statusCode).toBe(HTTP_NOT_FOUND);
        expect((await asOther('GET', '/api/batches')).json().batches).toEqual([]);
    });

    it('answers 404 for a malformed id', async () => {
        const { call } = await setup();
        expect((await call('GET', '/api/batches/not-a-uuid')).statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('answers 503 when the org’s runtime carries no batch store', async () => {
        const auth = memoryAuthStore();
        const member = auth.seedMember(ORG, 'octocat');
        const config = testConfig({ auth: githubAuth() });
        app = await buildApp({ config, orgs: staticRegistry({ config }), auth });
        const response = await app.inject({
            method: 'GET',
            url: '/api/batches',
            headers: { cookie: await signedIn(auth, member) },
        });
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(response.json().code).toBe('BATCHES_UNAVAILABLE');
    });
});

describe('dispatch, wait, retry and cancel', () => {
    const start = async (setupResult: Awaited<ReturnType<typeof setup>>) => {
        const { id } = await setupResult.create();
        await setupResult.call('POST', `/api/batches/${id}/start`, { version: 1 });
        return id;
    };

    it('start runs the first scheduling pass after it freezes the plan', async () => {
        const s = await setup();
        await start(s);
        expect(s.batches.writes).toEqual(['create', 'start', 'reconcile']);
    });

    it('wait answers parked at once when nothing moves, with the batch beside the result', async () => {
        const s = await setup();
        const id = await start(s);
        const response = await s.call('GET', `/api/batches/${id}?waitFor=terminal&timeout=1`);
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toMatchObject({ result: 'parked', batch: { id, status: 'started' } });
    });

    it('wait answers timeout while a task still moves', async () => {
        const s = await setup();
        const id = await start(s);
        s.batches.mark(id, 'a', { execution: 'running' });
        const response = await s.call('GET', `/api/batches/${id}?waitFor=terminal&timeout=1`);
        expect(response.json()).toMatchObject({ result: 'timeout' });
    });

    it('wait answers terminal once the batch is cancelled with nothing moving', async () => {
        const s = await setup();
        const id = await start(s);
        await s.call('POST', `/api/batches/${id}/cancel`, {});
        const response = await s.call('GET', `/api/batches/${id}?waitFor=terminal&timeout=1`);
        expect(response.json()).toMatchObject({ result: 'terminal' });
    });

    it('refuses a bad wait query and a wait on a draft', async () => {
        const s = await setup();
        const { id } = await s.create();
        const bad = await s.call('GET', `/api/batches/${id}?waitFor=settled`);
        expect(bad.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(bad.json().code).toBe('BAD_WAIT_FOR');
        const draft = await s.call('GET', `/api/batches/${id}?waitFor=terminal`);
        expect(draft.statusCode).toBe(HTTP_CONFLICT);
        expect(draft.json().code).toBe('BATCH_NOT_STARTED');
    });

    it('retry queues a failed task, refuses a healthy one, and 404s an unknown key', async () => {
        const s = await setup();
        const id = await start(s);
        s.batches.mark(id, 'a', { execution: 'failed' });
        const retried = await s.call('POST', `/api/batches/${id}/tasks/a/retry`, {});
        expect(retried.statusCode).toBe(HTTP_OK);
        expect(retried.json().tasks.find((t: { key: string }) => t.key === 'a').execution).toBe('retry');

        const healthy = await s.call('POST', `/api/batches/${id}/tasks/b/retry`, {});
        expect(healthy.statusCode).toBe(HTTP_CONFLICT);
        expect(healthy.json().code).toBe('BATCH_TASK_NOT_RETRYABLE');

        const unknown = await s.call('POST', `/api/batches/${id}/tasks/nope/retry`, {});
        expect(unknown.statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('retry refuses a draft and a cancelled batch with their own codes', async () => {
        const s = await setup();
        const { id: draft } = await s.create();
        const notStarted = await s.call('POST', `/api/batches/${draft}/tasks/a/retry`, {});
        expect(notStarted.json().code).toBe('BATCH_NOT_STARTED');

        const id = await start(s);
        await s.call('POST', `/api/batches/${id}/cancel`, {});
        const cancelled = await s.call('POST', `/api/batches/${id}/tasks/a/retry`, {});
        expect(cancelled.statusCode).toBe(HTTP_CONFLICT);
        expect(cancelled.json().code).toBe('BATCH_CANCELLED');
    });

    it('retry refuses an expired batch with its own code', async () => {
        const s = await setup();
        const id = await start(s);
        s.batches.mark(id, 'a', { execution: 'failed' });
        s.batches.expire(id);
        const expired = await s.call('POST', `/api/batches/${id}/tasks/a/retry`, {});
        expect(expired.statusCode).toBe(HTTP_CONFLICT);
        expect(expired.json().code).toBe('BATCH_EXPIRED');
    });

    it('the report answers for a started batch, 409s a draft and 404s a stranger', async () => {
        const s = await setup();
        const id = await start(s);
        const report = await s.call('GET', `/api/batches/${id}/report`);
        expect(report.statusCode).toBe(HTTP_OK);
        expect(report.json()).toMatchObject({
            id,
            budgets: { infraRetries: 2, repairs: 2, timeLimitMinutes: 720 },
            latestObservationAt: null,
            unavailable: ['tokens', 'cost'],
        });

        const { id: draft } = await s.create();
        const notStarted = await s.call('GET', `/api/batches/${draft}/report`);
        expect(notStarted.statusCode).toBe(HTTP_CONFLICT);
        expect(notStarted.json().code).toBe('BATCH_NOT_STARTED');

        const anonymous = await s.call('GET', `/api/batches/${id}/report`, undefined, { cookie: null });
        expect(anonymous.statusCode).toBe(HTTP_UNAUTHORIZED);
        const foreign = await s.call('GET', `/api/batches/${id}/report`, undefined, { cookie: s.otherCookie });
        expect(foreign.statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('cancel stamps the batch, and a repeat answers the same without a second write', async () => {
        const s = await setup();
        const id = await start(s);
        const first = await s.call('POST', `/api/batches/${id}/cancel`, {});
        expect(first.statusCode).toBe(HTTP_OK);
        expect(first.json().cancelledAt).not.toBeNull();
        const again = await s.call('POST', `/api/batches/${id}/cancel`, {});
        expect(again.statusCode).toBe(HTTP_OK);
        expect(s.batches.writes.filter((write) => write === 'cancel')).toHaveLength(1);
    });

    it('cancel refuses a draft', async () => {
        const s = await setup();
        const { id } = await s.create();
        const response = await s.call('POST', `/api/batches/${id}/cancel`, {});
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('BATCH_NOT_STARTED');
    });

    it('retry and cancel need a signed-in member and the caller’s own org', async () => {
        const s = await setup();
        const id = await start(s);
        for (const suffix of ['/cancel', '/tasks/a/retry']) {
            const anonymous = await s.call('POST', `/api/batches/${id}${suffix}`, {}, { cookie: null });
            expect(anonymous.statusCode).toBe(HTTP_UNAUTHORIZED);
            const foreign = await s.call('POST', `/api/batches/${id}${suffix}`, {}, { cookie: s.otherCookie });
            expect(foreign.statusCode).toBe(HTTP_NOT_FOUND);
        }
    });
});

describe('accept', () => {
    const acceptedPlan = () =>
        plan({
            stages: [
                {
                    key: 'one',
                    tasks: [task('a', { completion: { kind: 'accepted', condition: 'reviewed' } }), task('b')],
                },
            ],
        });
    const startAccepted = async () => {
        const s = await setup();
        const { id } = await s.create(acceptedPlan());
        await s.call('POST', `/api/batches/${id}/start`, { version: 1 });
        return { ...s, id };
    };

    it('needs a signed-in member and the caller’s own org, and 404s a missing batch', async () => {
        const { call, otherCookie, id } = await startAccepted();
        const url = `/api/batches/${id}/tasks/a/accept`;
        expect((await call('POST', url, {}, { cookie: null })).statusCode).toBe(HTTP_UNAUTHORIZED);
        expect((await call('POST', url, {}, { cookie: otherCookie })).statusCode).toBe(HTTP_NOT_FOUND);
        const missing = await call('POST', '/api/batches/00000000-0000-4000-8000-000000000000/tasks/a/accept', {});
        expect(missing.statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('answers 404 for a task key the batch does not have', async () => {
        const { call, id } = await startAccepted();
        expect((await call('POST', `/api/batches/${id}/tasks/nope/accept`, {})).statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('records the acceptance of a finished accepted-completion task, as the caller', async () => {
        const { call, batches, id } = await startAccepted();
        batches.mark(id, 'a', { execution: 'succeeded' });
        const response = await call('POST', `/api/batches/${id}/tasks/a/accept`, {});
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json().tasks.find((t: { key: string }) => t.key === 'a').gate).toBe('passed');
        expect(batches.writes.filter((write) => write.startsWith('accept:'))).toHaveLength(1);
    });

    it('refuses a task that has not finished, and a PR-completion task, with BATCH_TASK_NOT_ACCEPTABLE', async () => {
        const { call, batches, id } = await startAccepted();
        const early = await call('POST', `/api/batches/${id}/tasks/a/accept`, {});
        expect(early.statusCode).toBe(HTTP_CONFLICT);
        expect(early.json().code).toBe('BATCH_TASK_NOT_ACCEPTABLE');

        batches.mark(id, 'b', { execution: 'succeeded' });
        const pr = await call('POST', `/api/batches/${id}/tasks/b/accept`, {});
        expect(pr.statusCode).toBe(HTTP_CONFLICT);
        expect(pr.json().code).toBe('BATCH_TASK_NOT_ACCEPTABLE');
    });

    it('refuses a draft and a cancelled batch with their own codes, and a body field', async () => {
        const s = await setup();
        const { id: draft } = await s.create(acceptedPlan());
        expect((await s.call('POST', `/api/batches/${draft}/tasks/a/accept`, {})).json().code).toBe(
            'BATCH_NOT_STARTED'
        );

        const { id } = await s.create(acceptedPlan());
        await s.call('POST', `/api/batches/${id}/start`, { version: 1 });
        const stray = await s.call('POST', `/api/batches/${id}/tasks/a/accept`, { condition: 'x' });
        expect(stray.statusCode).toBe(HTTP_BAD_REQUEST);
        await s.call('POST', `/api/batches/${id}/cancel`, {});
        expect((await s.call('POST', `/api/batches/${id}/tasks/a/accept`, {})).json().code).toBe('BATCH_CANCELLED');
    });
});
