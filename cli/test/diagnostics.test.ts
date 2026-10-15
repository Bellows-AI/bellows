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

const workspace = (overrides: Record<string, unknown> = {}) => ({
    root: '/ws/o1/u1',
    repos: [
        { owner: 'acme', name: 'api', status: 'ready', error: null },
        { owner: 'acme', name: 'web', status: 'cloning', error: null },
        { owner: 'acme', name: 'old', status: 'failed', error: 'clone refused' },
    ],
    orphaned: [],
    executors: [
        { name: 'mine', type: 'claude', suspended: false },
        { name: 'paused', type: 'claude', suspended: true },
    ],
    orgExecutors: [{ name: 'team', type: 'opencode', suspended: false }],
    defaultExecutor: { scope: 'user', name: 'mine' },
    ...overrides,
});

const skills = [
    { name: 'plain', description: 'Nothing needed', requires: { tools: [], connections: [] } },
    {
        name: 'jira',
        description: 'Work Jira items',
        requires: { tools: [], connections: [{ name: 'jira', env: [], selectedBy: 'jiraConnection' }] },
    },
    {
        name: 'gh',
        description: 'GitHub',
        requires: { tools: [], connections: [{ name: 'github', env: ['GH_TOKEN'], selectedBy: null }] },
    },
];

const CONNECTION = '3f2b6c1e-0000-4000-8000-000000000001';
const connections = [
    {
        id: CONNECTION,
        kind: 'jira',
        site: 'acme.atlassian.net',
        email: 'a@acme.test',
        access: 'read',
        scope: 'org',
        createdAt: '',
    },
];

const board = (overrides: Record<string, () => Response> = {}) => ({
    '/api/version': () => json({ version: '9.9.9' }),
    '/api/auth/me': () => json(me),
    '/api/workspace': () => json(workspace()),
    '/api/skills': () => json({ skills }),
    '/api/connections': () => json({ connections }),
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
    const preflight = async (args: string[], routes = board()) => {
        const h = harness(routes);
        const code = await run(['job', 'preflight', ...args, '--json'], h.io);
        return { code, result: envelope(h.out), calls: h.calls, printed: h.printed };
    };

    it('passes a ready selection, reading only the workspace when nothing else is selected', async () => {
        const { code, result, calls } = await preflight(['--repo', 'acme/api', '--executor', 'mine']);
        expect(code).toBe(0);
        expect(result.data.ready).toBe(true);
        expect(result.data.checks).toEqual([
            { subject: 'repo', name: 'acme/api', status: 'ok', detail: 'synced and ready' },
            { subject: 'executor', name: 'mine', status: 'ok', detail: 'user claude' },
        ]);
        expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /api/workspace']);
    });

    it('reads skills and connections only when they are selected, and never writes', async () => {
        const { code, calls } = await preflight([
            '--repo',
            'acme/api',
            '--executor',
            'team',
            '--executor-scope',
            'org',
            '--skill',
            'plain',
            '--skill',
            'jira',
            '--jira-connection',
            CONNECTION,
        ]);
        expect(code).toBe(0);
        expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
            'GET /api/workspace',
            'GET /api/skills',
            'GET /api/connections',
        ]);
    });

    it.each([
        ['no --repo', [], 'repo', /pass --repo/],
        ['a repo outside the selection', ['--repo', 'acme/nope'], 'repo', /not in your selected repositories/],
        ['a repo still cloning', ['--repo', 'acme/web'], 'repo', /acme\/web is cloning/],
        ['a repo whose clone failed', ['--repo', 'acme/old'], 'repo', /failed, not synced yet: clone refused/],
        ['an unknown executor', ['--repo', 'acme/api', '--executor', 'ghost'], 'executor', /no user executor ghost/],
        ['a suspended executor', ['--repo', 'acme/api', '--executor', 'paused'], 'executor', /suspended/],
        [
            'a personal name under the org scope',
            ['--repo', 'acme/api', '--executor', 'mine', '--executor-scope', 'org'],
            'executor',
            /no org executor mine/,
        ],
        [
            'an uninstalled skill',
            ['--repo', 'acme/api', '--executor', 'mine', '--skill', 'ghost'],
            'skill',
            /not installed/,
        ],
        [
            'a Jira skill with no connection',
            ['--repo', 'acme/api', '--executor', 'mine', '--skill', 'jira'],
            'skill',
            /pass --jira-connection/,
        ],
        [
            'a connection not available to you',
            ['--repo', 'acme/api', '--executor', 'mine', '--jira-connection', 'other'],
            'connection',
            /no such Jira connection/,
        ],
    ])('blocks %s, exit 1, naming why', async (_label, args, subject, detail) => {
        const { code, result } = await preflight(args);
        expect(code).toBe(1);
        expect(result.outcome).toBe('refused');
        expect(result.data.ready).toBe(false);
        const blocked = result.data.checks.find((check: { status: string }) => check.status === 'blocked');
        expect(blocked.subject).toBe(subject);
        expect(blocked.detail).toMatch(detail);
        expect(result.error.message).toMatch(detail);
    });

    it('blocks when no --executor is named: the board applies no default at create', async () => {
        const { code, result } = await preflight(['--repo', 'acme/api']);
        expect(code).toBe(1);
        expect(result.data.checks[1]).toEqual({
            subject: 'executor',
            name: null,
            status: 'blocked',
            detail: 'no executor selected: pass --executor (your default is user mine)',
        });
    });

    it('blocks a suspended default executor when none is named', async () => {
        const { code, result } = await preflight(
            ['--repo', 'acme/api'],
            board({ '/api/workspace': () => json(workspace({ defaultExecutor: { scope: 'user', name: 'paused' } })) })
        );
        expect(code).toBe(1);
        expect(result.data.checks[1]).toMatchObject({ subject: 'executor', status: 'blocked' });
    });

    it('leaves an env-connection requirement unverified, not blocked', async () => {
        const { code, result } = await preflight(['--repo', 'acme/api', '--executor', 'mine', '--skill', 'gh']);
        expect(code).toBe(0);
        expect(result.data.checks).toContainEqual({
            subject: 'skill',
            name: 'gh',
            status: 'unverified',
            detail: 'needs the github connection; the board checks it at claim',
        });
    });

    it('leaves the repo unverified on a board with workspaces off', async () => {
        const { code, result } = await preflight(
            ['--executor', 'mine'],
            board({ '/api/workspace': () => json(workspace({ root: null, repos: [] })) })
        );
        expect(code).toBe(0);
        expect(result.data.checks[0]).toMatchObject({ subject: 'repo', status: 'unverified' });
    });

    it('surfaces an unauthorized identity as the board refusal', async () => {
        const { code, result } = await preflight(
            ['--repo', 'acme/api'],
            board({ '/api/workspace': () => json({ error: 'Invalid access token', code: 'UNAUTHENTICATED' }, 401) })
        );
        expect(code).toBe(1);
        expect(result.error).toMatchObject({ status: 401 });
    });

    it('prints one line per check for a person, and says the board rechecks', async () => {
        const { out, err, io } = harness(board());
        expect(await run(['job', 'preflight', '--repo', 'acme/web', '--executor', 'mine'], io)).toBe(1);
        expect(out.join('')).toContain('blocked     repo acme/web  acme/web is cloning, not synced yet');
        expect(err.join('')).toContain('the board rechecks at create and at claim');
    });

    it('never prints the token', async () => {
        const { printed } = await preflight(['--repo', 'acme/web']);
        expect(printed()).not.toContain('s3cr3t');
    });

    it("is advisory: a selection that changes after preflight is the board's refusal at create", async () => {
        let status = 'ready';
        const routes = board({
            '/api/workspace': () => json(workspace({ repos: [{ owner: 'acme', name: 'api', status, error: null }] })),
            // The board's own recheck at create, against the state at that moment.
            '/api/jobs': () =>
                status === 'ready'
                    ? json({ id: 'job-1', status: 'queued' }, 201)
                    : json({ error: 'acme/api is cloning, not synced yet.', code: 'REPO_NOT_READY' }, 409),
        });
        const first = harness(routes);
        expect(await run(['job', 'preflight', '--repo', 'acme/api', '--executor', 'mine'], first.io)).toBe(0);

        status = 'cloning';
        const launch = harness(routes);
        expect(await run(['job', 'create', '--repo', 'acme/api', '--json', '--', 'npm test'], launch.io)).toBe(1);
        expect(envelope(launch.out).error).toMatchObject({ code: 'REPO_NOT_READY', status: 409 });
        // Re-running preflight now names the same change the board refused on.
        const again = harness(routes);
        expect(await run(['job', 'preflight', '--repo', 'acme/api', '--executor', 'mine'], again.io)).toBe(1);
    });
});
