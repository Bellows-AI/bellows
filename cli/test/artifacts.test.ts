import { describe, expect, it } from 'vitest';
import { json, runCli } from './harness.js';

const cli = (argv: string[], respond: (url: string) => Response) => runCli(argv, (sent) => respond(sent.url));

describe('bellows job activity', () => {
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
