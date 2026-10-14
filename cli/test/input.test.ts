import { describe, expect, it } from 'vitest';
import { COMMAND_LIMIT } from '../src/input.js';
import { run } from '../src/run.js';

const ENV = { FACTORY_URL: 'http://board', FACTORY_TOKEN: 'fat_abc' };
const MULTILINE = 'fix the bug\n\n  • indented — naïve café 日本語 🚀\nlast line\n';

function harness(files: Record<string, string | Error> = {}, stdin: string | Error = '') {
    const out: string[] = [];
    const err: string[] = [];
    const bodies: unknown[] = [];
    const fetch = (async (_url: string | URL | globalThis.Request, init?: RequestInit) => {
        bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
        return new Response(JSON.stringify({ id: 'job-2', status: 'queued' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
        });
    }) as unknown as typeof globalThis.fetch;
    const io = {
        env: ENV,
        fetch,
        readFile: async (path: string) => {
            const file = files[path] ?? new Error(`ENOENT: no such file or directory, open '${path}'`);
            if (file instanceof Error) throw file;
            return file;
        },
        readStdin: async () => {
            if (stdin instanceof Error) throw stdin;
            return stdin;
        },
        stdout: (text: string) => out.push(text),
        stderr: (text: string) => err.push(text),
    };
    return { out, err, bodies, io };
}

const COMMANDS = [
    { name: 'create', argv: ['job', 'create'] },
    { name: 'follow-up', argv: ['job', 'follow-up', 'job-1'] },
] as const;

describe.each(COMMANDS)('bellows job $name prompt input', ({ argv }) => {
    it('sends file text untouched: multiline, Unicode, trailing newline', async () => {
        const { bodies, io } = harness({ 'prompt.md': MULTILINE });

        expect(await run([...argv, '--file', 'prompt.md'], io)).toBe(0);

        expect(bodies).toHaveLength(1);
        expect((bodies[0] as { command: string }).command).toBe(MULTILINE);
    });

    it('sends stdin text untouched', async () => {
        const { bodies, io } = harness({}, MULTILINE);

        expect(await run([...argv, '--stdin'], io)).toBe(0);

        expect((bodies[0] as { command: string }).command).toBe(MULTILINE);
    });

    it('accepts a prompt of exactly the board limit', async () => {
        const { bodies, io } = harness({}, 'x'.repeat(COMMAND_LIMIT));

        expect(await run([...argv, '--stdin'], io)).toBe(0);
        expect(bodies).toHaveLength(1);
    });

    it.each([
        ['a blank file', ['--file', 'blank.md'], { 'blank.md': ' \n\t\n' }, '', 'empty'],
        ['empty stdin', ['--stdin'], {}, '', 'empty'],
        ['blank stdin', ['--stdin'], {}, '  \n', 'empty'],
        ['an oversized file', ['--file', 'big.md'], { 'big.md': 'x'.repeat(COMMAND_LIMIT + 1) }, '', 'limit is'],
        ['an oversized stdin', ['--stdin'], {}, 'x'.repeat(COMMAND_LIMIT + 1), 'limit is'],
        ['an unreadable file', ['--file', 'missing.md'], {}, '', 'cannot read --file missing.md'],
        ['a failing stdin', ['--stdin'], {}, new Error('EIO: broken pipe'), 'cannot read --stdin: EIO: broken pipe'],
        ['a file and stdin', ['--file', 'a.md', '--stdin'], { 'a.md': 'hi' }, 'hi', 'one source'],
        ['a file and words', ['--file', 'a.md', 'hi'], { 'a.md': 'hi' }, '', 'one source'],
        ['stdin and words', ['--stdin', 'hi'], {}, 'hi', 'one source'],
    ] as const)('is a usage error for %s, making no request', async (...row) => {
        const [, flags, files, stdin, message] = row;
        const { err, bodies, io } = harness({ ...files }, stdin);

        expect(await run([...argv, ...flags], io)).toBe(2);

        expect(err.join('')).toContain(message);
        expect(err.join('')).toContain('usage:');
        expect(bodies).toHaveLength(0);
    });

    it('refuses an oversized positional prompt before any request', async () => {
        const { err, bodies, io } = harness();

        expect(await run([...argv, 'x'.repeat(COMMAND_LIMIT + 1)], io)).toBe(2);

        expect(err.join('')).toContain('limit is');
        expect(bodies).toHaveLength(0);
    });

    it('reports a usage error as a --json envelope', async () => {
        const { out, err, io } = harness();

        expect(await run([...argv, '--file', 'missing.md', '--json'], io)).toBe(2);

        expect(err).toEqual([]);
        expect(JSON.parse(out.join(''))).toMatchObject({ ok: false, outcome: 'usage', exitCode: 2 });
    });
});

describe('bellows job follow-up id', () => {
    it('still needs a job id when the text comes from stdin', async () => {
        const { err, bodies, io } = harness({}, 'again');

        expect(await run(['job', 'follow-up', '--stdin'], io)).toBe(2);

        expect(err.join('')).toContain('a follow-up needs a job id');
        expect(bodies).toHaveLength(0);
    });
});
