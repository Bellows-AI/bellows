import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { JobStore, TaskListFilters, TaskListResponse, TaskSummary } from '../src/db/job-store-types.js';
import { encodeCursor } from '../src/db/task-summary.js';
import { githubAuth, memoryAuthStore, signedIn, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';
import { HTTP_BAD_REQUEST, HTTP_OK, HTTP_SERVICE_UNAVAILABLE, trackApps } from './helpers-http.js';

const track = trackApps();

const ORG = 'test-org';

const UUID_SEGMENT_WIDTH = 12;

/** Root ids are uuids — the cursor binds one — so fixtures name threads by number. */
const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(UUID_SEGMENT_WIDTH, '0')}`;

const MS_PER_MINUTE = 60_000;

/** ISO stamps count backwards from a fixed base — `at(60)` is an hour before `at(5)`. */
const at = (minutes: number): string =>
    new Date(Date.parse('2026-09-10T12:00:00.000Z') - minutes * MS_PER_MINUTE).toISOString();

const summary = (n: number, status: TaskSummary['status']): TaskSummary => ({
    id: uid(n),
    headRunId: uid(n),
    command: `task ${n}`,
    status,
    cancelRequestedAt: null,
    doneAt: null,
    repo: null,
    executor: null,
    executorScope: 'user',
    author: null,
    activity: null,
    summary: null,
    waitReason: null,
    waitingSince: null,
    waitTerminalReason: null,
    needsAnswer: false,
    createdAt: at(60),
    activityAt: at(1),
});

/**
 * The store's answer, canned: the route hands it through untouched. The read model itself —
 * buckets, navigation, filters, paging — is the SQL's, pinned in server/test-db/job-store.tasks.test.ts.
 */
const ANSWER: TaskListResponse = {
    navigation: {
        counts: { running: 1, review: 1, past: 0 },
        running: [summary(1, 'running')],
        review: [summary(2, 'succeeded')],
    },
    page: { items: [summary(1, 'running'), summary(2, 'succeeded')], nextCursor: null },
};

interface TaskStub extends JobStore {
    asked: TaskListFilters[];
}

/** A board answering ANSWER, with the filters each call saw recorded. */
const taskStub = (options: { fail?: boolean } = {}): TaskStub => {
    const stub = {
        asked: [] as TaskListFilters[],
        async listTasks(filters: TaskListFilters): Promise<TaskListResponse> {
            if (options.fail) throw new Error('database is down');
            stub.asked.push(filters);
            return ANSWER;
        },
    };
    return stub as unknown as TaskStub;
};

async function openHarness(jobs?: TaskStub) {
    const config = testConfig();
    const instance = await buildApp({
        config,
        orgs: staticRegistry({ config, jobs, telemetry: stubTelemetryClient() }),
    });
    track(instance);
    return instance;
}

async function githubHarness(jobs?: TaskStub, orgsFor?: readonly string[]) {
    const store = memoryAuthStore();
    const config = testConfig({ auth: githubAuth() });
    const instance = await buildApp({
        config,
        orgs: staticRegistry({ config, jobs, telemetry: stubTelemetryClient(), ...(orgsFor ? { orgsFor } : {}) }),
        auth: store,
    });
    track(instance);
    return { instance, store };
}

const mint = (payload: Record<string, unknown>): string => Buffer.from(JSON.stringify(payload)).toString('base64url');

describe('GET /api/tasks', () => {
    it('answers the store response untouched, asking with the default filters', async () => {
        const store = taskStub();
        const instance = await openHarness(store);

        const response = await instance.inject({ method: 'GET', url: '/api/tasks' });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual(ANSWER);
        expect(store.asked).toEqual([{ state: 'attention', sort: 'newest', limit: 30 }]);
    });
});

describe('GET /api/tasks: filters and cursors', () => {
    it('passes every filter normalized to the store', async () => {
        const store = taskStub();
        const instance = await openHarness(store);

        const response = await instance.inject({
            method: 'GET',
            url: '/api/tasks?state=running&q=%20fix%20&repo=acme/web&author=Cat&sort=oldest&limit=7',
        });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(store.asked).toEqual([
            { state: 'running', q: 'fix', repo: 'acme/web', author: 'cat', sort: 'oldest', limit: 7 },
        ]);
    });

    const OVER_QUERY_LIMIT = 201;
    const OVER_AUTHOR_LIMIT = 101;
    const STALE_CURSOR_ACTIVITY_MIN = 30;
    const STALE_CURSOR_ROOT_ID = 99;

    it.each([
        ['an unknown state', '/api/tasks?state=whenever', 'BAD_TASK_STATE'],
        ['an over-long query', `/api/tasks?q=${'x'.repeat(OVER_QUERY_LIMIT)}`, 'BAD_QUERY'],
        ['a repeated query key', '/api/tasks?q=one&q=two', 'BAD_QUERY'],
        ['a malformed repository', '/api/tasks?repo=nope', 'BAD_REPO'],
        ['an over-long author', `/api/tasks?author=${'x'.repeat(OVER_AUTHOR_LIMIT)}`, 'BAD_AUTHOR'],
        ['an author with a space', '/api/tasks?author=octo%20cat', 'BAD_AUTHOR'],
        ['an unknown sort', '/api/tasks?sort=funny', 'BAD_SORT'],
        ['a zero limit', '/api/tasks?limit=0', 'BAD_LIMIT'],
        ['an over-cap limit', '/api/tasks?limit=51', 'BAD_LIMIT'],
        ['a non-numeric limit', '/api/tasks?limit=lots', 'BAD_LIMIT'],
        ['a garbage cursor', '/api/tasks?cursor=garbage', 'BAD_CURSOR'],
        [
            'a stale-version cursor',
            `/api/tasks?cursor=${mint({
                v: 99,
                sort: 'newest',
                state: 'attention',
                activityAt: at(STALE_CURSOR_ACTIVITY_MIN),
                rootId: uid(STALE_CURSOR_ROOT_ID),
            })}`,
            'BAD_CURSOR',
        ],
        [
            'a cursor minted for another sort',
            `/api/tasks?sort=oldest&cursor=${encodeCursor({
                sort: 'newest',
                state: 'attention',
                activityAt: at(STALE_CURSOR_ACTIVITY_MIN),
                rootId: uid(STALE_CURSOR_ROOT_ID),
            })}`,
            'BAD_CURSOR',
        ],
        [
            'a cursor minted under other filters',
            `/api/tasks?q=other&cursor=${encodeCursor({
                sort: 'newest',
                state: 'attention',
                q: 'crafted',
                activityAt: at(STALE_CURSOR_ACTIVITY_MIN),
                rootId: uid(STALE_CURSOR_ROOT_ID),
            })}`,
            'BAD_CURSOR',
        ],
    ])('refuses %s', async (_label, url, code) => {
        const instance = await openHarness(taskStub());
        const response = await instance.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe(code);
    });

    it('accepts a cursor this endpoint minted', async () => {
        const MINTED_ACTIVITY_MIN = 30;
        const MINTED_ROOT_ID = 99;
        const store = taskStub();
        const instance = await openHarness(store);
        const cursor = encodeCursor({
            sort: 'newest',
            state: 'attention',
            q: 'fix the',
            activityAt: at(MINTED_ACTIVITY_MIN),
            rootId: uid(MINTED_ROOT_ID),
        });

        const response = await instance.inject({ method: 'GET', url: `/api/tasks?q=fix%20the&cursor=${cursor}` });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(store.asked[0]).toMatchObject({ q: 'fix the', cursor });
    });
});

describe('GET /api/tasks: failures', () => {
    it('answers 503 when the store fails, without echoing the query', async () => {
        const instance = await openHarness(taskStub({ fail: true }));
        const response = await instance.inject({ method: 'GET', url: '/api/tasks?q=claude%20-p%20secret-prompt' });
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(JSON.stringify(response.json())).not.toContain('secret-prompt');
    });

    it('answers 503 when the org has no job board', async () => {
        const instance = await openHarness(undefined);
        const response = await instance.inject({ method: 'GET', url: '/api/tasks' });
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(response.json().code).toBe('JOBS_UNAVAILABLE');
    });
});

describe('GET /api/tasks authorization', () => {
    it('answers a signed-in member', async () => {
        const { instance, store } = await githubHarness(taskStub());
        const caller = store.seedMember(ORG, 'octocat');
        const cookie = await signedIn(store, caller);
        const response = await instance.inject({ method: 'GET', url: '/api/tasks', headers: { cookie } });
        expect(response.statusCode).toBe(HTTP_OK);
    });

    it('accepts a personal access token', async () => {
        const { instance, store } = await githubHarness(taskStub());
        const caller = store.seedMember(ORG, 'octocat');
        const token = store.seedAccessToken(ORG, 'personal', { userId: caller.user.id });
        const response = await instance.inject({
            method: 'GET',
            url: '/api/tasks',
            headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(HTTP_OK);
    });

    it('resolves the organization from the credential, never the query', async () => {
        const { instance, store } = await githubHarness(taskStub(), [ORG]);
        const caller = store.seedMember(ORG, 'octocat');
        const cookie = await signedIn(store, caller);
        // The registry answers only for the caller's own org; a query param naming another one
        // must change nothing — the route never reads an org from the query.
        const response = await instance.inject({
            method: 'GET',
            url: '/api/tasks?org=somewhere-else',
            headers: { cookie },
        });
        expect(response.statusCode).toBe(HTTP_OK);
    });
});
