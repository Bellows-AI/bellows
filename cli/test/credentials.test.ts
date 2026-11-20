import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type OAuthCredential, oauthFetch } from '../src/credentials.js';
import { run } from '../src/run.js';
import { realClock } from '../src/transport.js';

const BOARD = 'http://board';
const NOW = Date.parse('2026-11-20T10:00:00.000Z');
const HOUR_MS = 3_600_000;
const TOKEN_PATH = '/api/oauth/token';

const credential = (overrides: Partial<OAuthCredential> = {}): OAuthCredential => ({
    url: BOARD,
    clientId: 'bellows-cli',
    accessToken: 'mat_old',
    refreshToken: 'mrt_old',
    expiresAt: new Date(NOW + HOUR_MS).toISOString(),
    scope: 'factory:full',
    ...overrides,
});
const expiring = () => credential({ expiresAt: new Date(NOW + 30_000).toISOString() });

/** A settings file in a fresh directory, mode 0600, holding `content`. */
function settingsFile(content: Record<string, unknown>): string {
    const path = join(mkdtempSync(join(tmpdir(), 'bellows-cred-')), 'settings.json');
    writeFileSync(path, JSON.stringify(content), { mode: 0o600 });
    return path;
}

const fresh = () =>
    Response.json({
        access_token: 'mat_new',
        refresh_token: 'mrt_new',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'factory:full',
    });

interface Call {
    path: string;
    method: string;
    authorization: string | null;
    form: URLSearchParams | null;
}

/** A board whose token endpoint answers `refresh`, and whose other routes accept only the listed access tokens. */
function fakeBoard({
    refresh = fresh,
    valid = ['mat_old', 'mat_new'],
}: {
    refresh?: () => Response | Promise<Response>;
    valid?: string[];
} = {}) {
    const calls: Call[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        const form = typeof init?.body === 'string' && url.pathname.startsWith('/api/oauth/') ? init.body : null;
        calls.push({
            path: url.pathname,
            method: init?.method ?? 'GET',
            authorization: headers.get('authorization'),
            form: form === null ? null : new URLSearchParams(form),
        });
        if (url.pathname === TOKEN_PATH) return refresh();
        const bearer = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
        return valid.includes(bearer)
            ? Response.json({ ok: true })
            : Response.json({ error: 'Invalid access token', code: 'UNAUTHENTICATED' }, { status: 401 });
    }) as typeof globalThis.fetch;
    return { calls, fetch };
}

const wrap = (path: string, fetch: typeof globalThis.fetch, cred: OAuthCredential, extra = {}) =>
    oauthFetch({
        fetch,
        settingsPath: path,
        credential: cred,
        now: () => NOW,
        sleep: realClock.sleep,
        warn: () => {},
        ...extra,
    });

describe('oauthFetch: refresh', () => {
    it('refreshes ahead of expiry, writes the file atomically at 0600 and keeps the other keys', async () => {
        const path = settingsFile({ url: BOARD, readRetries: 1, oauth: expiring() });
        const board = fakeBoard();

        const response = await wrap(path, board.fetch, expiring())(`${BOARD}/api/tasks`, { method: 'GET' });

        expect(response.status).toBe(200);
        expect(board.calls.map((c) => `${c.method} ${c.path} ${c.authorization}`)).toEqual([
            `POST ${TOKEN_PATH} null`,
            'GET /api/tasks Bearer mat_new',
        ]);
        const form = board.calls[0]!.form!;
        expect(Object.fromEntries(form)).toEqual({
            grant_type: 'refresh_token',
            refresh_token: 'mrt_old',
            client_id: 'bellows-cli',
        });
        const saved = JSON.parse(readFileSync(path, 'utf8'));
        expect(saved).toEqual({
            url: BOARD,
            readRetries: 1,
            oauth: credential({
                accessToken: 'mat_new',
                refreshToken: 'mrt_new',
                expiresAt: new Date(NOW + HOUR_MS).toISOString(),
            }),
        });
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(readdirSync(dirname(path))).toEqual(['settings.json']);
    });

    it('re-issues a GET once after a 401, with the refreshed token', async () => {
        const path = settingsFile({ oauth: credential() });
        const board = fakeBoard({ valid: ['mat_new'] });

        const response = await wrap(path, board.fetch, credential())(`${BOARD}/api/tasks`, { method: 'GET' });

        expect(response.status).toBe(200);
        expect(board.calls.map((c) => `${c.method} ${c.path} ${c.authorization}`)).toEqual([
            'GET /api/tasks Bearer mat_old',
            `POST ${TOKEN_PATH} null`,
            'GET /api/tasks Bearer mat_new',
        ]);
    });

    it('never re-issues an unkeyed write after a 401; a keyed one is re-issued', async () => {
        const path = settingsFile({ oauth: credential() });
        const board = fakeBoard({ valid: ['mat_new'] });
        const fetch = wrap(path, board.fetch, credential());

        const unkeyed = await fetch(`${BOARD}/api/jobs`, { method: 'POST', body: '{}' });
        expect(unkeyed.status).toBe(401);
        expect(board.calls.map((c) => c.path)).toEqual(['/api/jobs']);

        const keyed = await fetch(`${BOARD}/api/jobs`, {
            method: 'POST',
            body: '{}',
            headers: { 'idempotency-key': 'k1' },
        });
        expect(keyed.status).toBe(200);
        expect(board.calls.map((c) => `${c.path} ${c.authorization}`).slice(1)).toEqual([
            '/api/jobs Bearer mat_old',
            `${TOKEN_PATH} null`,
            '/api/jobs Bearer mat_new',
        ]);
    });

    it.each([
        ['a 5xx', () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 })],
        [
            'a network failure',
            () => {
                throw new TypeError('fetch failed');
            },
        ],
        ['a body that is not JSON', () => new Response('<html></html>', { status: 200 })],
        ['a body missing the refresh token', () => Response.json({ access_token: 'mat_new', expires_in: 3600 })],
        [
            'a non-integer expires_in',
            () => Response.json({ access_token: 'mat_new', refresh_token: 'mrt_new', expires_in: 'soon' }),
        ],
    ])('leaves the file byte-identical on %s and fails the request', async (_label, refresh) => {
        const path = settingsFile({ url: BOARD, oauth: expiring() });
        const before = readFileSync(path);
        const board = fakeBoard({ refresh });

        await expect(wrap(path, board.fetch, expiring())(`${BOARD}/api/tasks`, { method: 'GET' })).rejects.toThrow(
            /refresh/
        );

        expect(readFileSync(path).equals(before)).toBe(true);
        expect(board.calls.map((c) => c.path)).toEqual([TOKEN_PATH]);
        expect(existsSync(`${path}.lock`)).toBe(false);
    });

    it.each([
        ['invalid_grant', 400, 'invalid_grant'],
        ['invalid_client', 401, 'invalid_client'],
    ])('keeps the file on %s and answers a 401 naming bellows auth login', async (_label, status, error) => {
        const path = settingsFile({ oauth: expiring() });
        const before = readFileSync(path);
        const board = fakeBoard({ refresh: () => Response.json({ error }, { status }) });

        const response = await wrap(path, board.fetch, expiring())(`${BOARD}/api/tasks`, { method: 'GET' });

        expect(response.status).toBe(401);
        expect(((await response.json()) as { error: string }).error).toContain('bellows auth login');
        expect(readFileSync(path).equals(before)).toBe(true);
        expect(board.calls.map((c) => c.path)).toEqual([TOKEN_PATH]);
    });

    it('two concurrent refreshers make one refresh call; the second uses the stored pair', async () => {
        const path = settingsFile({ oauth: expiring() });
        let refreshes = 0;
        const board = fakeBoard({
            refresh: async () => {
                refreshes++;
                await new Promise((resolve) => setTimeout(resolve, 50));
                return fresh();
            },
        });
        // Two processes: separate wrappers over the same file, each holding the expiring pair in memory.
        const [a, b] = await Promise.all([
            wrap(path, board.fetch, expiring())(`${BOARD}/api/tasks`, { method: 'GET' }),
            wrap(path, board.fetch, expiring())(`${BOARD}/api/tasks`, { method: 'GET' }),
        ]);

        expect([a.status, b.status]).toEqual([200, 200]);
        expect(refreshes).toBe(1);
        const used = board.calls.filter((c) => c.path === '/api/tasks').map((c) => c.authorization);
        expect(used).toEqual(['Bearer mat_new', 'Bearer mat_new']);
    });

    it('bounds the lock wait by the request signal and never removes a lock it does not hold', async () => {
        const path = settingsFile({ oauth: expiring() });
        writeFileSync(`${path}.lock`, '');
        const board = fakeBoard();
        const signal = AbortSignal.timeout(50);
        const started = Date.now();

        await expect(
            wrap(path, board.fetch, expiring())(`${BOARD}/api/tasks`, { method: 'GET', signal })
        ).rejects.toThrow();

        expect(Date.now() - started).toBeLessThan(2000);
        expect(existsSync(`${path}.lock`)).toBe(true);
        expect(board.calls).toEqual([]);
    });

    it('fails, removing nothing, when the lock cannot be inspected for a reason other than ENOENT', async () => {
        const path = settingsFile({ oauth: expiring() });
        writeFileSync(`${path}.lock`, '');
        const board = fakeBoard();
        const stat = () => {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        };

        await expect(
            wrap(path, board.fetch, expiring(), { stat })(`${BOARD}/api/tasks`, { method: 'GET' })
        ).rejects.toThrow(/EACCES/);

        expect(existsSync(`${path}.lock`)).toBe(true);
        expect(board.calls).toEqual([]);
    });

    it('takes over a lock older than 30 s', async () => {
        const path = settingsFile({ oauth: expiring() });
        writeFileSync(`${path}.lock`, '');
        const old = new Date(Date.now() - 60_000);
        utimesSync(`${path}.lock`, old, old);
        const board = fakeBoard();

        const response = await wrap(path, board.fetch, expiring())(`${BOARD}/api/tasks`, { method: 'GET' });

        expect(response.status).toBe(200);
        expect(existsSync(`${path}.lock`)).toBe(false);
    });
});

/** A board for whole-CLI runs: version and identity answer, the revoke endpoint answers `revoke`. */
function cliBoard(revoke: () => Response = () => new Response(null, { status: 200 })) {
    const calls: Call[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        calls.push({
            path: url.pathname,
            method: init?.method ?? 'GET',
            authorization: headers.get('authorization'),
            form: typeof init?.body === 'string' ? new URLSearchParams(init.body) : null,
        });
        if (url.pathname === '/api/oauth/revoke') return revoke();
        if (url.pathname === '/api/version') return Response.json({ version: '9.9.9' });
        return Response.json({
            authenticated: true,
            user: { id: 'u1', login: 'octocat', name: null },
            role: 'member',
            organization: { id: 'o1', name: 'Acme' },
            mode: 'github',
        });
    }) as typeof globalThis.fetch;
    return { calls, fetch };
}

async function cli(argv: string[], path: string, env: NodeJS.ProcessEnv, board = cliBoard()) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, {
        env,
        settings: { path, explicit: false },
        fetch: board.fetch,
        now: () => NOW,
        sleep: async () => {},
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
    });
    return { code, out: out.join(''), err: err.join(''), calls: board.calls };
}

describe('which credential a request carries', () => {
    it('carries the stored mat_ only to the board it was issued by', async () => {
        const path = settingsFile({ oauth: credential() });

        const same = await cli(['auth', 'status'], path, { FACTORY_URL: BOARD });
        expect(same.code).toBe(0);
        expect(same.calls.every((c) => c.authorization === 'Bearer mat_old')).toBe(true);

        const other = await cli(['auth', 'status'], path, { FACTORY_URL: 'http://other-board' });
        expect(other.calls.every((c) => c.authorization === null)).toBe(true);
        expect(other.out + other.err).not.toContain('mat_old');
    });

    it('lets FACTORY_TOKEN and a file token win over the stored sign-in', async () => {
        const path = settingsFile({ oauth: credential() });
        const env = await cli(['auth', 'status'], path, { FACTORY_URL: BOARD, FACTORY_TOKEN: 'fat_env' });
        expect(env.calls.every((c) => c.authorization === 'Bearer fat_env')).toBe(true);

        const filed = settingsFile({ token: 'fat_file', oauth: credential() });
        const file = await cli(['auth', 'status'], filed, { FACTORY_URL: BOARD });
        expect(file.calls.every((c) => c.authorization === 'Bearer fat_file')).toBe(true);
    });
});

describe('bellows auth logout', () => {
    it('revokes the refresh token, then clears only the oauth entry', async () => {
        const path = settingsFile({ url: BOARD, readRetries: 2, oauth: credential() });

        const result = await cli(['auth', 'logout'], path, {});

        expect(result.code).toBe(0);
        expect(result.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/oauth/revoke']);
        expect(Object.fromEntries(result.calls[0]!.form!)).toEqual({ token: 'mrt_old', client_id: 'bellows-cli' });
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ url: BOARD, readRetries: 2 });
    });

    it.each([
        ['a 5xx', () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 })],
        ['a refusal', () => Response.json({ error: 'invalid_request' }, { status: 400 })],
    ])('keeps the tokens on %s and ends unreachable, pointing at Connected apps', async (_label, revoke) => {
        const path = settingsFile({ url: BOARD, oauth: credential() });
        const before = readFileSync(path);

        const result = await cli(['auth', 'logout'], path, {}, cliBoard(revoke));

        expect(result.code).toBe(7);
        expect(result.err).toContain('Connected apps');
        expect(readFileSync(path).equals(before)).toBe(true);
    });
});
