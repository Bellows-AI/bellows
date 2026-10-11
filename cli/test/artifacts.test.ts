import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

const ENV = { FACTORY_URL: 'http://board', FACTORY_TOKEN: 'fat_abc' };

const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

/** A board that serves `content` of `attempts` by the artifact route's own offset/limit/attempt query. */
function artifactBoard(attempts: Record<number, string>, failAt?: number) {
    const urls: string[] = [];
    const respond = (url: string): Response => {
        urls.push(url);
        const query = new URL(url).searchParams;
        const newest = Math.max(...Object.keys(attempts).map(Number));
        const attempt = query.has('attempt') ? Number(query.get('attempt')) : newest;
        const content = attempts[attempt];
        if (content === undefined) return json({ error: 'No such artifact', code: 'NOT_FOUND' }, 404);
        const offset = Number(query.get('offset') ?? 0);
        const limit = Number(query.get('limit') ?? 65_536);
        if (failAt !== undefined && offset >= failAt) return json({ error: 'board broke', code: 'BAD' }, 400);
        return json({
            jobId: 'job-1',
            kind: 'log',
            attempt,
            truncated: false,
            offset,
            limit,
            totalCharacters: content.length,
            content: content.slice(offset, offset + limit),
        });
    };
    return { urls, respond };
}

async function cli(argv: string[], respond: (url: string) => Response) {
    const out: string[] = [];
    const err: string[] = [];
    const fetch = (async (url: string | URL | globalThis.Request) => respond(String(url))) as unknown as typeof fetch;
    const code = await run(argv, {
        env: ENV,
        fetch,
        sleep: async () => undefined,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
    });
    return { code, out: out.join(''), err: err.join('') };
}

const LOG = Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join('');

describe('factory job log / transcript', () => {
    it('--all walks every page in order and prints the whole artifact', async () => {
        const board = artifactBoard({ 1: LOG });
        const { code, out } = await cli(['job', 'log', 'job-1', '--all', '--limit', '25'], board.respond);

        expect(code).toBe(0);
        expect(out).toBe(LOG);
        expect(board.urls.length).toBeGreaterThan(1);
        expect(board.urls.map((u) => new URL(u).searchParams.get('offset'))).toEqual(
            board.urls.map((_, i) => String(i * 25))
        );
    });

    it('--all pins the attempt of the first page, and --json reports the page count', async () => {
        const board = artifactBoard({ 1: 'old', 2: LOG });
        const { out } = await cli(['job', 'log', 'job-1', '--all', '--limit', '30', '--json'], board.respond);

        const data = JSON.parse(out).data;
        expect(data.attempt).toBe(2);
        expect(data.content).toBe(LOG);
        expect(data.pages).toBe(board.urls.length);
        expect(board.urls.slice(1).every((u) => new URL(u).searchParams.get('attempt') === '2')).toBe(true);
    });

    it('selects the requested attempt', async () => {
        const board = artifactBoard({ 1: 'first run', 2: 'second run' });
        const { out } = await cli(['job', 'log', 'job-1', '--attempt', '1', '--all'], board.respond);

        expect(out).toBe('first run');
        expect(new URL(board.urls[0]!).searchParams.get('attempt')).toBe('1');
    });

    it('one call is one page: the next offset is named, and --json carries it', async () => {
        const board = artifactBoard({ 1: LOG });
        const human = await cli(['job', 'log', 'job-1', '--limit', '25'], board.respond);

        expect(human.out).toBe(LOG.slice(0, 25));
        expect(human.err).toContain(`characters 0..25 of ${LOG.length}`);
        expect(human.err).toContain('next page: --offset 25');

        const machine = await cli(['job', 'log', 'job-1', '--offset', '75', '--json'], board.respond);
        expect(JSON.parse(machine.out).data).toMatchObject({ offset: 75, nextOffset: null, content: LOG.slice(75) });
    });

    it('reports a missing artifact as the board refusal', async () => {
        const board = artifactBoard({ 1: LOG });
        const { code, err } = await cli(['job', 'transcript', 'job-1', '--attempt', '9'], board.respond);

        expect(code).toBe(1);
        expect(err).toContain('No such artifact');
    });

    it('a failure on a later page fails the command, names the page and prints no partial artifact', async () => {
        const board = artifactBoard({ 1: LOG }, 50);
        const { code, out, err } = await cli(['job', 'log', 'job-1', '--all', '--limit', '25'], board.respond);

        expect(code).toBe(1);
        expect(out).toBe('');
        expect(err).toContain('board broke');
        expect(err).toContain(`offset 50 failed after 50 of ${LOG.length} characters`);
    });

    it('says when the stored artifact was itself truncated', async () => {
        const respond = () =>
            json({
                jobId: 'j',
                kind: 'log',
                attempt: 1,
                truncated: true,
                offset: 0,
                limit: 9,
                totalCharacters: 3,
                content: 'abc',
            });
        const { err } = await cli(['job', 'log', 'job-1', '--all'], respond);

        expect(err).toContain('truncated at upload');
    });

    it('refuses --all with --offset and a bad count as usage, before any request', async () => {
        const board = artifactBoard({ 1: LOG });
        expect((await cli(['job', 'log', 'job-1', '--all', '--offset', '3'], board.respond)).code).toBe(2);
        expect((await cli(['job', 'log', 'job-1', '--limit', '0'], board.respond)).code).toBe(2);
        expect(board.urls).toHaveLength(0);
    });
});

describe('factory job activity', () => {
    it('prints one row per bucket and keeps the payload under --json', async () => {
        const body = {
            jobId: 'job-1',
            sessionId: 's',
            from: '2026-01-01T00:00:00.000Z',
            to: '2026-01-01T00:02:00.000Z',
            bucketMs: 60_000,
            buckets: [
                {
                    start: '2026-01-01T00:00:00.000Z',
                    tokens: { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 },
                    edits: 3,
                },
            ],
            totals: { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 },
        };
        const human = await cli(['job', 'activity', 'job-1'], () => json(body));
        expect(human.out).toContain('input 100  output 20  cache-read 0  cache-creation 0  edits 3');

        const machine = await cli(['job', 'activity', 'job-1', '--json'], () => json(body));
        expect(JSON.parse(machine.out).data).toEqual(body);
    });

    it('says plainly when there is nothing to chart', async () => {
        const body = { jobId: 'job-1', sessionId: null, from: null, to: null, bucketMs: null, buckets: [] };
        expect((await cli(['job', 'activity', 'job-1'], () => json(body))).out).toContain('no activity');
    });
});

describe('factory job investigate evidence', () => {
    const job = {
        id: 'job-1',
        rootJobId: 'job-1',
        command: 'fix',
        status: 'failed',
        waitReason: 'review',
        waitingSince: '2026-01-01T00:00:00.000Z',
        author: null,
        repo: 'o/n',
        executor: null,
        mode: 'objective',
        createdAt: '2026-01-01T00:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        sessionId: null,
        exitCode: 1,
        failureKind: 'gates',
        summary: null,
        gates: [{ name: 'lint', status: 'failed', exitCode: 2, output: 'src/a.ts: unused import' }],
        output: 'tail',
        publication: {
            repo: 'o/n',
            prNumber: 7,
            prUrl: 'https://github.com/o/n/pull/7',
            headBranch: 'f',
            baseBranch: 'main',
        },
        questions: [
            {
                id: 'q',
                attempt: 1,
                status: 'pending',
                answers: null,
                askedAt: 'x',
                questions: [{ question: 'Which db?', header: 'db' }],
            },
        ],
    };

    it('renders the PR link, the failing gate, the wait and the open question; JSON keeps the fields', async () => {
        const respond = (url: string) => (url.endsWith('/thread') ? json({ jobs: [job] }) : json(job));
        const { out } = await cli(['job', 'investigate', 'job-1'], respond);

        expect(out).toContain('https://github.com/o/n/pull/7');
        expect(out).toContain('lint failed (exit 2)');
        expect(out).toContain('src/a.ts: unused import');
        expect(out).toContain('review since 2026-01-01');
        expect(out).toContain('Which db? [pending]');
        expect(out).toContain('tail only');

        const machine = await cli(['job', 'investigate', 'job-1', '--json'], respond);
        expect(JSON.parse(machine.out).data.job.publication.prNumber).toBe(7);
    });
});
