import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';
import { recordingBoard, json, routed } from './harness.js';

const SECRET = 'fat_s3cr3t-DO-NOT-PRINT';
const ENV = { FACTORY_URL: 'http://board', FACTORY_TOKEN: SECRET };
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
    .version;

/** Answers each path from `routes`; a path not listed answers 404. Every request is recorded. */
function harness(routes: Record<string, () => Response>, env: NodeJS.ProcessEnv = ENV) {
    const { out, err, sent: calls, io } = recordingBoard(routed(routes), { env });
    const printed = () => out.join('') + err.join('');
    return { out, err, calls, io, printed };
}

const envelope = (out: string[]) => JSON.parse(out.join(''));

const me = {
    authenticated: true,
    user: { id: 'u1', login: 'octocat', name: 'Octo Cat' },
    role: 'member',
    organization: { id: 'o1', name: 'Acme' },
    mode: 'github',
};

const board = (overrides: Record<string, () => Response> = {}) => ({
    '/api/version': () => json({ version: '9.9.9' }),
    '/api/auth/me': () => json(me),
    ...overrides,
});

describe('help and version, with no board configured', () => {
    it.each(['help', '--help', '-h', 'job create --help', 'auth status -h'])(
        '%s prints the usage on stdout and exits 0, making no request',
        async (line) => {
            const { out, err, calls, io } = harness({}, {});
            expect(await run(line.split(' '), io)).toBe(0);
            expect(out.join('')).toContain('usage: bellows job create');
            expect(err).toEqual([]);
            expect(calls).toEqual([]);
        }
    );

    it('treats a --help after -- as part of the command, not a request for help', async () => {
        const { calls, io } = harness({ '/api/jobs': () => json({ id: 'job-1', status: 'queued' }, 201) });
        expect(await run(['job', 'create', '--', 'npm', '--help'], io)).toBe(0);
        expect(calls.map((call) => call.method)).toEqual(['POST']);
    });

    it.each([['--version'], ['version']])('%s prints the CLI version and exits 0, making no request', async (flag) => {
        const { out, calls, io } = harness({}, {});
        expect(await run([flag], io)).toBe(0);
        expect(out.join('')).toBe(`bellows ${VERSION}\n`);
        expect(calls).toEqual([]);
    });

    it('answers both in the --json envelope', async () => {
        const help = harness({}, {});
        expect(await run(['--help', '--json'], help.io)).toBe(0);
        expect(envelope(help.out)).toMatchObject({ ok: true, command: 'help' });
        expect(envelope(help.out).data.usage).toContain('usage: bellows');

        const version = harness({}, {});
        expect(await run(['--version', '--json'], version.io)).toBe(0);
        expect(envelope(version.out)).toMatchObject({ ok: true, command: 'version', data: { version: VERSION } });
    });

    it('keeps an empty command line a usage error', async () => {
        const { io } = harness({}, {});
        expect(await run([], io)).toBe(2);
    });
});

describe('bellows auth status: configuration', () => {
    it.each([
        ['a missing FACTORY_URL', {}, /FACTORY_URL/],
        ['a non-http FACTORY_URL', { FACTORY_URL: 'dashboard:8080' }, /FACTORY_URL/],
        [
            'an invalid FACTORY_READ_RETRIES',
            { FACTORY_URL: 'http://board', FACTORY_READ_RETRIES: 'many' },
            /FACTORY_READ_RETRIES/,
        ],
    ])('names %s, exits 2 and makes no request', async (_label, env, pattern) => {
        const { err, calls, io } = harness(board(), env);
        expect(await run(['auth', 'status'], io)).toBe(2);
        expect(err.join('')).toMatch(pattern);
        expect(calls).toEqual([]);
    });

    it('refuses a FACTORY_URL carrying a password without printing it', async () => {
        const { printed, calls, io } = harness(board(), { FACTORY_URL: 'http://me:hunter2@board' });
        expect(await run(['auth', 'status'], io)).toBe(2);
        expect(printed()).not.toContain('hunter2');
        expect(calls).toEqual([]);
    });
});

describe('bellows auth status: identity', () => {
    it('reports the configuration, board version and identity, reading only', async () => {
        const { out, calls, io } = harness(board());

        expect(await run(['auth', 'status', '--json'], io)).toBe(0);

        const { data } = envelope(out);
        expect(data.config).toEqual({
            url: 'http://board',
            token: { set: true, kind: 'personal' },
            requestTimeoutSeconds: 30,
            readRetries: 3,
            sources: { url: 'env', token: 'env', requestTimeoutS: 'default', readRetries: 'default' },
        });
        expect(data.board).toEqual({ version: '9.9.9' });
        expect(data.identity).toEqual({
            login: 'octocat',
            name: 'Octo Cat',
            userId: 'u1',
            organization: { id: 'o1', name: 'Acme' },
            role: 'member',
            authMode: 'github',
        });
        expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /api/version', 'GET /api/auth/me']);
        expect(calls.every((call) => call.authorization === `Bearer ${SECRET}`)).toBe(true);
    });

    it('prints a human summary', async () => {
        const { out, io } = harness(board());
        expect(await run(['auth', 'status'], io)).toBe(0);
        const text = out.join('');
        expect(text).toContain('board    http://board (version 9.9.9)');
        expect(text).toContain('token    set (personal)');
        expect(text).toContain('identity octocat in Acme (member), board auth github');
    });

    it("names each value's source, a settings file by its path, and never prints a token read from it", async () => {
        const path = join(mkdtempSync(join(tmpdir(), 'bellows-settings-')), 'settings.json');
        writeFileSync(path, JSON.stringify({ token: SECRET, readRetries: 1 }), { mode: 0o600 });
        const { out, err, io } = recordingBoard(routed(board()), {
            env: { FACTORY_URL: 'http://board' },
            settings: { path, explicit: true },
        });
        expect(await run(['auth', 'status'], io)).toBe(0);
        const text = out.join('');
        expect(text).toContain('board    http://board (version 9.9.9) [env]');
        expect(text).toContain(`token    set (personal) [${path}]`);
        expect(text).toContain(`requests 30s deadline [default], 1 read retries [${path}]`);
        expect(text + err.join('')).not.toContain(SECRET);
    });

    it('says not signed in when the board answers authenticated:false', async () => {
        const { out, io } = harness(board({ '/api/auth/me': () => json({ authenticated: false }) }));
        expect(await run(['auth', 'status', '--json'], io)).toBe(1);
        const result = envelope(out);
        expect(result.outcome).toBe('refused');
        expect(result.error.message).toMatch(/not signed in.*FACTORY_TOKEN/);
        expect(result.data.config.token.set).toBe(true);
    });

    it('surfaces a refused token as exit 1 with a hint to mint a new one', async () => {
        const { out, io } = harness(
            board({ '/api/auth/me': () => json({ error: 'Invalid access token', code: 'UNAUTHENTICATED' }, 401) })
        );
        expect(await run(['auth', 'status', '--json'], io)).toBe(1);
        const result = envelope(out);
        expect(result.error).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
        expect(result.error.message).toMatch(/mint a new personal token/);
        expect(result.data.board).toEqual({ version: '9.9.9' });
    });

    it("surfaces an org token's 403 as a refusal", async () => {
        const { out, io } = harness(
            board({
                '/api/auth/me': () => json({ error: 'Organization tokens can only read', code: 'FORBIDDEN' }, 403),
            }),
            { FACTORY_URL: 'http://board', FACTORY_TOKEN: 'oat_x' }
        );
        expect(await run(['auth', 'status', '--json'], io)).toBe(1);
        expect(envelope(out).data.config.token.kind).toBe('org');
    });

    it('reports an unreachable board as exit 7, keeping the configuration in data', async () => {
        const { out, io } = harness({});
        io.fetch = (async () => {
            throw new TypeError('fetch failed');
        }) as unknown as typeof globalThis.fetch;
        expect(await run(['auth', 'status', '--json'], { ...io, sleep: async () => {} })).toBe(7);
        const result = envelope(out);
        expect(result.outcome).toBe('unreachable');
        expect(result.data.config.url).toBe('http://board');
        expect(result.data.board).toBeNull();
    });

    it('reports an unavailable board as a refusal', async () => {
        const { io } = harness(board({ '/api/version': () => json({ error: 'down', code: 'UNAVAILABLE' }, 503) }));
        expect(await run(['auth', 'status'], { ...io, sleep: async () => {} })).toBe(1);
    });

    it.each([
        ['signed in', board()],
        ['not signed in', board({ '/api/auth/me': () => json({ authenticated: false }) })],
        ['refused', board({ '/api/auth/me': () => json({ error: 'Invalid access token' }, 401) })],
    ])('never prints the token when %s, human or --json', async (_label, routes) => {
        for (const argv of [
            ['auth', 'status'],
            ['auth', 'status', '--json'],
        ]) {
            const { printed, io } = harness(routes);
            await run(argv, io);
            expect(printed()).not.toContain('s3cr3t');
        }
    });
});

describe('bellows job preflight', () => {
    const READY = {
        ready: true,
        checks: [
            { subject: 'repo', name: 'acme/api', status: 'ok', detail: 'tracked by this board' },
            { subject: 'executor', name: 'mine', status: 'ok', detail: 'user claude' },
        ],
    };
    const BLOCKED = {
        ready: false,
        checks: [
            { subject: 'repo', name: 'acme/nope', status: 'blocked', detail: 'acme/nope is not tracked by this board' },
            { subject: 'executor', name: null, status: 'unverified', detail: 'the board checks it at claim' },
        ],
    };
    const ARGS = ['job', 'preflight', '--repo', 'acme/api', '--executor', 'mine'];

    const preflight = async (answer: () => Response, args: string[] = []) => {
        const h = harness(board({ '/api/jobs/preflight': answer }));
        const code = await run([...ARGS, ...args, '--json'], { ...h.io, sleep: async () => {} });
        return { code, result: envelope(h.out), calls: h.calls, printed: h.printed };
    };

    it('posts the selection to the board and passes its ready verdict through, exit 0', async () => {
        const { code, result, calls } = await preflight(
            () => json(READY),
            [
                '--executor-scope',
                'org',
                '--base-branch',
                'dev',
                '--skill',
                'jira',
                '--connection',
                '3f2b6c1e-0000-4000-8000-000000000001',
            ]
        );
        expect(code).toBe(0);
        expect(result.data).toEqual(READY);
        expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/jobs/preflight']);
        expect(calls[0]!.body).toEqual({
            repo: 'acme/api',
            executor: 'mine',
            executorScope: 'org',
            baseBranch: 'dev',
            skills: ['jira'],
            connections: ['3f2b6c1e-0000-4000-8000-000000000001'],
        });
    });

    it('sends nothing the flags did not name, and makes no other request', async () => {
        const { calls } = await preflight(() => json(READY));
        expect(calls).toHaveLength(1);
        expect(calls[0]!.body).toEqual({ repo: 'acme/api', executor: 'mine' });
    });

    it('is refused, exit 1, naming the first blocked check, when the board says not ready', async () => {
        const { code, result } = await preflight(() => json(BLOCKED));
        expect(code).toBe(1);
        expect(result.outcome).toBe('refused');
        expect(result.data).toEqual(BLOCKED);
        expect(result.error.message).toBe('not ready to launch: acme/nope is not tracked by this board');
    });

    it('prints one line per check for a person, and says the board rechecks', async () => {
        const h = harness(board({ '/api/jobs/preflight': () => json(BLOCKED) }));
        expect(await run(ARGS, h.io)).toBe(1);
        expect(h.out.join('')).toBe(
            [
                'blocked     repo acme/nope  acme/nope is not tracked by this board',
                'unverified  executor  the board checks it at claim',
                '',
            ].join('\n')
        );
        expect(h.err.join('')).toContain('preflight is advisory: the board rechecks at create and at claim');
    });

    it('reports a board error as unreachable, exit 7, never as a refused selection', async () => {
        for (const status of [500, 503]) {
            const { code, result } = await preflight(() => json({ error: 'down', code: 'UNAVAILABLE' }, status));
            expect(code, String(status)).toBe(7);
            expect(result.outcome).toBe('unreachable');
        }
    });

    it('reports a request that never gets an answer as unreachable, exit 7', async () => {
        const h = harness({});
        h.io.fetch = (async () => {
            throw new TypeError('fetch failed');
        }) as unknown as typeof globalThis.fetch;
        expect(await run([...ARGS, '--json'], { ...h.io, sleep: async () => {} })).toBe(7);
        expect(envelope(h.out).outcome).toBe('unreachable');
    });

    it('surfaces a refused credential as the board refusal, exit 1', async () => {
        const { code, result } = await preflight(() =>
            json({ error: 'Sign in required', code: 'UNAUTHENTICATED' }, 401)
        );
        expect(code).toBe(1);
        expect(result.error).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    });

    it('never prints the token', async () => {
        const { printed } = await preflight(() => json(READY));
        expect(printed()).not.toContain(SECRET);
    });
});
