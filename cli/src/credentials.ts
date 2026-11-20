/**
 * The stored OAuth sign-in (`bellows auth login`): the `oauth` entry of the settings file, written
 * atomically, refreshed under a lockfile, and revoked by `bellows auth logout` (docs/auth.md).
 *
 * The refresh runs inside the transport's fetch, under the attempt's own signal, so it inherits the
 * attempt deadline and a local interrupt. Only a JSON `invalid_grant` (400) or `invalid_client` (401)
 * is a definite "this grant is dead"; every other answer — a 5xx, no answer, a body that is not a
 * full token pair — is inconclusive, and an inconclusive refresh neither writes nor deletes anything.
 */

import { randomUUID } from 'node:crypto';
import {
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { type CliConfig, OAUTH_KEY, parseOAuth } from './config.js';
import { CONTENT_TYPE_HEADER, IDEMPOTENCY_KEY_HEADER, JSON_CONTENT_TYPE } from './http.js';
import { OUTCOME } from './outcome.js';
import type { CommandResult } from './outcome.js';
import { BoardError, type BoardClock, NO_RESPONSE_STATUS } from './transport.js';

/** The board's built-in public client for this CLI (server migration 161). */
export const CLI_CLIENT_ID = 'bellows-cli';
export const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
export const TOKEN_PATH = '/api/oauth/token';
const REVOKE_PATH = '/api/oauth/revoke';

/** The `oauth` entry of the settings file. `expiresAt` is the access token's expiry, ISO 8601. */
export interface OAuthCredential {
    url: string;
    clientId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    scope: string;
}

const MS_PER_SECOND = 1000;
/** Refresh this long before the access token expires, so a request never races its expiry. */
const REFRESH_AHEAD_MS = 60_000;
/** A lock older than this is a crashed holder's and is taken over. */
const STALE_LOCK_MS = 30_000;
/** The longest a refresh waits for another process's lock, on top of the attempt's own signal. */
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 100;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const JSON_INDENT = 2;

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;

const SIGN_IN_AGAIN = 'the sign-in has expired or was revoked — run `bellows auth login` again';

function errnoOf(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException).code;
}

/** A token endpoint's 200 body as a credential, or null when it is not a full `mat_`/`mrt_` pair with a lifetime. */
export function grantOf(body: unknown, origin: { url: string; now: number }): OAuthCredential | null {
    const grant = body as Record<string, unknown> | null;
    const access = grant?.access_token;
    const refresh = grant?.refresh_token;
    const expiresIn = grant?.expires_in;
    if (typeof access !== 'string' || !access.startsWith('mat_')) return null;
    if (typeof refresh !== 'string' || !refresh.startsWith('mrt_')) return null;
    if (typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn <= 0) return null;
    return {
        url: origin.url,
        clientId: CLI_CLIENT_ID,
        accessToken: access,
        refreshToken: refresh,
        expiresAt: new Date(origin.now + expiresIn * MS_PER_SECOND).toISOString(),
        scope: typeof grant?.scope === 'string' ? grant.scope : '',
    };
}

/** The settings file's JSON object, `{}` when it does not exist yet. */
function readObject(path: string): Record<string, unknown> {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch (error) {
        if (errnoOf(error) === 'ENOENT') return {};
        throw error;
    }
}

/**
 * Sets (or, given null, removes) the `oauth` entry and keeps every other key: a 0600 temp file
 * created exclusively, synced, then renamed over the file. A missing directory is created 0700.
 */
export function saveOAuth(path: string, credential: OAuthCredential | null): void {
    const settings = readObject(path);
    if (credential) settings[OAUTH_KEY] = credential;
    else delete settings[OAUTH_KEY];
    mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
    const temp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, 'wx', FILE_MODE);
    try {
        try {
            writeSync(fd, `${JSON.stringify(settings, null, JSON_INDENT)}\n`);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        renameSync(temp, path);
    } catch (error) {
        try {
            unlinkSync(temp);
        } catch {
            // Already gone; the original error is the one to report.
        }
        throw error;
    }
}

/** The stored sign-in as it is now, or null when there is none. */
function storedOAuth(path: string): OAuthCredential | null {
    const value = readObject(path)[OAUTH_KEY];
    return value === undefined ? null : parseOAuth(value, `${path}: ${OAUTH_KEY}`);
}

interface LockOptions {
    signal: AbortSignal | undefined;
    now: () => number;
    sleep: BoardClock['sleep'];
    stat: (path: string) => { mtimeMs: number };
}

/** One try at the lock: taken, worth trying again now (it vanished or was stale), or held by a live process. */
function tryLock(lockPath: string, stat: LockOptions['stat']): 'taken' | 'again' | 'held' {
    try {
        closeSync(openSync(lockPath, 'wx', FILE_MODE));
        return 'taken';
    } catch (error) {
        if (errnoOf(error) !== 'EEXIST') throw error;
    }
    let age: number;
    try {
        age = Date.now() - stat(lockPath).mtimeMs;
    } catch (error) {
        if (errnoOf(error) === 'ENOENT') return 'again';
        throw error;
    }
    if (age <= STALE_LOCK_MS) return 'held';
    try {
        unlinkSync(lockPath);
    } catch (error) {
        if (errnoOf(error) !== 'ENOENT') throw error;
    }
    return 'again';
}

/**
 * Runs `work` holding `<settings>.lock`, created exclusively. A lock older than 30 s is a crashed
 * holder's: removed only after a stat that succeeded says so. A stat that fails with ENOENT means
 * the holder just released it; any other failure ends the refresh and removes nothing. The wait is
 * bounded by the attempt's signal and a 10 s cap on the clock, and the lock is released exactly once.
 */
async function withLock<T>(lockPath: string, options: LockOptions, work: () => Promise<T>): Promise<T> {
    const giveUpAt = options.now() + LOCK_WAIT_MS;
    for (;;) {
        options.signal?.throwIfAborted();
        const attempt = tryLock(lockPath, options.stat);
        if (attempt === 'taken') break;
        if (attempt === 'again') continue;
        if (options.now() >= giveUpAt) {
            throw new BoardError(
                `the sign-in refresh could not take ${lockPath} within ${LOCK_WAIT_MS / MS_PER_SECOND}s`,
                NO_RESPONSE_STATUS,
                null
            );
        }
        await options.sleep(LOCK_POLL_MS, options.signal);
    }
    try {
        return await work();
    } finally {
        try {
            unlinkSync(lockPath);
        } catch {
            // Taken over as stale by another process; nothing of ours is left to release.
        }
    }
}

export interface OAuthFetchOptions {
    fetch: typeof globalThis.fetch;
    settingsPath: string;
    credential: OAuthCredential;
    now: () => number;
    sleep: BoardClock['sleep'];
    /** Told when a refreshed pair could not be saved: it is used for this run only. */
    warn: (text: string) => void;
    stat?: ((path: string) => { mtimeMs: number }) | undefined;
}

type Refreshed = OAuthCredential | 'dead';

/** The refresh grant, classified: a new pair, a dead grant, or a throw for anything inconclusive. */
async function postRefresh(options: OAuthFetchOptions, stale: OAuthCredential, signal: AbortSignal | undefined) {
    const inconclusive = (why: string) =>
        new BoardError(`the sign-in refresh was inconclusive (${why}); nothing was changed`, NO_RESPONSE_STATUS, null);
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: stale.refreshToken,
        client_id: stale.clientId,
    });
    let response: Response;
    let text: string;
    try {
        response = await options.fetch(`${stale.url}${TOKEN_PATH}`, {
            method: 'POST',
            headers: { [CONTENT_TYPE_HEADER]: FORM_CONTENT_TYPE },
            body: body.toString(),
            signal: signal ?? null,
        });
        text = await response.text();
    } catch (error) {
        throw inconclusive(error instanceof Error ? error.message : String(error));
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw inconclusive(`${TOKEN_PATH} answered ${response.status} with a body that is not JSON`);
    }
    const code = (parsed as { error?: unknown } | null)?.error;
    const dead =
        (response.status === HTTP_BAD_REQUEST && code === 'invalid_grant') ||
        (response.status === HTTP_UNAUTHORIZED && code === 'invalid_client');
    if (dead) return 'dead' as const;
    const grant = response.status === HTTP_OK ? grantOf(parsed, { url: stale.url, now: options.now() }) : null;
    if (!grant) throw inconclusive(`${TOKEN_PATH} answered ${response.status} without a token pair`);
    return { ...grant, clientId: stale.clientId };
}

/** What the transport sees for a dead grant: the board's 401 shape, with the way out named. */
function signInAgain(): Response {
    return Response.json({ error: SIGN_IN_AGAIN }, { status: HTTP_UNAUTHORIZED });
}

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    return { ...init, headers };
}

/** A GET, or a write the board recognizes as a repeat: safe to send again after a refresh. */
function replayable(init: RequestInit | undefined): boolean {
    return (init?.method ?? 'GET') === 'GET' || new Headers(init?.headers).has(IDEMPOTENCY_KEY_HEADER);
}

/**
 * A fetch carrying the stored sign-in: refreshed ahead of expiry, and once after a 401 for a request
 * that is safe to repeat. Refreshes are single-flight within the process and across processes (the
 * lockfile); after the lock is taken the file is re-read, and a pair another process already rotated
 * is used rather than refreshed again.
 */
export function oauthFetch(options: OAuthFetchOptions): typeof globalThis.fetch {
    let current = options.credential;
    let inflight: Promise<Refreshed> | null = null;
    const lock = { now: options.now, sleep: options.sleep, stat: options.stat ?? statSync };

    const refreshUnderLock = (stale: OAuthCredential, signal: AbortSignal | undefined) =>
        withLock(`${options.settingsPath}.lock`, { ...lock, signal }, async (): Promise<Refreshed> => {
            const stored = storedOAuth(options.settingsPath);
            if (stored && stored.url === stale.url && stored.refreshToken !== stale.refreshToken) return stored;
            const refreshed = await postRefresh(options, stale, signal);
            if (refreshed === 'dead') return refreshed;
            try {
                saveOAuth(options.settingsPath, refreshed);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                options.warn(
                    `warning: the refreshed sign-in could not be saved (${reason}); it is used for this run only\n`
                );
            }
            return refreshed;
        });

    const refresh = async (signal: AbortSignal | undefined): Promise<Refreshed> => {
        inflight ??= refreshUnderLock(current, signal).finally(() => {
            inflight = null;
        });
        const result = await inflight;
        if (result !== 'dead') current = result;
        return result;
    };

    return (async (input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal ?? undefined;
        if (Date.parse(current.expiresAt) - options.now() < REFRESH_AHEAD_MS) {
            if ((await refresh(signal)) === 'dead') return signInAgain();
        }
        const sent = current.accessToken;
        const response = await options.fetch(input, withBearer(init, sent));
        if (response.status !== HTTP_UNAUTHORIZED || !replayable(init)) return response;
        await response.body?.cancel();
        // Another request of this run may already have rotated the pair.
        if (current.accessToken === sent && (await refresh(signal)) === 'dead') return signInAgain();
        return options.fetch(input, withBearer(init, current.accessToken));
    }) as typeof globalThis.fetch;
}

const NOT_CONFIRMED =
    'the grant may still be live; end it under Connected apps on the board, then run bellows auth logout again';

/**
 * Revokes the stored refresh token (which ends its whole grant), then removes the `oauth` entry.
 * The revoke answers an empty 200, so it is a raw request bounded by the request deadline: only a
 * 200 counts, and anything else keeps the tokens and ends `unreachable`.
 */
export async function authLogoutCommand(
    config: CliConfig,
    io: { fetch?: typeof globalThis.fetch | undefined; signal?: AbortSignal | undefined },
    settingsPath: string
): Promise<CommandResult> {
    const stored = config.oauth;
    if (!stored) return { outcome: OUTCOME.ok, data: { signedOut: false }, stdout: 'not signed in; nothing to do\n' };
    const deadline = AbortSignal.timeout(config.requestTimeoutMs);
    const signal = io.signal ? AbortSignal.any([io.signal, deadline]) : deadline;
    let status: number | null = null;
    try {
        const response = await (io.fetch ?? globalThis.fetch)(`${stored.url}${REVOKE_PATH}`, {
            method: 'POST',
            headers: { [CONTENT_TYPE_HEADER]: FORM_CONTENT_TYPE, accept: JSON_CONTENT_TYPE },
            body: new URLSearchParams({ token: stored.refreshToken, client_id: stored.clientId }).toString(),
            signal,
        });
        status = response.status;
        await response.body?.cancel();
    } catch (error) {
        if (io.signal?.aborted) throw error;
    }
    if (status !== HTTP_OK) {
        const answer = status === null ? 'no answer' : `${status}`;
        const message = `sign-out not confirmed by ${stored.url} (${answer}) — ${NOT_CONFIRMED}`;
        return {
            outcome: OUTCOME.unreachable,
            error: { message, code: null, status },
            stderr: `error: ${message}\n`,
        };
    }
    saveOAuth(settingsPath, null);
    return {
        outcome: OUTCOME.ok,
        data: { signedOut: true, url: stored.url },
        stdout: `signed out of ${stored.url}; the sign-in was removed from ${settingsPath}\n`,
    };
}
