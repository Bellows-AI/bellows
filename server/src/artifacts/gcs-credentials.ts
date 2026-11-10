import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONTENT_TYPE_HEADER } from '@factory-ai/core';
import { CredentialError } from './s3-credentials.js';

/**
 * Application Default Credentials for the GCS backend, and nothing else: no key-file option. In
 * order: the file `GOOGLE_APPLICATION_CREDENTIALS` names, then gcloud's well-known file (local
 * development, `gcloud auth application-default login`), then the metadata server (GKE Workload
 * Identity). Only an `authorized_user` file is accepted: a `service_account` key is a long-lived
 * secret, which is what this backend exists to avoid. A file that exists but cannot be used is an
 * error, never a fall-through to the metadata server; only an absent well-known file is.
 */

export interface GcsTokenSources {
    env: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    readFile?: (path: string) => Promise<string>;
    now?: () => number;
    home?: string;
    /** Bounds each token fetch, body included. */
    fetchTimeoutMs?: number;
}

/** `fresh` skips the cache: the caller learned the cached token was refused. */
export type GcsTokenProvider = (options?: { fresh?: boolean }) => Promise<string>;

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const WELL_KNOWN_FILE = 'application_default_credentials.json';
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const REFRESH_MARGIN_MINUTES = 5;
const REFRESH_MARGIN_MS = REFRESH_MARGIN_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_CLIENT_ERROR = 400;
const HTTP_SERVER_ERROR = 500;

interface Token {
    value: string;
    expiresAt: number;
}

interface AuthorizedUser {
    type?: string;
    client_id?: string;
    client_secret?: string;
    refresh_token?: string;
}

async function failed(what: string, response: Response): Promise<never> {
    await response.body?.cancel().catch(() => undefined);
    const status = response.status;
    const refused = status >= HTTP_CLIENT_ERROR && status < HTTP_SERVER_ERROR;
    const retryable = status === HTTP_REQUEST_TIMEOUT || status === HTTP_TOO_MANY_REQUESTS;
    throw new CredentialError(`${what} answered ${status}`, refused && !retryable ? 'misconfigured' : 'unavailable');
}

export function createGcsTokenProvider(sources: GcsTokenSources): GcsTokenProvider {
    const { env } = sources;
    const doFetch = sources.fetch ?? fetch;
    const read = sources.readFile ?? ((path: string) => readFile(path, 'utf8'));
    const now = sources.now ?? Date.now;
    const timeoutMs = sources.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

    const named = env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ?? '';
    const wellKnown = join(
        env.CLOUDSDK_CONFIG?.trim() || join(sources.home ?? homedir(), '.config', 'gcloud'),
        WELL_KNOWN_FILE
    );

    async function tokenFrom(what: string, request: () => Promise<Response>): Promise<Token> {
        let response: Response;
        try {
            response = await request();
        } catch {
            throw new CredentialError(`${what} did not answer`, 'unavailable');
        }
        if (!response.ok) return failed(what, response);
        try {
            const body = (await response.json()) as { access_token?: string; expires_in?: number };
            if (!body.access_token) throw new Error('no token');
            return { value: body.access_token, expiresAt: now() + (body.expires_in ?? 0) * MS_PER_SECOND };
        } catch {
            throw new CredentialError(`${what} answered without an access token`, 'unavailable');
        }
    }

    function fromMetadata(): Promise<Token> {
        return tokenFrom('GCE metadata server', () =>
            doFetch(METADATA_TOKEN_URL, {
                headers: { 'metadata-flavor': 'Google' },
                signal: AbortSignal.timeout(timeoutMs),
            })
        );
    }

    function fromRefreshToken(file: AuthorizedUser): Promise<Token> {
        return tokenFrom('Google OAuth token endpoint', () =>
            doFetch(OAUTH_TOKEN_URL, {
                method: 'POST',
                headers: { [CONTENT_TYPE_HEADER]: 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    client_id: file.client_id ?? '',
                    client_secret: file.client_secret ?? '',
                    refresh_token: file.refresh_token ?? '',
                }),
                signal: AbortSignal.timeout(timeoutMs),
            })
        );
    }

    /** The credential file, or null for an absent well-known file; a named file that is absent is an error. */
    async function credentialFile(): Promise<AuthorizedUser | null> {
        const path = named || wellKnown;
        let text: string;
        try {
            text = await read(path);
        } catch (error) {
            const code = (error as { code?: unknown } | null)?.code;
            if (!named && code === 'ENOENT') return null;
            throw new CredentialError('the Application Default Credentials file is unreadable', 'misconfigured');
        }
        let parsed: AuthorizedUser;
        try {
            parsed = JSON.parse(text) as AuthorizedUser;
        } catch {
            throw new CredentialError('the Application Default Credentials file is not JSON', 'misconfigured');
        }
        if (parsed.type !== 'authorized_user') {
            throw new CredentialError(
                `the Application Default Credentials file has type "${String(parsed.type)}": only authorized_user (gcloud auth application-default login) is accepted, never a key file; on GKE use Workload Identity`,
                'misconfigured'
            );
        }
        return parsed;
    }

    async function fetchToken(): Promise<Token> {
        const file = await credentialFile();
        return file ? fromRefreshToken(file) : fromMetadata();
    }

    let cached: Token | null = null;
    let pending: Promise<Token> | null = null;
    return async (options) => {
        if (!options?.fresh && cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return cached.value;
        // One refresh at a time: concurrent chunk writes share a single token fetch.
        if (!pending) {
            const attempt: Promise<Token> = fetchToken()
                .then((token) => (cached = token))
                .finally(() => {
                    if (pending === attempt) pending = null;
                });
            pending = attempt;
        }
        return (await pending).value;
    };
}
