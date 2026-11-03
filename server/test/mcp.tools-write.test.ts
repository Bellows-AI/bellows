import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { McpCaller, OAuthStore } from '../src/auth/oauth-store.js';
import { hashToken } from '../src/auth/session.js';
import { staticRepoSource } from '../src/github/repo-source.js';
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
 * The task write tools through the real auth plugin and bridge, driven by a v2 client over `POST /api/mcp`, on a
 * recording board fake. `server/test-db/mcp.tools-write.test.ts` runs them over real stores.
 */

const track = trackApps();
const LOCALHOST = '127.0.0.1';
const MODERN = '2026-07-28';
const TOKENS = {
    reader: 'mat_write-reader-token-0123456789',
    writer: 'mat_write-writer-token-0123456789',
    both: 'mat_write-both-token-0123456789',
} as const;
type Who = keyof typeof TOKENS;

const JOB = '11111111-1111-4111-8111-111111111111';
const NEW_JOB = '22222222-2222-4222-8222-222222222222';
const ATTACHMENT = '33333333-3333-4333-8333-333333333333';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const COMMAND_LIMIT = 16_384;

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

interface Recorded {
    op: string;
    args: unknown[];
}

interface Board {
    calls: Recorded[];
    stop?: unknown;
    remove?: unknown;
    done?: unknown;
    prompts?: unknown[];
}

const PROMPTS = [
    { question: 'Which db?', header: 'Pick', multiSelect: false, options: [{ label: 'pg' }, { label: 'sqlite' }] },
    { question: 'Which port?', header: 'Port', multiSelect: false, options: [{ label: '80' }, { label: '8080' }] },
];
const QUESTION = {
    id: 'toolu_1',
    attempt: 1,
    questions: PROMPTS,
    status: 'pending',
    answerable: true,
    answers: null,
    answeredBy: null,
    askedAt: '2026-01-01T00:01:00.000Z',
    answeredAt: null,
};
const RUN = {
    id: JOB,
    rootJobId: JOB,
    command: 'task',
    status: 'running',
    repo: 'acme/web',
    executor: null,
    mode: 'objective',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: null,
    exitCode: null,
    failureKind: null,
    failureCause: null,
    summary: null,
    output: null,
    gates: null,
    waitReason: null,
    publication: null,
    author: { login: 'writer' },
    questions: [QUESTION],
    integrationRequirements: [],
};

const storeOf = (board: Board) => {
    const record =
        (op: string, result: (...args: never[]) => unknown) =>
        async (...args: unknown[]) => {
            board.calls.push({ op, args });
            return result(...(args as never[]));
        };
    return jobStoreSlice({
        create: record('create', () => ({ id: NEW_JOB })),
        createFollowUp: record('createFollowUp', () => ({ id: NEW_JOB })),
        createRetry: record('createRetry', () => ({ id: NEW_JOB })),
        editCommand: record('editCommand', (_id: string, command: string) => ({ result: 'edited', command })),
        markDone: record('markDone', () => board.done ?? { status: 'succeeded', doneAt: '2026-01-02T00:00:00.000Z' }),
        stop: record('stop', () => board.stop ?? { result: 'stopped' }),
        removeThread: record('removeThread', () => board.remove ?? 'removed'),
        reopen: record('reopen', () => 'reopened'),
        thread: async () => [{ ...RUN, questions: [{ ...QUESTION, questions: board.prompts ?? PROMPTS }] }],
        answerQuestion: record('answerQuestion', () => ({
            result: 'ok',
            question: { ...QUESTION, status: 'answered', answers: { 'Which db?': 'pg', 'Which port?': '8080' } },
        })),
    });
};

async function boot(board: Board) {
    const port = await freePort();
    const publicUrl = `http://${LOCALHOST}:${port}`;
    const resource = `${publicUrl}/api/mcp`;
    const auth = memoryAuthStore();
    const people = {
        reader: auth.seedMember('org-a', 'reader', 'member'),
        writer: auth.seedMember('org-a', 'writer', 'member'),
        both: auth.seedMember('org-a', 'both', 'member'),
    };
    const scopes: Record<Who, McpCaller['scopes']> = {
        reader: ['factory:read'],
        writer: ['factory:write'],
        both: ['factory:read', 'factory:write'],
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
    const orgs = staticRegistry({
        config,
        telemetry: stubTelemetryClient(),
        repos: staticRepoSource([{ owner: 'acme', name: 'web' }]),
        jobs: storeOf(board),
        batches: {
            closeTask: async (...args: unknown[]) => {
                board.calls.push({ op: 'closeTask', args });
                return {
                    batchId: 'b1',
                    task: 'a',
                    outcome: 'cancelled',
                    pr: 'https://example.test/pr/1',
                    doneAt: '2026-01-02T00:00:00.000Z',
                };
            },
        } as unknown as NonNullable<Parameters<typeof staticRegistry>[0]>['batches'],
    });
    const app = track(await buildApp({ config, orgs, store: telemetryStoreStub(), auth, oauth: oauth as OAuthStore }));
    await app.listen({ port, host: LOCALHOST });
    return { url: new URL(resource), userOf: (who: Who) => people[who].user.id };
}

const call = async (url: URL, who: Who, name: string, args: Record<string, unknown> = {}) => {
    const client = new Client({ name: 'writes', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(
        new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TOKENS[who]}` } } })
    );
    try {
        const result = await client.callTool({ name, arguments: args });
        // biome-ignore lint/suspicious/noExplicitAny: structured content is asserted field by field below
        return { ...result, data: result.structuredContent as Record<string, any> };
    } finally {
        await client.close();
    }
};

const listed = async (url: URL) => {
    const client = new Client({ name: 'writes', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(
        new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TOKENS.both}` } } })
    );
    try {
        return (await client.listTools()).tools;
    } finally {
        await client.close();
    }
};

/** Every write tool with arguments that would succeed on a permitted caller. */
const WRITE_CALLS: readonly (readonly [string, Record<string, unknown>])[] = [
    ['create_task', { command: 'do it', repo: 'acme/web' }],
    ['follow_up_task', { jobId: JOB, command: 'more' }],
    ['retry_task', { jobId: JOB }],
    ['edit_task', { jobId: JOB, command: 'edited' }],
    ['answer_question', { jobId: JOB, questionId: 'toolu_1', answers: ['pg', '8080'] }],
    ['stop_task', { jobId: JOB, confirm: true }],
    ['mark_task_done', { jobId: JOB }],
    ['force_close_task', { jobId: JOB, confirm: true }],
    ['reopen_task', { jobId: JOB }],
    ['remove_task', { jobId: JOB, confirm: true }],
];

describe('the task write tools', () => {
    it('lists exactly the write tools with the annotations the issue names', async () => {
        const { url } = await boot({ calls: [] });
        const tools = await listed(url);
        const byName = new Map(tools.map((tool) => [tool.name, tool]));
        for (const [name] of WRITE_CALLS) expect(byName.has(name), name).toBe(true);
        for (const name of ['stop_task', 'force_close_task', 'remove_task']) {
            expect(byName.get(name)?.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
            expect(JSON.stringify(byName.get(name)?.inputSchema), name).toContain('confirm');
        }
        expect(byName.get('reopen_task')?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
        for (const name of ['create_task', 'follow_up_task', 'retry_task']) {
            expect(byName.get(name)?.description, name).toMatch(/idempotencyKey/);
            expect(byName.get(name)?.description, name).toMatch(/same key/i);
        }
    });

    it.each(WRITE_CALLS)(
        '%s: a read-scope token is refused insufficient_scope and the board is never touched',
        async (name, args) => {
            const board: Board = { calls: [] };
            const { url } = await boot(board);
            const refused = await call(url, 'reader', name, args);
            expect(refused.isError).toBe(true);
            expect(refused.data).toMatchObject({ outcome: 'refused', code: 'insufficient_scope' });
            expect(board.calls).toEqual([]);
        }
    );

    it('creates a task as the caller, carrying every field and the idempotency key to the board', async () => {
        const board: Board = { calls: [] };
        const { url, userOf } = await boot(board);
        const text = 'line one\n  line two — ünïcødé 日本語 🚀\n';
        const made = await call(url, 'writer', 'create_task', {
            command: text,
            repo: 'acme/web',
            executor: 'fast',
            executorScope: 'org',
            baseBranch: 'release',
            skills: ['gates'],
            connections: [CONNECTION],
            attachmentIds: [ATTACHMENT],
            idempotencyKey: 'key-0123456789',
        });
        expect(made.isError).toBeFalsy();
        expect(made.data).toMatchObject({ id: NEW_JOB, status: 'queued' });
        expect(board.calls).toHaveLength(1);
        const [command, createdBy, options] = board.calls[0]!.args as [string, string, Record<string, unknown>];
        expect(command).toBe(text);
        expect(createdBy).toBe(userOf('writer'));
        expect(options).toMatchObject({
            repo: 'acme/web',
            executor: 'fast',
            executorScope: 'org',
            baseBranch: 'release',
            skills: ['gates'],
            connectionIds: [CONNECTION],
            attachmentIds: [ATTACHMENT],
            idempotency: { key: 'key-0123456789' },
        });
    });

    it('surfaces the board verdict on command text verbatim: empty and over-long are refused, the exact limit is not', async () => {
        const board: Board = { calls: [] };
        const { url } = await boot(board);
        for (const command of ['', '   \n\t ', 'x'.repeat(COMMAND_LIMIT + 1)]) {
            const refused = await call(url, 'writer', 'create_task', { command, repo: 'acme/web' });
            expect(refused.isError, command.slice(0, 8)).toBe(true);
            expect(refused.data).toMatchObject({ outcome: 'refused', code: 'BAD_COMMAND', status: 400 });
        }
        expect(board.calls).toEqual([]);
        const atLimit = await call(url, 'writer', 'create_task', {
            command: 'x'.repeat(COMMAND_LIMIT),
            repo: 'acme/web',
        });
        expect(atLimit.isError).toBeFalsy();
        const edited = await call(url, 'writer', 'edit_task', { jobId: JOB, command: ' ' });
        expect(edited.data).toMatchObject({ outcome: 'refused', code: 'BAD_COMMAND' });
    });

    it('refuses a malformed idempotency key with the board code, before any store call', async () => {
        const board: Board = { calls: [] };
        const { url } = await boot(board);
        const refused = await call(url, 'writer', 'create_task', {
            command: 'x',
            repo: 'acme/web',
            idempotencyKey: 'short',
        });
        expect(refused.data).toMatchObject({ outcome: 'refused', code: 'BAD_IDEMPOTENCY_KEY', status: 400 });
        expect(board.calls).toEqual([]);
    });

    it('follows up, retries and edits with the task id and the key, and answers with the new task', async () => {
        const board: Board = { calls: [] };
        const { url } = await boot(board);
        const followed = await call(url, 'writer', 'follow_up_task', {
            jobId: JOB,
            command: 'more\nplease',
            attachmentIds: [ATTACHMENT],
            idempotencyKey: 'follow-0123456',
        });
        expect(followed.data).toMatchObject({ id: NEW_JOB, status: 'queued' });
        const retried = await call(url, 'writer', 'retry_task', { jobId: JOB, idempotencyKey: 'retry-01234567' });
        expect(retried.data).toMatchObject({ id: NEW_JOB, status: 'queued' });
        const edited = await call(url, 'writer', 'edit_task', { jobId: JOB, command: 'new text' });
        expect(edited.data).toMatchObject({ id: JOB, status: 'queued', command: 'new text' });
        const [follow, retry] = board.calls;
        expect(follow?.args.slice(0, 2)).toEqual([JOB, 'more\nplease']);
        expect(follow?.args[3]).toMatchObject({ key: 'follow-0123456' });
        expect(follow?.args[6]).toEqual([ATTACHMENT]);
        expect(retry?.args[0]).toBe(JOB);
        expect(retry?.args[2]).toMatchObject({ key: 'retry-01234567' });
    });

    it('marks done, reopens, stops and removes, each with its board answer', async () => {
        const board: Board = { calls: [] };
        const { url } = await boot(board);
        expect((await call(url, 'writer', 'mark_task_done', { jobId: JOB })).data).toMatchObject({
            id: JOB,
            status: 'succeeded',
            doneAt: '2026-01-02T00:00:00.000Z',
        });
        expect((await call(url, 'writer', 'reopen_task', { jobId: JOB })).data).toEqual({ id: JOB, reopened: true });
        expect((await call(url, 'writer', 'stop_task', { jobId: JOB, confirm: true })).data).toMatchObject({
            id: JOB,
            status: 'stopped',
        });
        expect((await call(url, 'writer', 'remove_task', { jobId: JOB, confirm: true })).data).toEqual({
            id: JOB,
            removed: true,
        });
    });

    it.each(['stop_task', 'force_close_task', 'remove_task'])(
        '%s: without confirm:true it is refused confirmation_required and nothing reaches the board',
        async (name) => {
            const board: Board = { calls: [] };
            const { url } = await boot(board);
            for (const args of [{ jobId: JOB }, { jobId: JOB, confirm: false }]) {
                const refused = await call(url, 'writer', name, args);
                expect(refused.isError).toBe(true);
                expect(refused.data).toMatchObject({ outcome: 'refused', code: 'confirmation_required' });
            }
            expect(board.calls).toEqual([]);
        }
    );

    it('on a live batch thread mark_task_done is refused as the board refuses it, and force_close_task closes the batch task', async () => {
        const board: Board = { calls: [], done: 'batch' };
        const { url } = await boot(board);
        const plain = await call(url, 'writer', 'mark_task_done', { jobId: JOB });
        expect(plain.isError).toBe(true);
        expect(plain.data).toMatchObject({ outcome: 'refused', code: 'BATCH_TASK_THREAD', status: 409 });
        expect(plain.data.message).toMatch(/live batch/);
        expect(board.calls.map((c) => c.op)).toEqual(['markDone']);
        const forced = await call(url, 'writer', 'force_close_task', { jobId: JOB, confirm: true });
        expect(forced.isError).toBeFalsy();
        expect(forced.data).toMatchObject({ id: JOB, batch: 'b1', task: 'a', outcome: 'cancelled' });
        expect(forced.data.pr).toBe('https://example.test/pr/1');
        expect(board.calls.map((c) => c.op)).toEqual(['markDone', 'markDone', 'closeTask']);
    });

    it('surfaces board refusals verbatim: a stop on a finished task, a remove on a running one', async () => {
        const board: Board = { calls: [], stop: { result: 'conflict', status: 'succeeded' }, remove: 'conflict' };
        const { url } = await boot(board);
        const stop = await call(url, 'writer', 'stop_task', { jobId: JOB, confirm: true });
        expect(stop.isError).toBe(true);
        expect(stop.data).toMatchObject({ outcome: 'refused', code: 'NOT_STOPPABLE', status: 409 });
        const remove = await call(url, 'writer', 'remove_task', { jobId: JOB, confirm: true });
        expect(remove.data).toMatchObject({ outcome: 'refused', code: 'TASK_RUNNING', status: 409 });
    });

    it('answers a question by prompt order, naming each prompt for the board', async () => {
        const board: Board = { calls: [] };
        const { url } = await boot(board);
        const answered = await call(url, 'both', 'answer_question', {
            jobId: JOB,
            questionId: 'toolu_1',
            answers: ['pg', '8080'],
        });
        expect(answered.isError).toBeFalsy();
        expect(answered.data).toMatchObject({ id: 'toolu_1', status: 'answered' });
        expect(board.calls).toHaveLength(1);
        expect(board.calls[0]?.args.slice(0, 3)).toEqual([
            JOB,
            'toolu_1',
            { 'Which db?': 'pg', 'Which port?': '8080' },
        ]);
    });

    it('refuses an answer list that does not match the prompts, or a question that is not on the task, before the board is asked', async () => {
        const board: Board = { calls: [] };
        const { url } = await boot(board);
        const short = await call(url, 'both', 'answer_question', {
            jobId: JOB,
            questionId: 'toolu_1',
            answers: ['pg'],
        });
        expect(short.data).toMatchObject({ outcome: 'refused', code: 'answers_mismatch' });
        const unknown = await call(url, 'both', 'answer_question', { jobId: JOB, questionId: 'nope', answers: ['a'] });
        expect(unknown.data).toMatchObject({ outcome: 'refused', code: 'question_not_found' });
        expect(board.calls).toEqual([]);
    });

    it('refuses a question whose prompts repeat a text, rather than send the board fewer answers than prompts', async () => {
        const board: Board = { calls: [], prompts: [PROMPTS[0], PROMPTS[0]] };
        const { url } = await boot(board);
        const refused = await call(url, 'both', 'answer_question', {
            jobId: JOB,
            questionId: 'toolu_1',
            answers: ['pg', 'sqlite'],
        });
        expect(refused.data).toMatchObject({ outcome: 'refused', code: 'duplicate_prompts' });
        expect(board.calls).toEqual([]);
    });

    it('refuses answer_question for a write-only token at the gate: the thread read it needs is not allowed', async () => {
        const board: Board = { calls: [] };
        const { url } = await boot(board);
        const refused = await call(url, 'writer', 'answer_question', {
            jobId: JOB,
            questionId: 'toolu_1',
            answers: ['pg', '8080'],
        });
        expect(refused.data).toMatchObject({ outcome: 'refused', code: 'insufficient_scope' });
        expect(board.calls).toEqual([]);
    });
});
