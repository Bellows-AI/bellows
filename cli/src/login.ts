/**
 * `bellows auth login`: the board's OAuth authorization code flow for a native app (RFC 8252) —
 * PKCE S256, a one-shot listener on `127.0.0.1`, the browser for consent — as the board's built-in
 * client `bellows-cli` (docs/auth.md). The CLI sends no `resource` or `scope`: the board's built-in
 * defaults apply, so a `PUBLIC_URL` that differs from `FACTORY_URL` cannot cause a mismatch.
 *
 * The board must have MCP enabled: its authorization server exists exactly then. The preflight
 * reads the metadata document first, so a board without one refuses before a browser opens.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { parseArgs } from 'node:util';
import { type CliConfig, loadCliConfig, type SettingsFile } from './config.js';
import {
    authLogoutCommand,
    oauthFetch,
    CLI_CLIENT_ID,
    FORM_CONTENT_TYPE,
    grantOf,
    type OAuthCredential,
    saveOAuth,
    TOKEN_PATH,
} from './credentials.js';
import { noArguments, parseOrUsage, UsageError } from './input.js';
import { OUTCOME, type Outcome } from './outcome.js';
import type { CommandResult } from './outcome.js';
import { BoardError, type BoardClock, NO_RESPONSE_STATUS, realClock } from './transport.js';
import { CONTENT_TYPE_HEADER } from './http.js';
import { USAGE } from './usage.js';

const METADATA_PATH = '/.well-known/oauth-authorization-server';
const AUTHORIZE_PATH = '/api/oauth/authorize';
const CALLBACK_PATH = '/callback';
const LOOPBACK = '127.0.0.1';
/** The whole sign-in — preflight, the person's consent, the exchange — ends by this deadline. */
export const LOGIN_TIMEOUT_MS = 300_000;
const VERIFIER_BYTES = 32;
const STATE_BYTES = 16;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;

const NOT_OFFERED =
    'this board has no OAuth sign-in (MCP is not enabled); use FACTORY_TOKEN with a personal token from its settings page';

/** A sign-in that ended without a credential, and how the command ends because of it. */
export class LoginError extends Error {
    readonly outcome: Outcome;

    constructor(message: string, outcome: Outcome) {
        super(message);
        this.name = 'LoginError';
        this.outcome = outcome;
    }
}

const base64url = (bytes: Buffer): string => bytes.toString('base64url');

/** The S256 code challenge of a verifier (RFC 7636 section 4.2). */
export function pkceChallenge(verifier: string): string {
    return base64url(createHash('sha256').update(verifier).digest());
}

/** The platform's URL opener; resolves once it started, rejects when it could not be spawned. */
export function openInBrowser(url: string): Promise<void> {
    const [command, args] =
        process.platform === 'darwin'
            ? ['open', [url]]
            : process.platform === 'win32'
              ? ['cmd', ['/c', 'start', '""', url]]
              : ['xdg-open', [url]];
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'ignore', detached: true });
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
}

export interface SignInOptions {
    url: string;
    fetch: typeof globalThis.fetch;
    now: () => number;
    signal?: AbortSignal | undefined;
    openBrowser: (url: string) => Promise<void>;
    stderr: (text: string) => void;
    timeoutMs?: number | undefined;
}

/** The authorization server's issuer, or a refusal: only a 404 or an HTML 200 means "not offered". */
async function preflight(url: string, fetch: typeof globalThis.fetch, signal: AbortSignal): Promise<string> {
    let response: Response;
    let text: string;
    try {
        response = await fetch(`${url}${METADATA_PATH}`, { signal });
        text = await response.text();
    } catch (error) {
        if (signal.aborted) throw error;
        throw new BoardError(`cannot reach ${url}: ${(error as Error).message}`, NO_RESPONSE_STATUS, null);
    }
    if (response.status === HTTP_NOT_FOUND) throw new LoginError(NOT_OFFERED, OUTCOME.refused);
    if (response.status !== HTTP_OK) {
        throw new BoardError(`${METADATA_PATH} answered ${response.status}`, NO_RESPONSE_STATUS, null);
    }
    let issuer: unknown;
    try {
        issuer = (JSON.parse(text) as { issuer?: unknown } | null)?.issuer;
    } catch {
        // The SPA fallback answers HTML where the document is not registered.
        throw new LoginError(NOT_OFFERED, OUTCOME.refused);
    }
    if (typeof issuer !== 'string' || issuer === '') {
        throw new BoardError(`${METADATA_PATH} answered without an issuer`, NO_RESPONSE_STATUS, null);
    }
    return issuer;
}

/** The callback's verdict on one request: the code, or why the sign-in failed. */
function verdictOf(params: URLSearchParams, expect: { state: string; issuer: string }): string | LoginError {
    if (params.get('state') !== expect.state) {
        return new LoginError('the sign-in callback carried the wrong state; nothing was saved', OUTCOME.refused);
    }
    if (params.get('iss') !== expect.issuer) {
        return new LoginError(
            'the sign-in callback came from another issuer (iss); nothing was saved',
            OUTCOME.refused
        );
    }
    const error = params.get('error');
    if (error === 'access_denied') return new LoginError('the sign-in was denied on the board', OUTCOME.refused);
    const code = params.get('code');
    if (error || !code) return new LoginError(`the board refused the sign-in: ${error ?? 'no code'}`, OUTCOME.refused);
    return code;
}

/** Listens on a free loopback port; `settle` is called once, for the first request to the callback path. */
function listen(onCallback: (params: URLSearchParams) => { ok: boolean }, onError: (error: Error) => void) {
    const server: Server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', `http://${LOOPBACK}`);
        if (url.pathname !== CALLBACK_PATH) {
            response.writeHead(HTTP_NOT_FOUND).end();
            return;
        }
        const { ok } = onCallback(url.searchParams);
        response
            .writeHead(ok ? HTTP_OK : HTTP_BAD_REQUEST, {
                [CONTENT_TYPE_HEADER]: 'text/plain; charset=utf-8',
                connection: 'close',
            })
            .end(ok ? 'Signed in to Bellows. You can close this tab.\n' : 'Sign-in failed. Return to the terminal.\n');
    });
    server.on('error', onError);
    server.on('clientError', (_error, socket) => socket.destroy());
    return new Promise<{ server: Server; port: number }>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, LOOPBACK, () => {
            const address = server.address();
            if (address && typeof address === 'object') resolve({ server, port: address.port });
            else reject(new Error('the sign-in listener has no port'));
        });
    });
}

/** The code exchange: a form post with the exact redirect URI and the verifier, read under the signal. */
async function exchange(
    options: SignInOptions,
    form: { code: string; redirectUri: string; verifier: string },
    signal: AbortSignal
): Promise<OAuthCredential> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: form.code,
        client_id: CLI_CLIENT_ID,
        redirect_uri: form.redirectUri,
        code_verifier: form.verifier,
    });
    let response: Response;
    let text: string;
    try {
        response = await options.fetch(`${options.url}${TOKEN_PATH}`, {
            method: 'POST',
            headers: { [CONTENT_TYPE_HEADER]: FORM_CONTENT_TYPE },
            body: body.toString(),
            signal,
        });
        text = await response.text();
    } catch (error) {
        if (signal.aborted) throw error;
        throw new BoardError(`cannot reach ${options.url}: ${(error as Error).message}`, NO_RESPONSE_STATUS, null);
    }
    let parsed: unknown = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        // Classified below as a refusal without a usable body.
    }
    const grant = response.status === HTTP_OK ? grantOf(parsed, { url: options.url, now: options.now() }) : null;
    if (grant) return grant;
    const code = (parsed as { error?: unknown } | null)?.error;
    throw new BoardError(
        `the board did not issue a sign-in (${TOKEN_PATH} answered ${response.status})`,
        response.status,
        typeof code === 'string' ? code : null
    );
}

/**
 * One sign-in, start to finish. The listener answers its first callback and closes; a wrong
 * `state`, a foreign `iss`, a denial, the deadline and the signal all end it, and every path
 * closes the listener and clears the timer. The browser never opens when the preflight refuses.
 */
export async function signIn(options: SignInOptions): Promise<OAuthCredential> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
    let server: Server | null = null;
    const ended = (error: unknown): never => {
        if (options.signal?.aborted) throw new LoginError('interrupted — no sign-in was saved', OUTCOME.interrupted);
        if (deadline.signal.aborted) {
            throw new LoginError(
                'the sign-in was not completed within its deadline; nothing was saved',
                OUTCOME.timeout
            );
        }
        throw error;
    };
    try {
        const issuer = await preflight(options.url, options.fetch, signal).catch(ended);
        const verifier = base64url(randomBytes(VERIFIER_BYTES));
        const state = base64url(randomBytes(STATE_BYTES));
        let settled = false;
        let resolveCode!: (code: string) => void;
        let rejectCode!: (error: unknown) => void;
        const code = new Promise<string>((resolve, reject) => {
            resolveCode = resolve;
            rejectCode = reject;
        });
        const settle = (outcome: string | Error) => {
            if (settled) return;
            settled = true;
            if (typeof outcome === 'string') resolveCode(outcome);
            else rejectCode(outcome);
        };
        const onAbort = () => settle(new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            const listening = await listen(
                (params) => {
                    if (settled) return { ok: false };
                    const verdict = verdictOf(params, { state, issuer });
                    settle(verdict);
                    return { ok: typeof verdict === 'string' };
                },
                (error) => settle(error)
            );
            server = listening.server;
            const redirectUri = `http://${LOOPBACK}:${listening.port}${CALLBACK_PATH}`;
            const authorize = new URL(`${options.url}${AUTHORIZE_PATH}`);
            authorize.search = new URLSearchParams({
                response_type: 'code',
                client_id: CLI_CLIENT_ID,
                redirect_uri: redirectUri,
                code_challenge: pkceChallenge(verifier),
                code_challenge_method: 'S256',
                state,
            }).toString();
            options.stderr(`open this URL to sign in (the browser should open it):\n  ${authorize.toString()}\n`);
            options.openBrowser(authorize.toString()).catch((error: unknown) => {
                const reason = error instanceof Error ? error.message : String(error);
                settle(new LoginError(`could not open a browser (${reason}); nothing was saved`, OUTCOME.refused));
            });
            const received = await code.catch(ended);
            return await exchange(options, { code: received, redirectUri, verifier }, signal).catch(ended);
        } finally {
            signal.removeEventListener('abort', onAbort);
        }
    } finally {
        clearTimeout(timer);
        server?.close();
        server?.closeAllConnections();
    }
}

/**
 * The command: sign in against the configured board, save the pair, and say which credential wins
 * when a token shadows it. A failed sign-in leaves the file as it was.
 */
export async function authLoginCommand(
    args: readonly string[],
    config: CliConfig,
    io: Omit<SignInOptions, 'url' | 'timeoutMs'> & { settingsPath: string }
): Promise<CommandResult> {
    const options = { json: { type: 'boolean', default: false } } as const;
    const parsed = parseOrUsage(() => parseArgs({ args: [...args], allowPositionals: true, options }));
    if (parsed.positionals.length > 0) throw new UsageError(`auth login takes no arguments\n\n${USAGE}`);
    let credential: OAuthCredential;
    try {
        credential = await signIn({ ...io, url: config.url });
    } catch (error) {
        if (!(error instanceof LoginError) || error.outcome === OUTCOME.interrupted) throw error;
        return {
            outcome: error.outcome,
            error: { message: error.message, code: null, status: null },
            stderr: `error: ${error.message}\n`,
        };
    }
    saveOAuth(io.settingsPath, credential);
    const shadow =
        config.sources.token === 'env'
            ? 'FACTORY_TOKEN is set and wins over this sign-in; unset it to use the sign-in\n'
            : config.credential === 'token'
              ? `the token in ${config.sources.token} wins over this sign-in; remove it to use the sign-in\n`
              : '';
    return {
        outcome: OUTCOME.ok,
        data: { url: config.url, expiresAt: credential.expiresAt, scope: credential.scope, shadowed: shadow !== '' },
        stdout: `signed in to ${config.url}; saved in ${io.settingsPath} (access renews until the grant is ended)\n`,
        ...(shadow ? { stderr: `warning: ${shadow}` } : {}),
    };
}

/** The slice of the command io the sign-in reads; the command surface's io extends it. */
export interface AuthIo {
    env: NodeJS.ProcessEnv;
    settings: SettingsFile;
    fetch?: typeof globalThis.fetch | undefined;
    now?: (() => number) | undefined;
    sleep?: BoardClock['sleep'] | undefined;
    signal?: AbortSignal | undefined;
    /** Opens the sign-in URL for `auth login` — injected so tests drive the consent themselves. */
    openBrowser?: ((url: string) => Promise<void>) | undefined;
    stderr(text: string): void;
}

/**
 * The fetch a board client sends with: the stored sign-in's when the configuration selected it —
 * refreshed under each attempt's own signal — else `io.fetch` as is.
 */
export function credentialFetch(config: CliConfig, io: AuthIo): typeof globalThis.fetch | undefined {
    if (config.credential !== 'oauth' || !config.oauth) return io.fetch;
    return oauthFetch({
        fetch: io.fetch ?? globalThis.fetch,
        settingsPath: io.settings.path,
        credential: config.oauth,
        now: io.now ?? realClock.now,
        sleep: io.sleep ?? realClock.sleep,
        warn: io.stderr,
    });
}

/** `auth login` and `auth logout`, keyed as the command table spells them. */
export const authCommands: Record<string, (args: readonly string[], io: AuthIo) => Promise<CommandResult>> = {
    'auth login': (args, io) =>
        authLoginCommand(args, loadCliConfig(io.env, io.settings), {
            fetch: io.fetch ?? globalThis.fetch,
            now: io.now ?? realClock.now,
            signal: io.signal,
            openBrowser: io.openBrowser ?? openInBrowser,
            stderr: io.stderr,
            settingsPath: io.settings.path,
        }),
    'auth logout': async (args, io) => {
        noArguments(args, 'auth logout');
        return authLogoutCommand(loadCliConfig(io.env, io.settings), io, io.settings.path);
    },
};
