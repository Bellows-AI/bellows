import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

interface Call {
    url: string;
    method: string;
    body: unknown;
}

const ENV = { FACTORY_URL: 'http://board', FACTORY_TOKEN: 'fat_abc' };

const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

function harness(respond: (index: number) => Response) {
    const out: string[] = [];
    const err: string[] = [];
    const calls: Call[] = [];
    const fetch = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
        const index = calls.length;
        calls.push({
            url: String(url),
            method: init?.method ?? 'GET',
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        return respond(index);
    }) as unknown as typeof globalThis.fetch;
    const io = {
        env: ENV,
        fetch,
        sleep: async () => {},
        stdout: (text: string) => out.push(text),
        stderr: (text: string) => err.push(text),
    };
    return { out, err, calls, io };
}

const run1 = (overrides: Record<string, unknown> = {}) => ({
    id: 'job-1',
    command: 'fix it',
    status: 'running',
    questions: [] as unknown[],
    ...overrides,
});

const asked = (overrides: Record<string, unknown> = {}) => ({
    id: 'toolu_1',
    attempt: 1,
    questions: [
        {
            question: 'Which database?',
            header: 'DB',
            multiSelect: false,
            options: [{ label: 'postgres', description: 'the default' }, { label: 'sqlite' }],
        },
    ],
    status: 'pending',
    answerable: true,
    answers: null,
    answeredBy: null,
    askedAt: '2026-09-29T13:01:00.000Z',
    answeredAt: null,
    ...overrides,
});

const threadWith = (...questions: unknown[]) => json({ jobs: [run1({ questions })] });

describe('bellows job questions', () => {
    it('lists the id, prompt, options, free-text note and state', async () => {
        const { out, calls, io } = harness(() => threadWith(asked()));

        const code = await run(['job', 'questions', 'job-1'], io);

        expect(code).toBe(0);
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/thread');
        const text = out.join('');
        expect(text).toContain('toolu_1  pending');
        expect(text).toContain('[DB] Which database?');
        expect(text).toContain('choose one, or free text');
        expect(text).toContain('- postgres: the default');
        expect(text).toContain('- sqlite');
    });

    it('shows a recorded answer and a question the board no longer takes answers for', async () => {
        const answered = asked({
            status: 'answered',
            answers: { 'Which database?': 'sqlite' },
            answeredBy: { login: 'octocat' },
            answeredAt: '2026-09-29T13:02:00.000Z',
        });
        const closed = asked({ id: 'toolu_2', status: 'closed', answerable: false });
        const { out, io } = harness(() => threadWith(answered, closed));

        await run(['job', 'questions', 'job-1'], io);

        const text = out.join('');
        expect(text).toContain('answered 2026-09-29T13:02:00.000Z by octocat');
        expect(text).toContain('answer: sqlite');
        expect(text).toContain('toolu_2  closed');
    });

    it('says so when the task asked nothing, and puts the list in the json envelope', async () => {
        const empty = harness(() => threadWith());
        expect(await run(['job', 'questions', 'job-1'], empty.io)).toBe(0);
        expect(empty.out.join('')).toBe('no questions\n');

        const listed = harness(() => threadWith(asked()));
        await run(['job', 'questions', 'job-1', '--json'], listed.io);
        expect(JSON.parse(listed.out.join('')).data.questions[0].id).toBe('toolu_1');
    });
});

describe('bellows job answer', () => {
    const answerRoute = 'http://board/api/jobs/job-1/questions/toolu_1/answer';
    const answeredBody = () => json(asked({ status: 'answered' }));

    it('posts an option answer keyed by the question text', async () => {
        const { out, calls, io } = harness((i) => (i === 0 ? threadWith(asked()) : answeredBody()));

        const code = await run(['job', 'answer', 'job-1', 'toolu_1', '--answer', 'postgres'], io);

        expect(code).toBe(0);
        expect(calls[1]).toMatchObject({
            url: answerRoute,
            method: 'POST',
            body: { answers: { 'Which database?': 'postgres' } },
        });
        expect(out.join('')).toBe('answered toolu_1\n');
    });

    it('sends free text as written, one answer per prompt in order', async () => {
        const two = asked({
            questions: [
                { question: 'First?', header: 'A', multiSelect: false, options: [{ label: 'x' }, { label: 'y' }] },
                { question: 'Second?', header: 'B', multiSelect: true, options: [{ label: 'p' }, { label: 'q' }] },
            ],
        });
        const { calls, io } = harness((i) => (i === 0 ? threadWith(two) : answeredBody()));

        await run(['job', 'answer', 'job-1', 'toolu_1', '--answer', 'something else', '--answer', 'p, q'], io);

        expect(calls[1]!.body).toEqual({ answers: { 'First?': 'something else', 'Second?': 'p, q' } });
    });

    it('refuses a wrong answer count before any write', async () => {
        const { err, calls, io } = harness(() => threadWith(asked()));

        const code = await run(['job', 'answer', 'job-1', 'toolu_1'], io);

        expect(code).toBe(2);
        expect(err.join('')).toContain('1 prompt(s)');
        expect(calls).toHaveLength(1);
    });

    it('refuses an unknown question id before any write', async () => {
        const { err, calls, io } = harness(() => threadWith(asked()));

        expect(await run(['job', 'answer', 'job-1', 'nope', '--answer', 'x'], io)).toBe(2);
        expect(err.join('')).toContain('no question nope');
        expect(calls).toHaveLength(1);
    });

    it('answers on the run that asked, not the one named', async () => {
        const thread = json({ jobs: [run1({ id: 'job-0' }), run1({ id: 'job-2', questions: [asked()] })] });
        const { calls, io } = harness((i) => (i === 0 ? thread : answeredBody()));

        await run(['job', 'answer', 'job-0', 'toolu_1', '--answer', 'postgres'], io);

        expect(calls[1]!.url).toBe('http://board/api/jobs/job-2/questions/toolu_1/answer');
    });

    it('surfaces each board refusal with its code, and never retries the write', async () => {
        const refusals: [number, string, string, string][] = [
            [400, 'INVALID_ANSWER', 'answers must have exactly one entry per question', 'INVALID_ANSWER'],
            [409, 'QUESTION_ANSWERED', 'Question already answered', 'job questions job-1'],
            [409, 'QUESTION_EXPIRED', 'Question expired', 'QUESTION_EXPIRED'],
            [409, 'QUESTION_CLOSED', 'The run that asked is no longer waiting', 'QUESTION_CLOSED'],
        ];
        for (const [status, code, message, expected] of refusals) {
            const { err, calls, io } = harness((i) =>
                i === 0 ? threadWith(asked()) : json({ error: message, code }, status)
            );

            const exit = await run(['job', 'answer', 'job-1', 'toolu_1', '--answer', 'postgres'], io);

            expect(exit).toBe(1);
            expect(err.join('')).toContain(message);
            expect(err.join('')).toContain(expected);
            expect(calls).toHaveLength(2);
        }
    });

    it('does not re-send the write when the board fails or goes quiet', async () => {
        const { err, calls, io } = harness((i) =>
            i === 0 ? threadWith(asked()) : json({ error: 'unavailable', code: 'UNAVAILABLE' }, 503)
        );

        expect(await run(['job', 'answer', 'job-1', 'toolu_1', '--answer', 'postgres'], io)).toBe(1);
        expect(err.join('')).toContain('unavailable');
        expect(calls).toHaveLength(2);
    });

    it('reports the refusal in the json envelope with its code and status', async () => {
        const { out, io } = harness((i) =>
            i === 0 ? threadWith(asked()) : json({ error: 'Question expired', code: 'QUESTION_EXPIRED' }, 409)
        );

        await run(['job', 'answer', 'job-1', 'toolu_1', '--answer', 'postgres', '--json'], io);

        expect(JSON.parse(out.join('')).error).toMatchObject({ code: 'QUESTION_EXPIRED', status: 409 });
    });
});
