import { describe, expect, it } from 'vitest';
import { json, runCli } from './harness.js';

const cli = (argv: string[], respond: (url: string) => Response) => runCli(argv, (sent) => respond(sent.url));

const NULLS = { input: null, output: null, cacheRead: null, cacheCreation: null };
const block = (tokens: Record<string, number | null>, over: Record<string, unknown> = {}) => {
    const t = { ...NULLS, ...tokens };
    const exact = { input: 'exact', output: 'exact', cacheRead: 'exact', cacheCreation: 'exact' };
    const kinds = Object.fromEntries(
        Object.entries(t).map(([k, v]) => [k, v === null ? null : exact[k as keyof typeof exact]])
    );
    const coverage = Object.fromEntries(
        Object.entries(t).map(([k, v]) => [k, { measured: v === null ? 0 : 1, contributors: 1 }])
    );
    return {
        state: 'measured',
        provisional: false,
        tokens: t,
        assigned: t,
        unassigned: [],
        unlocated: NULLS,
        unresolvedTemporality: { observations: 0 },
        precision: kinds,
        coverage,
        rows: [],
        counts: { sessions: 1, runs: 1, tasks: 1 },
        ...over,
    };
};
const run = (jobId: string, kind: string, tokens: Record<string, number | null>, reviewOf: string | null = null) => ({
    jobId,
    kind,
    reviewOf,
    live: false,
    operational: true,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:02:00.000Z',
    usage: block(tokens),
});

describe('bellows job activity', () => {
    const body = () => {
        const mine = run('job-1', 'run', { input: 100, output: 20 });
        const review = run('rev-1', 'review', { output: 9 }, 'job-1');
        const owned = block({ output: 5 }, { unassigned: [{ reason: 'no-segment', tokens: { ...NULLS, output: 5 } }] });
        const taskTokens = { input: 100, output: 34 };
        return {
            jobId: 'job-1',
            sessionId: 's',
            from: '2026-01-01T00:00:00.000Z',
            to: '2026-01-01T00:02:00.000Z',
            bucketMs: 60_000,
            buckets: [
                { start: '2026-01-01T00:00:00.000Z', tokens: { ...NULLS, input: 100, output: 0 }, edits: 3 },
                { start: '2026-01-01T00:01:00.000Z', tokens: { ...NULLS, input: 0, output: 20 }, edits: null },
            ],
            usage: mine.usage,
            task: {
                taskId: 'job-1',
                removed: false,
                usage: block(taskTokens),
                runs: [mine, review],
                taskOwned: owned,
            },
        };
    };

    it('keeps the whole payload under --json, nulls and review runs included', async () => {
        const machine = await cli(['job', 'activity', 'job-1', '--json'], () => json(body()));
        expect(JSON.parse(machine.out).data).toEqual(body());
    });

    it('prints the four types apart per bucket, with - for a type never measured and no total', async () => {
        const human = (await cli(['job', 'activity', 'job-1'], () => json(body()))).out;
        expect(human).toContain('input 100  output 0  cache-read -  cache-creation -  edits 3');
        expect(human).toContain('input 0  output 20  cache-read -  cache-creation -  edits -');
        expect(human).not.toMatch(/total/i);
    });

    it('lists the task with its review run and the run-unassigned reason', async () => {
        const human = (await cli(['job', 'activity', 'job-1'], () => json(body()))).out;
        expect(human).toContain('run usage: input 100 (1/1)  output 20 (1/1)  cache-read -  cache-creation -');
        expect(human).toContain('task job-1: input 100 (1/1)  output 34 (1/1)');
        expect(human).toContain('review of job-1 rev-1: input -  output 9 (1/1)');
        expect(human).toContain('unassigned (no-segment): input -  output 5  cache-read -  cache-creation -');
    });

    it('marks an estimated or mixed figure with ~ and shows measured/contributors per type', async () => {
        const data = body();
        data.usage.precision.output = 'estimated';
        data.usage.coverage.output = { measured: 2, contributors: 3 };
        const human = (await cli(['job', 'activity', 'job-1'], () => json(data))).out;
        expect(human).toContain('run usage: input 100 (1/1)  output ~20 (2/3)');
    });

    it('says plainly when there is nothing to chart', async () => {
        const empty = {
            jobId: 'job-1',
            sessionId: null,
            from: null,
            to: null,
            bucketMs: null,
            buckets: [],
            usage: block({}, { state: 'unmeasured' }),
            task: null,
        };
        expect((await cli(['job', 'activity', 'job-1'], () => json(empty))).out).toBe(
            'no activity: the run measured no usage\n'
        );
    });
});

const stream = (over: Record<string, unknown> = {}) => ({
    attempt: 1,
    executor: 'claude-code',
    session: 'sess-a',
    stream: 'transcript',
    state: 'complete',
    terminalCause: null,
    chunks: 2,
    bytes: 10,
    producer: 'exporter',
    startedAt: null,
    finishedAt: null,
    ...over,
});
const segment = (over: Record<string, unknown> = {}) => ({
    attempt: 1,
    executor: 'claude-code',
    session: 'sess-a',
    stream: 'transcript',
    offset: 0,
    length: 6,
    gapBefore: 0,
    state: 'ok',
    text: 'line 1\n',
    ...over,
});

describe('bellows job streams', () => {
    it('lists each stream with its state and cause, and sends the selection as the query', async () => {
        const streams = [stream(), stream({ session: 'sess-b', state: 'truncated', terminalCause: 'stream_cap' })];
        const sentPaths: string[] = [];
        const result = await cli(['job', 'streams', 'job-1', '--attempt', '2', '--stream', 'transcript'], (url) => {
            sentPaths.push(url);
            return json({ jobId: 'job-1', streams });
        });
        expect(sentPaths).toEqual(['http://board/api/jobs/job-1/artifacts?stream=transcript&attempt=2']);
        expect(result.out).toContain('complete  attempt 1 claude-code session sess-a stream transcript  2 chunks');
        expect(result.out).toContain('truncated (stream_cap)  attempt 1 claude-code session sess-b');
    });

    it('rejects a non-integer attempt as a usage error before any request', async () => {
        const result = await cli(['job', 'streams', 'job-1', '--attempt', 'x'], () => json({}));
        expect(result.code).toBe(2);
    });
});

describe('bellows job read', () => {
    const page = (segments: unknown[], nextCursor: string | null, streams = [stream()]) =>
        json({ jobId: 'job-1', streams, segments, nextCursor });

    it('prints a page, then the cursor that continues it', async () => {
        const result = await cli(['job', 'read', 'job-1', '--limit', '6'], () =>
            page([segment()], 'abc', [stream({ state: 'partial', terminalCause: 'not_finalized' })])
        );
        expect(result.out).toContain(
            '# partial (not_finalized): attempt 1 claude-code session sess-a stream transcript'
        );
        expect(result.out).toContain('line 1');
        expect(result.out).toContain('# more: --cursor abc');
    });

    it('follows every cursor under --all, so a transcript of any length reads in one command', async () => {
        const cursors: (string | null)[] = [];
        const result = await cli(['job', 'read', 'job-1', '--all', '--json'], (url) => {
            const cursor = new URL(url).searchParams.get('cursor');
            cursors.push(cursor);
            if (cursor === null) return page([segment({ text: 'a\n' })], 'c1');
            if (cursor === 'c1') return page([segment({ offset: 2, text: 'b\n' })], 'c2');
            return page([segment({ attempt: 2, session: 'sess-b', text: 'c\n' })], null);
        });
        expect(cursors).toEqual([null, 'c1', 'c2']);
        const data = JSON.parse(result.out).data;
        expect(data.segments.map((s: { text: string }) => s.text)).toEqual(['a\n', 'b\n', 'c\n']);
        expect(data.nextCursor).toBeNull();
    });

    it('says inline when bytes are missing or an object was deleted', async () => {
        const result = await cli(['job', 'read', 'job-1'], () =>
            page([segment({ offset: 8, gapBefore: 8 }), segment({ offset: 14, state: 'deleted', text: null })], null, [
                stream({ state: 'deleted', terminalCause: 'object_missing' }),
            ])
        );
        expect(result.out).toContain('# deleted (object_missing)');
        expect(result.out).toContain('# 8 bytes missing before offset 8');
        expect(result.out).toContain('# deleted: 6 bytes at offset 14 of attempt 1');
    });

    it('surfaces a refusal from the board', async () => {
        const result = await cli(['job', 'read', 'job-1'], () =>
            json({ error: 'No such job', code: 'NOT_FOUND' }, 404)
        );
        expect(result.code).not.toBe(0);
    });
});

describe('bellows job investigate evidence', () => {
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
