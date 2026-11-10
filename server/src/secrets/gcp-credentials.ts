import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONTENT_TYPE_HEADER } from '@factory-ai/core';
import { CredentialError } from '../artifacts/s3-credentials.js';

/**
 * Application Default Credentials for the Secret Manager backend (docs/secrets.md), and nothing else: no key file
 * is read. In order: the `authorized_user` file `GOOGLE_APPLICATION_CREDENTIALS` names, the gcloud ADC file, then
 * the metadata server, which is Workload Identity on GKE. A configured source that fails is an error, never a
 * fall-through to the next; only a well-known file that does not exist falls through. A service-account key file
 * is refused. A failure is a `CredentialError` that names the source and the status and never carries a body.
 */

export interface GcpToken {
    token: string;
    /** The project a user credential's quota is charged to, sent as `x-goog-user-project`; null for none. */
    quotaProject: string | null;
}

/** The access token, cached until shortly before it expires; `fresh` refetches after the API refused the cached one. */
export type GcpTokenProvider = (options?: { fresh: true }) => Promise<GcpToken>;

export interface GcpTokenSources {
    env: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    readFile?: (path: string) => Promise<string>;
    now?: () => number;
    fetchTimeoutMs?: number;
}

const MS_PER_SECOND = 1000;
const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const HTTP_CLIENT_ERROR = 400;
const HTTP_SERVER_ERROR = 500;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const ABSENT_FILE = new Set(['ENOENT', 'ENOTDIR']);
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const METADATA_PATH = '/computeMetadata/v1/instance/service-accounts/default/token';
const ADC_FILE = 'application_default_credentials.json';

interface UserCredential {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    quotaProject: string | null;
}

interface Issued {
    token: GcpToken;
    expiresAt: number;
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The credential a file holds, or a `misconfigured` error: only `authorized_user` is accepted. */
function parseUserCredential(text: string): UserCredential {
    let json: Record<string, unknown> | null = null;
    try {
        json = JSON.parse(text) as Record<string, unknown> | null;
    } catch {
        json = null;
    }
    if (json?.type === 'service_account' || json?.type === 'external_account') {
        throw new CredentialError(
            'GCP credential file is a key or federation file: service-account key files are not supported, use Workload Identity or gcloud application-default login',
            'misconfigured'
        );
    }
    if (
        json?.type !== 'authorized_user' ||
        !nonEmpty(json.client_id) ||
        !nonEmpty(json.client_secret) ||
        !nonEmpty(json.refresh_token)
    ) {
        throw new CredentialError('GCP credential file is not an authorized_user credential', 'misconfigured');
    }
    return {
        clientId: json.client_id,
        clientSecret: json.client_secret,
        refreshToken: json.refresh_token,
        quotaProject: nonEmpty(json.quota_project_id) ? json.quota_project_id : null,
    };
}

async function failed(what: string, response: Response): Promise<never> {
    await response.body?.cancel().catch(() => undefined);
    const status = response.status;
    const refused = status >= HTTP_CLIENT_ERROR && status < HTTP_SERVER_ERROR;
    const retryable = status === HTTP_REQUEST_TIMEOUT || status === HTTP_TOO_MANY_REQUESTS;
    throw new CredentialError(`${what} answered ${status}`, refused && !retryable ? 'misconfigured' : 'unavailable');
}

const typed = (what: string, error: unknown): CredentialError =>
    error instanceof CredentialError ? error : new CredentialError(`${what} did not answer`, 'unavailable');

export function createGcpTokenProvider(sources: GcpTokenSources): GcpTokenProvider {
    const { env } = sources;
    const doFetch = sources.fetch ?? fetch;
    const read = sources.readFile ?? ((path: string) => readFile(path, 'utf8'));
    const now = sources.now ?? Date.now;
    const timeoutMs = sources.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

    const issued = (quotaProject: string | null, body: unknown): Issued => {
        const answer = body as { access_token?: unknown; expires_in?: unknown } | null;
        if (!nonEmpty(answer?.access_token) || typeof answer.expires_in !== 'number') {
            throw new CredentialError('GCP token answer is malformed', 'unavailable');
        }
        return {
            token: { token: answer.access_token, quotaProject },
            expiresAt: now() + answer.expires_in * MS_PER_SECOND,
        };
    };

    async function refresh(credential: UserCredential): Promise<Issued> {
        try {
            const response = await doFetch(TOKEN_ENDPOINT, {
                method: 'POST',
                headers: { [CONTENT_TYPE_HEADER]: 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    client_id: credential.clientId,
                    client_secret: credential.clientSecret,
                    refresh_token: credential.refreshToken,
                }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!response.ok) return await failed('Google OAuth', response);
            return issued(credential.quotaProject, await response.json());
        } catch (error) {
            throw typed('Google OAuth', error);
        }
    }

    async function metadata(): Promise<Issued> {
        const host = env.GCE_METADATA_HOST?.trim() || 'metadata.google.internal';
        try {
            const response = await doFetch(`http://${host}${METADATA_PATH}`, {
                headers: { 'Metadata-Flavor': 'Google' },
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!response.ok) return await failed('GCP metadata server', response);
            return issued(null, await response.json());
        } catch (error) {
            throw typed('GCP metadata server', error);
        }
    }

    const named = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
    const wellKnown = join(env.CLOUDSDK_CONFIG?.trim() || join(homedir(), '.config', 'gcloud'), ADC_FILE);

    /** The file's credential; a well-known file that is simply absent is null, any other failure is an error. */
    async function userCredential(path: string, mayBeAbsent: boolean): Promise<UserCredential | null> {
        let text: string;
        try {
            text = await read(path);
        } catch (error) {
            const code = (error as { code?: unknown } | null)?.code;
            if (mayBeAbsent && typeof code === 'string' && ABSENT_FILE.has(code)) {
                return null;
            }
            throw new CredentialError('GCP credential file is unreadable', 'misconfigured');
        }
        return parseUserCredential(text);
    }

    async function fetchToken(): Promise<Issued> {
        const credential = named ? await userCredential(named, false) : await userCredential(wellKnown, true);
        return credential ? refresh(credential) : metadata();
    }

    let cached: Issued | null = null;
    let pending: Promise<Issued> | null = null;

    return async (options) => {
        if (!options?.fresh && cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) {
            return cached.token;
        }
        // One fetch serves every waiter; a failure clears it so the next call tries again.
        pending ??= fetchToken()
            .then((result) => {
                cached = result;
                return result;
            })
            .finally(() => {
                pending = null;
            });
        return (await pending).token;
    };
}
