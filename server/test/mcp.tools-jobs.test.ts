import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { McpCaller, OAuthStore } from '../src/auth/oauth-store.js';
import { hashToken } from '../src/auth/session.js';
import type { ArtifactStore } from '../src/artifacts/artifact-store.js';
import type { TaskListFilters } from '../src/db/jobs/job-store-types.js';
import { decodeCursor, encodeCursor } from '../src/db/task-summary.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { OrgRegistry } from '../src/orgs.js';
import { fakeArtifacts, manifest, stream } from './helpers-artifacts.js';
import {
    githubAuth,
    jobStoreSlice,
    memoryAuthStore,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
} from './helpers.js';
import { trackApps } from './helpers-http.js';

/**
 * The task, job, log and question read tools through the real auth plugin and bridge, driven by a v2 client over
 * `POST /api/mcp`, on in-memory board fakes. `server/test-db/mcp.tools-jobs.test.ts` runs them over real stores.
 */

const track = trackApps();
const LOCALHOST = '127.0.0.1';
const MODERN = '2026-07-28';
const TOKENS = {
    alice: 'mat_jobs-alice-token-0123456789',
    bob: 'mat_jobs-bob-token-0123456789',
    dave: 'mat_jobs-dave-token-0123456789',
} as const;
type Who = keyof typeof TOKENS;

const JOB_A = '11111111-1111-4111-8111-111111111111';
const FOLLOW_A = '22222222-2222-4222-8222-222222222222';
const JOB_B = '33333333-3333-4333-8333-333333333333';

const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, LOCALHOST, () => {
            const address = probe.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            probe.close(() => resolve(port));
        });
    });

const run = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    rootJobId: JOB_A,
    command: `task ${id.slice(0, 4)}`,
    status: 'succeeded',
    repo: 'acme/web',
    executor: null,
    executorScope: null,
    baseBranch: null,
    mode: 'objective',
    followUpTo: null,
    attempts: 1,
    maxAttempts: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:05:00.000Z',
    exitCode: 0,
    failureKind: null,
    failureCause: null,
    summary: 'did the thing',
    output: 'ok',
    gates: null,
    waitReason: null,
    publication: null,
    author: { login: 'alice' },
    questions: [],
    integrationRequirements: [],
    ...over,
});

const taskRow = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    headRunId: id,
    command: `task ${id.slice(0, 4)}`,
    status: 'succeeded',
    cancelRequestedAt: null,
    doneAt: null,
    repo: 'acme/web',
    executor: null,
    executorScope: 'user',
    author: { login: 'alice' },
    activity: null,
    summary: 'done',
    waitReason: null,
    waitingSince: null,
    waitTerminalReason: null,
    needsAnswer: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    activityAt: '2026-01-01T00:05:00.000Z',
    ...over,
});

const question = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    attempt: 1,
    questions: [
        { question: 'Which db?', header: 'Pick', multiSelect: false, options: [{ label: 'pg' }, { label: 'sqlite' }] },
    ],
    status: 'pending',
    answerable: true,
    answers: null,
    answeredBy: null,
    askedAt: '2026-01-01T00:01:00.000Z',
    answeredAt: null,
    ...over,
});

interface Board {
    tasks?: ReturnType<typeof taskRow>[];
    jobs?: ReturnType<typeof run>[];
    thread?: ReturnType<typeof run>[];
    filters?: TaskListFilters[];
    listQueries?: { status?: string; repo?: string; limit: number }[];
    threadFails?: boolean;
    tasksFail?: boolean;
    artifacts?: ArtifactStore;
}

const PAGE = 2;

const storeOf = (board: Board) =>
    jobStoreSlice({
        listTasks: async (filters: TaskListFilters) => {
            if (board.tasksFail) throw new Error('db down');
            board.filters?.push(filters);
            const all = board.tasks ?? [];
            const after = filters.cursor ? decodeCursor(filters.cursor, filters)?.rootId : undefined;
            const from = after === undefined ? 0 : all.findIndex((t) => t.id === after) + 1;
            const items = all.slice(from, from + Math.min(filters.limit, PAGE));
            const last = items.at(-1);
            const more = from + items.length < all.length;
            return {
                navigation: { counts: { running: 1, review: 2, past: 3 }, running: [], review: [] },
                page: {
                    items,
                    nextCursor:
                        more && last
                            ? encodeCursor({
                                  sort: filters.sort,
                                  state: filters.state,
                                  q: filters.q,
                                  repo: filters.repo,
                                  author: filters.author,
                                  activityAt: last.activityAt,
                                  rootId: last.id,
                              })
                            : null,
                },
            };
        },
        list: async (query: { status?: string; repo?: string; limit: number }) => {
            board.listQueries?.push(query);
            return (board.jobs ?? []).slice(0, query.limit);
        },
        get: async (id: string) => [...(board.jobs ?? []), ...(board.thread ?? [])].find((j) => j.id === id) ?? null,
        thread: async (id: string) => {
            if (board.threadFails) throw new Error('db down');
            return (board.thread ?? []).some((j) => j.id === id) ? board.thread : null;
        },
    });

async function boot(boards: { a: Board; b?: Board }) {
    const port = await freePort();
    const publicUrl = `http://${LOCALHOST}:${port}`;
    const resource = `${publicUrl}/api/mcp`;
    const auth = memoryAuthStore();
    const people = {
        alice: auth.seedMember('org-a', 'alice', 'admin'),
        bob: auth.seedMember('org-b', 'bob', 'member'),
        dave: auth.seedMember('org-a', 'dave', 'member'),
    };
    const scopes: Record<Who, McpCaller['scopes']> = {
        alice: ['factory:read'],
        bob: ['factory:read'],
        dave: ['factory:write'],
    };
    const tokens = new Map<string, McpCaller>(
        (Object.keys(TOKENS) as Who[]).map((who) => [
            hashToken(TOKENS[who]).toString('hex'),
            { ...people[who], scopes: scopes[who], clientId: 'c', resource, familyId: `f-${who}` },
        ])
    );
    const oauth: Pick<OAuthStore, 'findAccessToken'> = {
        findAccessToken: async (hash) => tokens.get(hash.toString('hex')) ?? null,
    };
    const config = testConfig({
        auth: githubAuth({ publicUrl }),
        port,
        mcp: { enabled: true, resource, trustedOrigins: [] },
    });
    const registry = (board: Board) =>
        staticRegistry({
            config,
            telemetry: stubTelemetryClient(),
            repos: staticRepoSource([]),
            jobs: storeOf(board),
            ...(board.artifacts ? { artifacts: board.artifacts } : {}),
        });
    const orgA = registry(boards.a);
    const orgB = registry(boards.b ?? {});
    const orgs: OrgRegistry = { ...orgA, for: (id) => (id === 'org-b' ? orgB.for(id) : orgA.for(id)) };
    const app = track(await buildApp({ config, orgs, store: telemetryStoreStub(), auth, oauth: oauth as OAuthStore }));
    await app.listen({ port, host: LOCALHOST });
    return new URL(resource);
}

const connect = async (url: URL, who: Who) => {
    const client = new Client({ name: 'jobs', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(
        new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TOKENS[who]}` } } })
    );
    return client;
};

const call = async (url: URL, who: Who, name: string, args: Record<string, unknown> = {}) => {
    const client = await connect(url, who);
    try {
        const result = await client.callTool({ name, arguments: args });
        // biome-ignore lint/suspicious/noExplicitAny: structured content is asserted field by field below
        return { ...result, data: result.structuredContent as Record<string, any> };
    } finally {
        await client.close();
    }
};

const NAMES = [
    'get_task',
    'get_task_result',
    'investigate_job',
    'job_activity',
    'list_job_streams',
    'list_jobs',
    'list_questions',
    'list_tasks',
    'read_job_log',
];

describe('the task, job, log and question tools over POST /api/mcp', () => {
    it('are listed read-only with an output schema', async () => {
        const client = await connect(await boot({ a: {} }), 'alice');
        const { tools } = await client.listTools();
        for (const name of NAMES) {
            const tool = tools.find((t) => t.name === name);
            expect(tool, name).toBeDefined();
            expect(tool?.annotations?.readOnlyHint, name).toBe(true);
            expect(tool?.outputSchema?.type, name).toBe('object');
        }
        for (const name of ['list_tasks', 'list_jobs']) {
            expect(tools.find((t) => t.name === name)?.description, name).toMatch(/integration/);
        }
        await client.close();
    });

    it('refuse a caller without factory:read before reaching the board', async () => {
        const url = await boot({ a: {} });
        for (const name of NAMES) {
            const result = await call(url, 'dave', name, { jobId: JOB_A, taskId: JOB_A });
            expect(result.isError, name).toBe(true);
            expect(result.data, name).toMatchObject({ outcome: 'refused', code: 'insufficient_scope' });
        }
    });
});

describe('list_tasks', () => {
    const tasks = [
        taskRow(JOB_A, { status: 'running' }),
        taskRow(FOLLOW_A, { status: 'succeeded', needsAnswer: true }),
        taskRow('44444444-4444-4444-8444-444444444444', { status: 'stopped' }),
        taskRow('55555555-5555-4555-8555-555555555555', { status: 'failed' }),
        taskRow('66666666-6666-4666-8666-666666666666', { status: 'dead' }),
    ];

    it('maps each head run to the shared status vocabulary and keeps the board facts', async () => {
        const url = await boot({ a: { tasks }, b: { tasks: [taskRow(JOB_B)] } });
        const { data } = await call(url, 'alice', 'list_tasks', { limit: 50 });
        expect(data.tasks.map((t: { state: string }) => t.state)).toEqual(['running', 'needs_attention']);
        expect(data.tasks[0]).toMatchObject({ id: JOB_A, headRunId: JOB_A, repo: 'acme/web', author: 'alice' });
        expect(data.counts).toEqual({ running: 1, review: 2, past: 3 });
        const bob = await call(url, 'bob', 'list_tasks');
        expect(bob.data.tasks.map((t: { id: string }) => t.id)).toEqual([JOB_B]);
    });

    it('pages with the board cursor until it is null, across every state', async () => {
        const url = await boot({ a: { tasks } });
        const states: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 10; guard += 1) {
            const { data } = await call(url, 'alice', 'list_tasks', cursor ? { cursor } : {});
            states.push(...data.tasks.map((t: { state: string }) => t.state));
            if (data.nextCursor === null) break;
            cursor = data.nextCursor;
        }
        expect(states).toEqual(['running', 'needs_attention', 'cancelled', 'failed', 'failed']);
    });

    it('forwards every selector and refuses what the board refuses', async () => {
        const filters: TaskListFilters[] = [];
        const url = await boot({ a: { tasks, filters } });
        await call(url, 'alice', 'list_tasks', {
            state: 'review',
            q: 'login',
            author: 'Alice',
            repo: 'acme/web',
            sort: 'oldest',
            limit: 7,
        });
        expect(filters[0]).toMatchObject({
            state: 'review',
            q: 'login',
            author: 'alice',
            repo: 'acme/web',
            sort: 'oldest',
            limit: 7,
        });
        const bad = await call(url, 'alice', 'list_tasks', { repo: 'not a repo' });
        expect(bad).toMatchObject({ isError: true });
        expect(bad.data).toMatchObject({ outcome: 'refused', code: 'BAD_REPO' });
    });

    it('is inconclusive, never an empty list, when the board cannot answer', async () => {
        const { isError, data } = await call(await boot({ a: { tasksFail: true } }), 'alice', 'list_tasks');
        expect(isError).toBe(true);
        expect(data).toMatchObject({ outcome: 'inconclusive' });
    });
});

describe('list_jobs', () => {
    const jobs = [
        run(JOB_A, { status: 'queued' }),
        run(FOLLOW_A, { status: 'running' }),
        run('44444444-4444-4444-8444-444444444444', { status: 'stopped' }),
    ];

    it('lists runs with the shared state vocabulary, bounded by limit, and forwards status and repo', async () => {
        const listQueries: { status?: string; repo?: string; limit: number }[] = [];
        const url = await boot({ a: { jobs, listQueries }, b: { jobs: [run(JOB_B)] } });
        const { data } = await call(url, 'alice', 'list_jobs', { status: 'terminal', repo: 'acme/web', limit: 2 });
        expect(listQueries[0]).toEqual({ status: 'terminal', repo: 'acme/web', limit: 2 });
        expect(data.jobs.map((j: { state: string }) => j.state)).toEqual(['pending', 'running']);
        expect(data.jobs[0]).not.toHaveProperty('output');
        const bob = await call(url, 'bob', 'list_jobs');
        expect(bob.data.jobs.map((j: { id: string }) => j.id)).toEqual([JOB_B]);
    });

    it('is inconclusive when the board answers a status it does not define', async () => {
        const url = await boot({ a: { jobs: [run(JOB_A, { status: 'melting' })] } });
        const { isError, data } = await call(url, 'alice', 'list_jobs');
        expect(isError).toBe(true);
        expect(data).toMatchObject({ outcome: 'inconclusive' });
    });

    it('refuses a status the board does not know', async () => {
        const { data } = await call(await boot({ a: { jobs } }), 'alice', 'list_jobs', { status: 'melting' });
        expect(data).toMatchObject({ outcome: 'refused' });
    });
});

describe('investigate_job and list_questions', () => {
    const thread = [
        run(JOB_A, { status: 'failed', failureKind: 'gate', questions: [question('q1', { status: 'answered' })] }),
        run(FOLLOW_A, {
            rootJobId: JOB_A,
            followUpTo: JOB_A,
            status: 'running',
            questions: [question('q2'), question('q3', { status: 'expired', answerable: false })],
        }),
    ];

    it('returns the run and its thread, oldest first, with a pending question as needs_attention', async () => {
        const url = await boot({ a: { thread }, b: { thread: [run(JOB_B, { rootJobId: JOB_B })] } });
        const { data } = await call(url, 'alice', 'investigate_job', { jobId: FOLLOW_A });
        expect(data.job).toMatchObject({ id: FOLLOW_A, state: 'needs_attention', status: 'running' });
        expect(data.thread.map((j: { id: string; state: string }) => [j.id, j.state])).toEqual([
            [JOB_A, 'failed'],
            [FOLLOW_A, 'needs_attention'],
        ]);
    });

    it('surfaces a durable integration requirement as needs_attention', async () => {
        const requirement = {
            provider: 'jira',
            label: 'Jira',
            reason: 'missing',
            source: 'runtime',
            connectionId: null,
            target: null,
            createdAt: '2026-01-01T00:02:00.000Z',
        };
        const waiting = [run(JOB_A, { status: 'running', integrationRequirements: [requirement] })];
        const { data } = await call(await boot({ a: { thread: waiting } }), 'alice', 'investigate_job', {
            jobId: JOB_A,
        });
        expect(data.job).toMatchObject({ state: 'needs_attention' });
        expect(data.job.integrationRequirements).toEqual([
            { provider: 'jira', label: 'Jira', reason: 'missing', source: 'runtime' },
        ]);
    });

    it('shows an open integration requirement on the head run only, not on the finished runs before it', async () => {
        const requirement = {
            provider: 'jira',
            label: 'Jira',
            reason: 'missing',
            source: 'runtime',
            connectionId: null,
            target: null,
            createdAt: '2026-01-01T00:02:00.000Z',
        };
        const both = [
            run(JOB_A, { status: 'failed', integrationRequirements: [requirement] }),
            run(FOLLOW_A, {
                rootJobId: JOB_A,
                status: 'running',
                followUpTo: JOB_A,
                integrationRequirements: [requirement],
            }),
        ];
        const url = await boot({ a: { thread: both } });
        const head = await call(url, 'alice', 'investigate_job', { jobId: FOLLOW_A });
        expect(head.data.thread.map((j: { id: string; state: string }) => [j.id, j.state])).toEqual([
            [JOB_A, 'failed'],
            [FOLLOW_A, 'needs_attention'],
        ]);
        const older = await call(url, 'alice', 'investigate_job', { jobId: JOB_A });
        expect(older.data.job).toMatchObject({ id: JOB_A, state: 'failed', integrationRequirements: [] });
    });

    it("does not reveal another org's job, and says not found for an unknown one", async () => {
        const url = await boot({ a: { thread }, b: { thread: [run(JOB_B, { rootJobId: JOB_B })] } });
        for (const tool of ['investigate_job', 'list_questions']) {
            const { isError, data } = await call(url, 'alice', tool, { jobId: JOB_B });
            expect(isError, tool).toBe(true);
            expect(data, tool).toMatchObject({ outcome: 'refused', status: 404 });
        }
    });

    it('is inconclusive when the thread cannot be read, never a run alone', async () => {
        const url = await boot({ a: { thread, threadFails: true, jobs: thread } });
        const { isError, data } = await call(url, 'alice', 'investigate_job', { jobId: JOB_A });
        expect(isError).toBe(true);
        expect(data).toMatchObject({ outcome: 'inconclusive' });
    });

    it('bounds a long run output and says it was cut', async () => {
        const long = [run(JOB_A, { output: 'x'.repeat(50_000) })];
        const { data } = await call(await boot({ a: { thread: long } }), 'alice', 'investigate_job', {
            jobId: JOB_A,
        });
        expect(data.job.output.length).toBeLessThan(10_000);
        expect(data.job.outputTruncated).toBe(true);
    });

    it('lists the thread questions in the order answer_question expects, with prompts and options', async () => {
        const { data } = await call(await boot({ a: { thread } }), 'alice', 'list_questions', { jobId: JOB_A });
        expect(data.questions.map((q: { id: string; jobId: string }) => [q.jobId, q.id])).toEqual([
            [JOB_A, 'q1'],
            [FOLLOW_A, 'q2'],
            [FOLLOW_A, 'q3'],
        ]);
        expect(data.questions[1]).toMatchObject({
            status: 'pending',
            answerable: true,
            prompts: [
                {
                    question: 'Which db?',
                    header: 'Pick',
                    multiSelect: false,
                    options: [{ label: 'pg' }, { label: 'sqlite' }],
                },
            ],
        });
    });
});

describe('list_job_streams and read_job_log', () => {
    const board = (streams: Parameters<typeof fakeArtifacts>[0]): Board & { reads: string[] } => {
        const { store, reads } = fakeArtifacts(streams);
        return { jobs: [run(JOB_A)], artifacts: store, reads };
    };

    it('lists the streams of the run with their state, filtered and paged', async () => {
        const a = board([
            stream({ claimSeq: 2, session: 'sess-b' }, ['d1\n']),
            stream({ claimSeq: 1, session: 'sess-a' }, ['a1\n'], manifest('truncated', 'stream_cap')),
            stream({ claimSeq: 1, session: 'sess-a', stream: 'log' }, ['l\n'], null),
        ]);
        const url = await boot({ a });
        const all = await call(url, 'alice', 'list_job_streams', { jobId: JOB_A });
        expect(all.data.streams.map((s: { attempt: number; stream: string }) => [s.attempt, s.stream])).toEqual([
            [1, 'log'],
            [1, 'transcript'],
            [2, 'transcript'],
        ]);
        expect(all.data.streams.find((s: { stream: string }) => s.stream === 'log')).toMatchObject({
            state: 'partial',
            terminalCause: 'not_finalized',
        });
        const paged: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 10; guard += 1) {
            const { data } = await call(url, 'alice', 'list_job_streams', {
                jobId: JOB_A,
                limit: 1,
                ...(cursor ? { cursor } : {}),
            });
            paged.push(...data.streams.map((s: { attempt: number; stream: string }) => `${s.attempt}/${s.stream}`));
            if (data.cursor === null) break;
            cursor = data.cursor;
        }
        expect(paged).toEqual(['1/log', '1/transcript', '2/transcript']);
        const only = await call(url, 'alice', 'list_job_streams', { jobId: JOB_A, attempt: 2 });
        expect(only.data.streams).toHaveLength(1);
    });

    it('reads the log in pages of at most limitBytes, and the cursor round-trips to the end', async () => {
        const lines = Array.from({ length: 9 }, (_, i) => `line ${i}\n`);
        const url = await boot({ a: board([stream({}, lines)]) });
        let text = '';
        let pages = 0;
        let cursor: string | undefined;
        for (let guard = 0; guard < 50; guard += 1) {
            const { data } = await call(url, 'alice', 'read_job_log', {
                jobId: JOB_A,
                limitBytes: 20,
                ...(cursor ? { cursor } : {}),
            });
            pages += 1;
            const got = data.segments.map((s: { text: string }) => s.text).join('');
            expect(Buffer.byteLength(got)).toBeLessThanOrEqual(20);
            text += got;
            if (data.cursor === null) break;
            cursor = data.cursor;
        }
        expect(text).toBe(lines.join(''));
        expect(pages).toBeGreaterThan(2);
    });

    it('cuts one oversized chunk to the cap and still reaches every byte through the cursor', async () => {
        const big = `${'é'.repeat(5000)}END`;
        const url = await boot({ a: board([stream({}, [big, 'tail\n'])]) });
        let text = '';
        let cursor: string | undefined;
        let truncated = 0;
        for (let guard = 0; guard < 100; guard += 1) {
            const { data } = await call(url, 'alice', 'read_job_log', {
                jobId: JOB_A,
                limitBytes: 1024,
                ...(cursor ? { cursor } : {}),
            });
            const got = data.segments.map((s: { text: string }) => s.text).join('');
            expect(Buffer.byteLength(got)).toBeLessThanOrEqual(1024);
            if (data.truncated) truncated += 1;
            text += got;
            if (data.cursor === null) break;
            cursor = data.cursor;
        }
        expect(truncated).toBeGreaterThan(0);
        expect(text).toBe(`${big}tail\n`);
    });

    type Seg = { text: string | null; offset: number; length: number; state: string };
    type LogPage = { segments: Seg[]; cursor: string | null; truncated: boolean };
    const readPages = async (
        url: URL,
        limitBytes: number,
        between: (page: number) => void = () => {}
    ): Promise<LogPage[]> => {
        const pages: LogPage[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 500; guard += 1) {
            const { data } = await call(url, 'alice', 'read_job_log', {
                jobId: JOB_A,
                limitBytes,
                ...(cursor ? { cursor } : {}),
            });
            pages.push(data as LogPage);
            if (data.cursor === null) break;
            cursor = data.cursor;
            between(pages.length);
        }
        return pages;
    };
    const textOf = (pages: LogPage[]) => pages.flatMap((p) => p.segments.map((s) => s.text ?? '')).join('');

    it('cuts on a character boundary for 3- and 4-byte characters and an odd cap, with offsets that chain', async () => {
        const big = `${'€'.repeat(2000)}${'😀'.repeat(500)}END`;
        const url = await boot({ a: board([stream({}, [big])]) });
        const pages = await readPages(url, 1000);
        const cut = pages.flatMap((p) => p.segments);
        expect(pages.length).toBeGreaterThan(4);
        for (const segment of cut) {
            expect(segment.text).not.toContain('�');
            expect(Buffer.byteLength(segment.text ?? '')).toBe(segment.length);
            expect(segment.length).toBeLessThanOrEqual(1000);
        }
        for (let i = 1; i < cut.length; i += 1) {
            expect(cut[i]!.offset).toBe(cut[i - 1]!.offset + cut[i - 1]!.length);
        }
        expect(textOf(pages)).toBe(big);
    });

    it('keeps reading the chunk it cut when a stream that sorts earlier appears between two pages', async () => {
        const big = `${'€'.repeat(1500)}END`;
        const streams = [stream({ session: 'sess-b' }, [big])];
        const url = await boot({ a: board(streams) });
        const pages = await readPages(url, 1000, (n) => {
            if (n === 1) streams.push(stream({ session: 'sess-a', stream: 'log' }, ['newcomer '.repeat(200)]));
        });
        expect(textOf(pages)).toBe(big);
    });

    it('accepts the cursor it issued for a cut chunk of a stream with very long coordinates', async () => {
        const big = `${'€'.repeat(1500)}END`;
        const session = `s${'x'.repeat(250)}`;
        const url = await boot({ a: board([stream({ session, executor: `e${'y'.repeat(150)}` }, [big])]) });
        const pages = await readPages(url, 1000);
        expect(pages.length).toBeGreaterThan(2);
        expect(textOf(pages)).toBe(big);
    });

    it('does not repeat deleted chunks that sit ahead of the chunk it cut', async () => {
        const big = `${'€'.repeat(1500)}END`;
        const s = stream({}, ['gone\n', big]);
        s.chunks[0]!.deleted = true;
        const url = await boot({ a: board([s]) });
        const pages = await readPages(url, 1000);
        const deleted = pages.flatMap((p) => p.segments).filter((x) => x.state === 'deleted');
        expect(deleted).toHaveLength(1);
        expect(textOf(pages)).toBe(big);
    });

    it('is inconclusive, not a skip into the next chunk, when the chunk it cut vanishes between pages', async () => {
        for (const vanish of ['unindexed', 'object_missing'] as const) {
            const big = `${'€'.repeat(1500)}END`;
            const s = stream({}, [big, 'next chunk\n']);
            const url = await boot({ a: board([s]) });
            const first = await call(url, 'alice', 'read_job_log', { jobId: JOB_A, limitBytes: 1000 });
            expect(first.data.truncated).toBe(true);
            if (vanish === 'unindexed') s.chunks.shift();
            else s.chunks[0]!.deleted = true;
            const second = await call(url, 'alice', 'read_job_log', {
                jobId: JOB_A,
                limitBytes: 1000,
                cursor: first.data.cursor,
            });
            expect(second.data, vanish).toMatchObject({ outcome: 'inconclusive' });
            expect(JSON.stringify(second.data), vanish).not.toContain('next chunk');
        }
    });

    it('ends a page at a chunk boundary and goes on when the board overfills it', async () => {
        const first = 'x'.repeat(10);
        const second = 'y'.repeat(30);
        const s = stream({}, [first, second]);
        s.chunks.forEach((c) => {
            c.reportedLength = 1;
        });
        const url = await boot({ a: board([s]) });
        const pages = await readPages(url, 20);
        expect(pages.length).toBeGreaterThan(1);
        for (const page of pages) {
            expect(Buffer.byteLength(textOf([page]))).toBeLessThanOrEqual(20);
        }
        expect(textOf(pages)).toBe(first + second);
    });

    it('applies a small default and refuses a limit above the hard cap', async () => {
        const url = await boot({ a: board([stream({}, ['a\n'])]) });
        const ok = await call(url, 'alice', 'read_job_log', { jobId: JOB_A });
        expect(ok.data.segments[0].text).toBe('a\n');
        const over = await call(url, 'alice', 'read_job_log', { jobId: JOB_A, limitBytes: 100_000_000 });
        expect(over.isError).toBe(true);
    });

    it('marks a log that is not finalized, truncated or missing as incomplete, never a clean read', async () => {
        const url = await boot({
            a: board([
                stream({ session: 'ok' }, ['fine\n']),
                stream({ session: 'cut' }, ['x\n'], manifest('truncated', 'stream_cap')),
            ]),
        });
        const { data } = await call(url, 'alice', 'read_job_log', { jobId: JOB_A });
        expect(data.cursor).toBeNull();
        expect(data.complete).toBe(false);
        const clean = await boot({ a: board([stream({}, ['fine\n'])]) });
        expect((await call(clean, 'alice', 'read_job_log', { jobId: JOB_A })).data.complete).toBe(true);
    });

    it('rejects a cursor it did not issue', async () => {
        const url = await boot({ a: board([stream({}, ['a\n'])]) });
        const { isError, data } = await call(url, 'alice', 'read_job_log', { jobId: JOB_A, cursor: 'garbage' });
        expect(isError).toBe(true);
        expect(data).toMatchObject({ outcome: 'refused' });
    });

    it("never reads another org's bytes", async () => {
        const mine = board([]);
        const theirs = { ...board([stream({}, ['other tenant secret\n'])]), jobs: [run(JOB_B)] };
        const url = await boot({ a: mine, b: theirs });
        const { isError, data } = await call(url, 'alice', 'read_job_log', { jobId: JOB_B });
        expect(isError).toBe(true);
        expect(data).toMatchObject({ outcome: 'refused', status: 404 });
        expect(theirs.reads).toEqual([]);
        expect(mine.reads).toEqual([]);
    });
});

const requirement = {
    provider: 'jira',
    label: 'Jira',
    reason: 'reconnect',
    source: 'runtime',
    connectionId: null,
    target: null,
    createdAt: '2026-01-01T00:02:00.000Z',
};

describe('get_task', () => {
    const thread = [
        run(JOB_A, {
            status: 'failed',
            attachments: [
                {
                    id: 'att-1',
                    name: 'spec.md',
                    mediaType: 'text/markdown',
                    size: 12,
                    sha256: 'ab'.repeat(32),
                    state: 'bound',
                    url: 'https://files.example/signed?sig=secret',
                    content: 'raw bytes',
                },
            ],
        }),
        run(FOLLOW_A, {
            followUpTo: JOB_A,
            status: 'running',
            doneAt: null,
            baseBranch: 'main',
            publication: {
                prUrl: 'https://git.example/acme/web/pull/7',
                prNumber: 7,
                headBranch: 'agent/x',
                baseBranch: 'main',
            },
            integrationRequirements: [requirement],
            questions: [question('q1')],
        }),
    ];

    it('describes the task from any of its runs: head run, runs, pull request, attention, attachment metadata only', async () => {
        const url = await boot({ a: { thread }, b: { thread: [run(JOB_B, { rootJobId: JOB_B })] } });
        for (const id of [JOB_A, FOLLOW_A]) {
            const { data } = await call(url, 'alice', 'get_task', { taskId: id });
            expect(data).toMatchObject({
                taskId: JOB_A,
                headRunId: FOLLOW_A,
                status: 'running',
                state: 'needs_attention',
                repo: 'acme/web',
                baseBranch: 'main',
                author: 'alice',
                pullRequest: { url: 'https://git.example/acme/web/pull/7', number: 7, headBranch: 'agent/x' },
                markedDone: false,
                openQuestions: 1,
                integrationRequirements: [{ provider: 'jira', label: 'Jira', reason: 'reconnect', source: 'runtime' }],
            });
            expect(data.runs.map((r: { id: string; state: string }) => [r.id, r.state])).toEqual([
                [JOB_A, 'failed'],
                [FOLLOW_A, 'needs_attention'],
            ]);
            expect(data.attachments).toEqual([
                {
                    id: 'att-1',
                    runId: JOB_A,
                    name: 'spec.md',
                    mediaType: 'text/markdown',
                    size: 12,
                    sha256: 'ab'.repeat(32),
                    state: 'bound',
                },
            ]);
            expect(JSON.stringify(data)).not.toMatch(/secret|raw bytes/);
        }
    });

    it("does not reveal another org's task, and says not found for an unknown one", async () => {
        const url = await boot({ a: { thread }, b: { thread: [run(JOB_B, { rootJobId: JOB_B })] } });
        for (const id of [JOB_B, '99999999-9999-4999-8999-999999999999']) {
            const { isError, data } = await call(url, 'alice', 'get_task', { taskId: id });
            expect(isError).toBe(true);
            expect(data).toMatchObject({ outcome: 'refused', status: 404 });
        }
    });

    it('is inconclusive when the thread cannot be read', async () => {
        const { isError, data } = await call(await boot({ a: { thread, threadFails: true } }), 'alice', 'get_task', {
            taskId: JOB_A,
        });
        expect(isError).toBe(true);
        expect(data).toMatchObject({ outcome: 'inconclusive' });
    });

    it('bounds a long command and says it was cut', async () => {
        const long = [run(JOB_A, { command: 'x'.repeat(50_000) })];
        const { data } = await call(await boot({ a: { thread: long } }), 'alice', 'get_task', { taskId: JOB_A });
        expect(data.command.length).toBeLessThan(2500);
        expect(data.commandTruncated).toBe(true);
    });
});

describe('get_task_result', () => {
    const result = async (head: Record<string, unknown>, before: ReturnType<typeof run>[] = []) => {
        const thread = [...before, run(JOB_A, head)];
        const { data, isError } = await call(await boot({ a: { thread } }), 'alice', 'get_task_result', {
            taskId: JOB_A,
        });
        return { data, isError };
    };

    it.each([
        ['queued', 'pending', 'in_progress'],
        ['running', 'running', 'in_progress'],
        ['succeeded', 'succeeded', 'final'],
        ['failed', 'failed', 'final'],
        ['dead', 'failed', 'final'],
        ['stopped', 'cancelled', 'final'],
        ['melting', 'inconclusive', 'inconclusive'],
    ])('maps the board status %s to %s (%s)', async (status, state, outcome) => {
        const { data, isError } = await result({ status });
        expect(isError).toBeFalsy();
        expect(data).toMatchObject({ taskId: JOB_A, runId: JOB_A, status, state, outcome });
    });

    it('maps an open question or integration requirement to needs_attention, except on a stopped run', async () => {
        const asked = { questions: [question('q1')] };
        const waiting = { integrationRequirements: [requirement] };
        for (const status of ['running', 'failed']) {
            const q = await result({ status, ...asked });
            expect(q.data).toMatchObject({ state: 'needs_attention', outcome: 'needs_attention' });
            expect(q.data.attention).toEqual({ openQuestions: 1, integrationRequirements: [] });
            const i = await result({ status, ...waiting });
            expect(i.data).toMatchObject({ state: 'needs_attention' });
            expect(i.data.attention.integrationRequirements).toEqual([
                { provider: 'jira', label: 'Jira', reason: 'reconnect', source: 'runtime' },
            ]);
        }
        const stopped = await result({ status: 'stopped', ...asked, ...waiting });
        expect(stopped.data).toMatchObject({ state: 'cancelled', outcome: 'final' });
        expect(stopped.data).not.toHaveProperty('attention');
    });

    it('a settled question does not hold the task for attention', async () => {
        const { data } = await result({ questions: [question('q1', { status: 'answered', answerable: false })] });
        expect(data).toMatchObject({ state: 'succeeded' });
    });

    it('reports verified pull request, checks and summary of a successful head run', async () => {
        const { data } = await result({
            publication: {
                prUrl: 'https://git.example/acme/web/pull/7',
                prNumber: 7,
                headBranch: 'agent/x',
                baseBranch: 'main',
            },
            gates: [
                { name: 'lint', status: 'passed', exitCode: 0, output: 'long tail' },
                { name: 'test', status: 'passed', exitCode: 0, output: 'long tail' },
            ],
        });
        expect(data).toMatchObject({
            state: 'succeeded',
            summary: 'did the thing',
            pullRequest: {
                url: 'https://git.example/acme/web/pull/7',
                number: 7,
                headBranch: 'agent/x',
                baseBranch: 'main',
            },
            checks: {
                verdict: 'passed',
                gates: [
                    { name: 'lint', status: 'passed', exitCode: 0 },
                    { name: 'test', status: 'passed', exitCode: 0 },
                ],
            },
            updatedAt: '2026-01-01T00:05:00.000Z',
        });
        expect(JSON.stringify(data)).not.toContain('long tail');
        expect(data).not.toHaveProperty('error');
    });

    it('never calls a check that is not known to have passed a pass', async () => {
        const failing = await result({
            gates: [
                { name: 'a', status: 'passed' },
                { name: 'b', status: 'failed', exitCode: 1 },
            ],
        });
        expect(failing.data.checks.verdict).toBe('failed');
        const open = await result({
            gates: [
                { name: 'a', status: 'passed' },
                { name: 'b', status: 'running' },
            ],
        });
        expect(open.data.checks.verdict).toBe('incomplete');
        const none = await result({ gates: null });
        expect(none.data).not.toHaveProperty('checks');
        expect(none.data).not.toHaveProperty('pullRequest');
    });

    it('carries the failure of a failed head run and no summary the board did not record', async () => {
        const { data } = await result({
            status: 'failed',
            exitCode: 2,
            failureKind: 'gate',
            failureCause: 'lint failed',
            summary: null,
        });
        expect(data).toMatchObject({ state: 'failed', error: { kind: 'gate', cause: 'lint failed', exitCode: 2 } });
        expect(data).not.toHaveProperty('summary');
    });

    it('judges the head run of the thread, not an earlier one', async () => {
        const { data } = await result({ id: FOLLOW_A, status: 'running', followUpTo: JOB_A }, [
            run(JOB_A, { status: 'failed', failureKind: 'gate' }),
        ]);
        expect(data).toMatchObject({ taskId: JOB_A, runId: FOLLOW_A, state: 'running' });
        expect(data).not.toHaveProperty('error');
    });

    it('judges a queued retry after a dead run as pending, with no error carried over', async () => {
        const { data } = await result({ id: FOLLOW_A, status: 'queued', followUpTo: JOB_A, summary: null }, [
            run(JOB_A, { status: 'dead', failureKind: 'timeout', exitCode: 137 }),
        ]);
        expect(data).toMatchObject({ runId: FOLLOW_A, state: 'pending', outcome: 'in_progress' });
        expect(data).not.toHaveProperty('error');
    });

    it('judges a workflow successor as the head of the thread', async () => {
        const { data } = await result({ id: FOLLOW_A, status: 'running', mode: 'workflow', followUpTo: JOB_A }, [
            run(JOB_A, { status: 'succeeded' }),
        ]);
        expect(data).toMatchObject({ runId: FOLLOW_A, state: 'running' });
    });

    it('dates a task waiting on a question by the question, not the older run start', async () => {
        const { data } = await result({
            status: 'running',
            finishedAt: null,
            questions: [question('q1', { askedAt: '2026-01-01T00:09:00.000Z' })],
        });
        expect(data.updatedAt).toBe('2026-01-01T00:09:00.000Z');
    });

    it("does not reveal another org's task", async () => {
        const url = await boot({ a: { thread: [run(JOB_A)] }, b: { thread: [run(JOB_B, { rootJobId: JOB_B })] } });
        const { isError, data } = await call(url, 'alice', 'get_task_result', { taskId: JOB_B });
        expect(isError).toBe(true);
        expect(data).toMatchObject({ outcome: 'refused', status: 404 });
    });

    it('is inconclusive, never a negative verdict, when the board cannot answer or answers garbage', async () => {
        const down = await call(
            await boot({ a: { thread: [run(JOB_A)], threadFails: true } }),
            'alice',
            'get_task_result',
            {
                taskId: JOB_A,
            }
        );
        expect(down.isError).toBe(true);
        expect(down.data).toMatchObject({ outcome: 'inconclusive' });
        expect(down.data).not.toHaveProperty('state');
        const garbled = await call(
            await boot({ a: { thread: [{ id: JOB_A, status: 42 }] as never } }),
            'alice',
            'get_task_result',
            { taskId: JOB_A }
        );
        expect(garbled.isError).toBe(true);
        expect(garbled.data).toMatchObject({ outcome: 'inconclusive' });
    });
});
