import { describe, expect, it } from 'vitest';
import type { BoardJobRecord } from '../src/board.js';
import { renderJobDetail } from '../src/render.js';
import { run } from '../src/run.js';
import { recordingBoard } from './harness.js';

const task = (overrides: Record<string, unknown> = {}) => ({
    id: 'task-1',
    headRunId: 'run-3',
    command: 'fix the login bug',
    status: 'running',
    doneAt: null,
    repo: { forge: 'github', host: 'github.com', path: 'acme/api' },
    executor: 'main',
    author: { login: 'octocat' },
    waitReason: null,
    needsAnswer: false,
    createdAt: '2026-09-29T13:00:00.000Z',
    activityAt: '2026-09-29T14:00:00.000Z',
    ...overrides,
});

const answer = (items: unknown[], nextCursor: string | null = null) =>
    Response.json({
        navigation: { counts: { running: 0, review: 0, past: 0 }, running: [], review: [] },
        page: { items, nextCursor },
    });

/** Answers each request in turn from `responses`, recording the URL the CLI asked for. */
function harness(...responses: Response[]) {
    const urls: string[] = [];
    const { out, err, io } = recordingBoard((sent, index) => {
        urls.push(sent.url);
        return responses[index] ?? Response.json({ error: 'unexpected', code: 'X' }, { status: 500 });
    });
    return { out, err, urls, io };
}

const queryOf = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe('bellows task list', () => {
    it('asks for no filter by default and names the task and its head run', async () => {
        const { out, urls, io } = harness(answer([task()]));

        expect(await run(['task', 'list'], io)).toBe(0);

        expect(urls).toEqual(['http://board/api/tasks']);
        const printed = out.join('');
        expect(printed).toContain('task-1');
        expect(printed).toContain('head:run-3');
        expect(printed).toContain('fix the login bug');
    });

    it('passes every filter, the sort, the limit and the cursor through', async () => {
        const { urls, io } = harness(answer([]));

        const args = ['--state', 'past', '--q', 'login', '--author', 'octocat', '--repo', 'acme/api'];
        const code = await run(['task', 'list', ...args, '--sort', 'oldest', '--limit', '5', '--cursor', 'abc'], io);

        expect(code).toBe(0);
        expect(queryOf(urls[0]!)).toEqual({
            state: 'past',
            q: 'login',
            author: 'octocat',
            repo: 'acme/api',
            sort: 'oldest',
            limit: '5',
            cursor: 'abc',
        });
    });

    it('sends a forge-prefixed --repo as its normalized ref text and prints each task repo in text form', async () => {
        const gitlab = { forge: 'gitlab', host: 'gl.example', path: 'g/sub/p' };
        const { out, urls, io } = harness(answer([task(), task({ id: 'task-2', repo: gitlab })]));

        expect(await run(['task', 'list', '--repo', 'gitlab:GL.example/g/sub/p'], io)).toBe(0);

        expect(queryOf(urls[0]!)).toEqual({ repo: 'gitlab:gl.example/g/sub/p' });
        const printed = out.join('');
        expect(printed).toContain('acme/api');
        expect(printed).toContain('gitlab:gl.example/g/sub/p');
        expect(printed).not.toContain('[object Object]');
    });

    it('refuses a malformed --repo locally, sending nothing', async () => {
        const { urls, io } = harness(answer([]));

        expect(await run(['task', 'list', '--repo', 'bad'], io)).toBe(2);
        expect(urls).toEqual([]);
    });

    it.each(['attention', 'running', 'review', 'past'])('accepts --state %s', async (state) => {
        const { urls, io } = harness(answer([]));
        expect(await run(['task', 'list', '--state', state], io)).toBe(0);
        expect(queryOf(urls[0]!)).toEqual({ state });
    });

    it('prints the next cursor, and traverses two pages with it without repeating a task', async () => {
        const { out, urls, io } = harness(
            answer([task({ id: 'task-2' })], 'CURSOR-1'),
            answer([task({ id: 'task-1' })], null)
        );

        await run(['task', 'list', '--limit', '1', '--json'], io);
        const first = JSON.parse(out.join(''));
        expect(first.data.nextCursor).toBe('CURSOR-1');

        out.length = 0;
        await run(['task', 'list', '--limit', '1', '--cursor', first.data.nextCursor, '--json'], io);
        const second = JSON.parse(out.join(''));

        expect(queryOf(urls[1]!)).toEqual({ limit: '1', cursor: 'CURSOR-1' });
        expect(second.data.nextCursor).toBeNull();
        expect([...first.data.tasks, ...second.data.tasks].map((t: { id: string }) => t.id)).toEqual([
            'task-2',
            'task-1',
        ]);
    });

    it('shows the cursor to resume from in the human rendering', async () => {
        const { out, io } = harness(answer([task()], 'CURSOR-1'));
        await run(['task', 'list'], io);
        expect(out.join('')).toContain('next: --cursor CURSOR-1');
    });

    it('keeps a task whose head is a later retry or follow-up distinct from its root', async () => {
        const { out, io } = harness(
            answer([
                task({ id: 'task-1', headRunId: 'run-9', status: 'queued' }),
                task({ id: 'task-2', headRunId: 'task-2', status: 'succeeded' }),
            ])
        );

        await run(['task', 'list', '--json'], io);

        const tasks = JSON.parse(out.join('')).data.tasks;
        expect(tasks.map((t: { id: string; headRunId: string }) => [t.id, t.headRunId])).toEqual([
            ['task-1', 'run-9'],
            ['task-2', 'task-2'],
        ]);
    });

    it('answers an empty result as success, in both renderings', async () => {
        const human = harness(answer([]));
        expect(await run(['task', 'list'], human.io)).toBe(0);
        expect(human.out.join('')).toBe('no tasks\n');

        const machine = harness(answer([]));
        expect(await run(['task', 'list', '--json'], machine.io)).toBe(0);
        expect(JSON.parse(machine.out.join('')).data).toEqual({ tasks: [], nextCursor: null });
    });

    it.each([
        [['--state', 'done'], '--state'],
        [['--sort', 'latest'], '--sort'],
        [['--limit', '0'], '--limit'],
        [['--limit', '51'], '--limit'],
        [['--limit', 'many'], '--limit'],
    ])('refuses %j before any request', async (flags, named) => {
        const { err, urls, io } = harness(answer([]));

        const code = await run(['task', 'list', ...flags], io);

        expect(code).toBe(2);
        expect(err.join('')).toContain(named);
        expect(urls).toHaveLength(0);
    });
});

describe('job detail change-request line', () => {
    const detail = (prUrl: string, prNumber: number) =>
        renderJobDetail({
            id: 'job-1',
            status: 'succeeded',
            repo: 'acme/api',
            publication: { repo: 'acme/api', prNumber, prUrl, headBranch: 'f', baseBranch: 'main' },
        } as unknown as BoardJobRecord);

    it('labels a GitHub pull request pr:', () => {
        const text = detail('https://github.com/acme/api/pull/7', 7);
        expect(text).toContain('pr:');
        expect(text).not.toContain('mr:');
    });

    it('labels a GitLab merge request mr:', () => {
        const text = detail('https://gitlab.example.com/g/sub/api/-/merge_requests/7', 7);
        expect(text).toContain('mr:');
        expect(text).not.toContain('pr:');
    });
});
