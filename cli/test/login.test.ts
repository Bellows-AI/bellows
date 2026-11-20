import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoginError, pkceChallenge, signIn } from '../src/login.js';
import { run } from '../src/run.js';
import { BoardError, NO_RESPONSE_STATUS } from '../src/transport.js';

const BOARD = 'http://board';
const ISSUER = 'http://board.example';
const NOW = Date.parse('2026-11-20T10:00:00.000Z');

const metadata = () => Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/oauth/authorize` });
const tokens = () =>
    Response.json({
        access_token: 'mat_a',
        refresh_token: 'mrt_a',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'factory:full',
    });

interface Sent {
    path: string;
    method: string;
    form: URLSearchParams | null;
}

/** The board's preflight and token endpoint, recorded. */
function fakeBoard(preflight: () => Response = metadata, token: () => Response = tokens) {
    const sent: Sent[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        sent.push({
            path: url.pathname,
            method: init?.method ?? 'GET',
            form: typeof init?.body === 'string' ? new URLSearchParams(init.body) : null,
        });
        if (url.pathname === '/.well-known/oauth-authorization-server') return preflight();
        if (url.pathname === '/api/oauth/token') return token();
        return Response.json({ error: 'nope' }, { status: 404 });
    }) as typeof globalThis.fetch;
    return { sent, fetch };
}

/** A browser that follows the authorize URL straight to the CLI's callback with `params`, recording what it saw. */
function browser(params: (authorize: URL) => Record<string, string>) {
    const seen: { authorize: URL | null; answer: Promise<string> | null } = { authorize: null, answer: null };
    const open = async (url: string) => {
        const authorize = new URL(url);
        seen.authorize = authorize;
        const callback = new URL(authorize.searchParams.get('redirect_uri')!);
        for (const [key, value] of Object.entries(params(authorize))) callback.searchParams.set(key, value);
        // The page the person sees; the sign-in does not wait for the browser to read it.
        seen.answer = globalThis.fetch(callback).then((response) => response.text());
        await seen.answer;
    };
    return { seen, open };
}

const approved = (authorize: URL) => ({ code: 'c1', state: authorize.searchParams.get('state')!, iss: ISSUER });

const options = (board: ReturnType<typeof fakeBoard>, openBrowser: (url: string) => Promise<void>, extra = {}) => ({
    url: BOARD,
    fetch: board.fetch,
    now: () => NOW,
    openBrowser,
    stderr: () => {},
    ...extra,
});

/** Whether anything still listens at the callback the authorize URL named. */
async function listening(authorize: URL): Promise<boolean> {
    try {
        await globalThis.fetch(authorize.searchParams.get('redirect_uri')!);
        return true;
    } catch {
        return false;
    }
}

describe('pkceChallenge', () => {
    it('matches the RFC 7636 appendix B vector', () => {
        expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
            'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
        );
    });
});

describe('signIn', () => {
    it('answers one callback, closes, and exchanges the code with no resource or scope', async () => {
        const board = fakeBoard();
        const { seen, open } = browser(approved);

        const credential = await signIn(options(board, open));

        expect(credential).toEqual({
            url: BOARD,
            clientId: 'bellows-cli',
            accessToken: 'mat_a',
            refreshToken: 'mrt_a',
            expiresAt: new Date(NOW + 3_600_000).toISOString(),
            scope: 'factory:full',
        });
        const authorize = seen.authorize!;
        expect(`${authorize.origin}${authorize.pathname}`).toBe(`${BOARD}/api/oauth/authorize`);
        expect(authorize.searchParams.get('client_id')).toBe('bellows-cli');
        expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
        expect(authorize.searchParams.has('resource')).toBe(false);
        expect(authorize.searchParams.has('scope')).toBe(false);
        const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
        expect(redirect.hostname).toBe('127.0.0.1');
        expect(redirect.pathname).toBe('/callback');
        expect(await seen.answer).toMatch(/signed in/i);

        const exchange = board.sent.find((s) => s.path === '/api/oauth/token')!;
        const form = Object.fromEntries(exchange.form!);
        expect(form).toEqual({
            grant_type: 'authorization_code',
            code: 'c1',
            client_id: 'bellows-cli',
            redirect_uri: redirect.toString(),
            code_verifier: expect.any(String),
        });
        expect(pkceChallenge(form.code_verifier!)).toBe(authorize.searchParams.get('code_challenge'));
        expect(await listening(authorize)).toBe(false);
    });

    it.each([
        ['a wrong state', (a: URL) => ({ ...approved(a), state: 'forged' }), /state/],
        ['an iss mismatch', (a: URL) => ({ ...approved(a), iss: 'http://evil.example' }), /iss/],
        [
            'access_denied',
            (a: URL) => ({ error: 'access_denied', state: a.searchParams.get('state')!, iss: ISSUER }),
            /denied/,
        ],
    ])('fails on %s, closes the listener and exchanges nothing', async (_label, params, message) => {
        const board = fakeBoard();
        const { seen, open } = browser(params);

        const failure = await signIn(options(board, open)).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(LoginError);
        expect((failure as Error).message).toMatch(message);
        expect(board.sent.map((s) => s.path)).toEqual(['/.well-known/oauth-authorization-server']);
        expect(await listening(seen.authorize!)).toBe(false);
    });

    it('ends timeout at the deadline and interrupted on the signal, closing the listener both times', async () => {
        let authorize: URL | null = null;
        const idle = async (url: string) => {
            authorize = new URL(url);
        };
        const timedOut = await signIn(options(fakeBoard(), idle, { timeoutMs: 50 })).catch((e: unknown) => e);
        expect(timedOut).toBeInstanceOf(LoginError);
        expect((timedOut as LoginError).outcome).toBe('timeout');
        expect(await listening(authorize!)).toBe(false);

        const interrupt = new AbortController();
        const pending = signIn(options(fakeBoard(), idle, { signal: interrupt.signal })).catch((e: unknown) => e);
        await new Promise((resolve) => setTimeout(resolve, 50));
        interrupt.abort();
        const interrupted = await pending;
        expect(interrupted).toBeInstanceOf(LoginError);
        expect((interrupted as LoginError).outcome).toBe('interrupted');
        expect(await listening(authorize!)).toBe(false);
    });

    it.each([
        ['a 404', () => Response.json({ error: 'not found' }, { status: 404 })],
        [
            'an HTML page',
            () => new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } }),
        ],
    ])('refuses on a preflight %s without opening the browser', async (_label, preflight) => {
        let opened = false;
        const failure = await signIn(
            options(fakeBoard(preflight), async () => {
                opened = true;
            })
        ).catch((e: unknown) => e);

        expect(failure).toBeInstanceOf(LoginError);
        expect((failure as LoginError).outcome).toBe('refused');
        expect((failure as Error).message).toMatch(/no OAuth sign-in/);
        expect((failure as Error).message).toContain('FACTORY_TOKEN');
        expect(opened).toBe(false);
    });

    it('reports a preflight 5xx as unreachable without opening the browser', async () => {
        let opened = false;
        const failure = await signIn(
            options(
                fakeBoard(() => Response.json({ error: 'down' }, { status: 503 })),
                async () => {
                    opened = true;
                }
            )
        ).catch((e: unknown) => e);

        expect(failure).toBeInstanceOf(BoardError);
        expect((failure as BoardError).status).toBe(NO_RESPONSE_STATUS);
        expect(opened).toBe(false);
    });
});

describe('bellows auth login', () => {
    const settingsPath = () => join(mkdtempSync(join(tmpdir(), 'bellows-login-')), 'nested', 'settings.json');

    async function login(
        path: string,
        env: NodeJS.ProcessEnv,
        open: (url: string) => Promise<void>,
        board = fakeBoard()
    ) {
        const out: string[] = [];
        const err: string[] = [];
        const code = await run(['auth', 'login'], {
            env,
            settings: { path, explicit: false },
            fetch: board.fetch,
            now: () => NOW,
            openBrowser: open,
            stdout: (text) => out.push(text),
            stderr: (text) => err.push(text),
        });
        return { code, out: out.join(''), err: err.join('') };
    }

    it('saves the sign-in at 0600 in a new 0700 directory and prints the URL, never the tokens', async () => {
        const path = settingsPath();
        const { open } = browser(approved);

        const result = await login(path, { FACTORY_URL: BOARD }, open);

        expect(result.code).toBe(0);
        expect(JSON.parse(readFileSync(path, 'utf8')).oauth).toMatchObject({ url: BOARD, accessToken: 'mat_a' });
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
        expect(result.err).toContain(`${BOARD}/api/oauth/authorize?`);
        expect(result.out + result.err).not.toContain('mat_a');
        expect(result.out + result.err).not.toContain('mrt_a');
    });

    it('warns when FACTORY_TOKEN shadows the new sign-in', async () => {
        const { open } = browser(approved);
        const result = await login(settingsPath(), { FACTORY_URL: BOARD, FACTORY_TOKEN: 'fat_x' }, open);
        expect(result.code).toBe(0);
        expect(result.err).toMatch(/FACTORY_TOKEN .*wins/);
    });

    it('exits 1 with the refusal when the board offers no OAuth sign-in, and 7 when it cannot answer', async () => {
        const open = async () => {};
        const none = await login(
            settingsPath(),
            { FACTORY_URL: BOARD },
            open,
            fakeBoard(() => Response.json({}, { status: 404 }))
        );
        expect(none.code).toBe(1);
        expect(none.err).toMatch(/no OAuth sign-in/);

        const down = await login(
            settingsPath(),
            { FACTORY_URL: BOARD },
            open,
            fakeBoard(() => Response.json({}, { status: 502 }))
        );
        expect(down.code).toBe(7);
    });
});
