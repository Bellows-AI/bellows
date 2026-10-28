import { readFile } from 'node:fs/promises';
import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE } from '@factory-ai/core';
import type { Credentials } from './sigv4.js';

/**
 * Where the S3 backend and the secret store get credentials, in order: static keys, then EKS Pod
 * Identity, then IRSA web identity. The first source that is configured wins; a configured source
 * that fails is an error, never a fall-through to the next, so a broken role binding is not
 * mistaken for "no credentials needed". Every fetch is bounded, and a failure is a `CredentialError`
 * that names the source and the status and never carries a response body.
 */

export interface CredentialSources {
    /** `ARTIFACTS_ACCESS_KEY_ID` / `ARTIFACTS_SECRET_ACCESS_KEY`, both or neither (config enforces it). */
    static: { accessKeyId: string; secretAccessKey: string } | null;
    /** The process environment: the AWS_* variables Pod Identity and IRSA inject. */
    env: NodeJS.ProcessEnv;
    region: string;
    fetch?: typeof fetch;
    readFile?: (path: string) => Promise<string>;
    now?: () => number;
    /** Bounds each credential fetch, body included; a hung endpoint must not pin the refresh forever. */
    fetchTimeoutMs?: number;
}

/**
 * `fresh` skips the cache: the caller learned the cached credentials were refused (an expired token), so a
 * refetch cannot wait for the stated expiry. Concurrent callers still share one fetch.
 */
export type CredentialProvider = (options?: { fresh?: boolean }) => Promise<Credentials>;

/**
 * `misconfigured`: the source is absent or refused (a status the caller cannot fix by waiting, a missing token
 * file); `unavailable`: it did not answer in time or answered with a server error.
 */
export class CredentialError extends Error {
    constructor(
        message: string,
        readonly kind: 'misconfigured' | 'unavailable'
    ) {
        super(message);
    }
}

/** Refetch this long before the stated expiry, so a request never signs with a key about to lapse. */
const MS_PER_MINUTE = 60_000;
const REFRESH_MARGIN_MINUTES = 5;
const REFRESH_MARGIN_MS = REFRESH_MARGIN_MINUTES * MS_PER_MINUTE;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_CLIENT_ERROR = 400;
const HTTP_SERVER_ERROR = 500;
const UNREADABLE_TOKEN_FILE = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EISDIR']);

interface ExpiringKeys {
    AccessKeyId: string;
    SecretAccessKey: string;
    SessionToken?: string;
    Token?: string;
    Expiration: string;
}

function fromExpiring(keys: ExpiringKeys): Credentials {
    return {
        accessKeyId: keys.AccessKeyId,
        secretAccessKey: keys.SecretAccessKey,
        sessionToken: keys.SessionToken ?? keys.Token,
        expiresAt: Date.parse(keys.Expiration),
    };
}

async function failed(what: string, response: Response): Promise<never> {
    await response.body?.cancel().catch(() => undefined);
    const status = response.status;
    const refused = status >= HTTP_CLIENT_ERROR && status < HTTP_SERVER_ERROR;
    const retryable = status === HTTP_REQUEST_TIMEOUT || status === HTTP_TOO_MANY_REQUESTS;
    throw new CredentialError(`${what} answered ${status}`, refused && !retryable ? 'misconfigured' : 'unavailable');
}

/** Anything a source throws that is not already typed: a missing token file is configuration, the rest is transient. */
function typed(what: string, error: unknown): CredentialError {
    if (error instanceof CredentialError) {
        return error;
    }
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && UNREADABLE_TOKEN_FILE.has(code)
        ? new CredentialError(`${what} token file is unreadable`, 'misconfigured')
        : new CredentialError(`${what} did not answer`, 'unavailable');
}

export function createCredentialProvider(sources: CredentialSources): CredentialProvider {
    const { env, region } = sources;
    const doFetch = sources.fetch ?? fetch;
    const read = sources.readFile ?? ((path: string) => readFile(path, 'utf8'));
    const now = sources.now ?? Date.now;
    const timeoutMs = sources.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

    const podIdentityUri = env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim();
    const podIdentityTokenFile = env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE?.trim();
    const webIdentityTokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE?.trim();
    const roleArn = env.AWS_ROLE_ARN?.trim();

    async function podIdentity(uri: string, tokenFile: string, abandoned: AbortSignal): Promise<Credentials> {
        try {
            const authorization = (await read(tokenFile)).trim();
            abandoned.throwIfAborted();
            const response = await doFetch(uri, {
                headers: { authorization },
                signal: AbortSignal.any([abandoned, AbortSignal.timeout(timeoutMs)]),
            });
            if (!response.ok) return await failed('EKS Pod Identity', response);
            return fromExpiring((await response.json()) as ExpiringKeys);
        } catch (error) {
            throw typed('EKS Pod Identity', error);
        }
    }

    async function webIdentity(tokenFile: string, arn: string, abandoned: AbortSignal): Promise<Credentials> {
        const endpoint = env.AWS_ENDPOINT_URL_STS?.trim() || `https://sts.${region}.amazonaws.com`;
        try {
            const body = new URLSearchParams({
                Action: 'AssumeRoleWithWebIdentity',
                Version: '2011-06-15',
                RoleArn: arn,
                RoleSessionName: env.AWS_ROLE_SESSION_NAME?.trim() || 'factory-dashboard',
                WebIdentityToken: (await read(tokenFile)).trim(),
            });
            abandoned.throwIfAborted();
            const response = await doFetch(endpoint, {
                method: 'POST',
                headers: { accept: JSON_CONTENT_TYPE, [CONTENT_TYPE_HEADER]: 'application/x-www-form-urlencoded' },
                body,
                signal: AbortSignal.any([abandoned, AbortSignal.timeout(timeoutMs)]),
            });
            if (!response.ok) return await failed('STS AssumeRoleWithWebIdentity', response);
            const parsed = (await response.json()) as {
                AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: ExpiringKeys } };
            };
            return fromExpiring(parsed.AssumeRoleWithWebIdentityResponse.AssumeRoleWithWebIdentityResult.Credentials);
        } catch (error) {
            throw typed('STS AssumeRoleWithWebIdentity', error);
        }
    }

    const { static: staticKeys } = sources;
    if (staticKeys) return async () => ({ ...staticKeys });

    let fetchKeys: (abandoned: AbortSignal) => Promise<Credentials>;
    if (podIdentityUri && podIdentityTokenFile)
        fetchKeys = (abandoned) => podIdentity(podIdentityUri, podIdentityTokenFile, abandoned);
    else if (webIdentityTokenFile && roleArn)
        fetchKeys = (abandoned) => webIdentity(webIdentityTokenFile, roleArn, abandoned);
    else {
        return async () => {
            throw new CredentialError(
                'no S3 credentials: set ARTIFACTS_ACCESS_KEY_ID and ARTIFACTS_SECRET_ACCESS_KEY, or run with EKS Pod Identity or an IRSA role',
                'misconfigured'
            );
        };
    }

    /** The fetch raced against its own timeout across every step (token file included); the loser is abandoned. */
    const bounded = () =>
        new Promise<Credentials>((resolve, reject) => {
            const abandon = new AbortController();
            const timer = setTimeout(() => {
                abandon.abort();
                reject(new CredentialError('credential fetch did not answer in time', 'unavailable'));
            }, timeoutMs);
            fetchKeys(abandon.signal)
                .then(resolve, reject)
                .finally(() => clearTimeout(timer));
        });

    let cached: Credentials | null = null;
    let pending: Promise<Credentials> | null = null;
    return async (options) => {
        if (!options?.fresh && cached && (cached.expiresAt ?? Infinity) - REFRESH_MARGIN_MS > now()) return cached;
        // One refresh at a time: concurrent chunk writes share a single credential fetch. An attempt that timed out
        // has settled, so its slot is free and its late keys never reach `cached`.
        if (!pending) {
            const attempt: Promise<Credentials> = bounded()
                .then((keys) => (cached = keys))
                .finally(() => {
                    if (pending === attempt) pending = null;
                });
            pending = attempt;
        }
        return pending;
    };
}
