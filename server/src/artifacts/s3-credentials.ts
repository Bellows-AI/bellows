import { readFile } from 'node:fs/promises';
import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE } from '@factory-ai/core';
import type { Credentials } from './sigv4.js';

/**
 * Where the S3 backend gets credentials, in order: static keys from a Secret, then EKS Pod
 * Identity, then IRSA web identity. The first source that is configured wins; a configured source
 * that fails is an error, never a fall-through to the next, so a broken role binding is not
 * mistaken for "no credentials needed".
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
}

export type CredentialProvider = () => Promise<Credentials>;

/** Refetch this long before the stated expiry, so a request never signs with a key about to lapse. */
const MS_PER_MINUTE = 60_000;
const REFRESH_MARGIN_MINUTES = 5;
const REFRESH_MARGIN_MS = REFRESH_MARGIN_MINUTES * MS_PER_MINUTE;
const ERROR_DETAIL_CHARS = 200;

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
    throw new Error(`${what} answered ${response.status}: ${(await response.text()).slice(0, ERROR_DETAIL_CHARS)}`);
}

export function createCredentialProvider(sources: CredentialSources): CredentialProvider {
    const { env, region } = sources;
    const doFetch = sources.fetch ?? fetch;
    const read = sources.readFile ?? ((path: string) => readFile(path, 'utf8'));
    const now = sources.now ?? Date.now;

    const podIdentityUri = env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim();
    const podIdentityTokenFile = env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE?.trim();
    const webIdentityTokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE?.trim();
    const roleArn = env.AWS_ROLE_ARN?.trim();

    async function podIdentity(uri: string, tokenFile: string): Promise<Credentials> {
        const response = await doFetch(uri, { headers: { authorization: (await read(tokenFile)).trim() } });
        if (!response.ok) return failed('EKS Pod Identity', response);
        return fromExpiring((await response.json()) as ExpiringKeys);
    }

    async function webIdentity(tokenFile: string, arn: string): Promise<Credentials> {
        const endpoint = env.AWS_ENDPOINT_URL_STS?.trim() || `https://sts.${region}.amazonaws.com`;
        const body = new URLSearchParams({
            Action: 'AssumeRoleWithWebIdentity',
            Version: '2011-06-15',
            RoleArn: arn,
            RoleSessionName: env.AWS_ROLE_SESSION_NAME?.trim() || 'factory-dashboard',
            WebIdentityToken: (await read(tokenFile)).trim(),
        });
        const response = await doFetch(endpoint, {
            method: 'POST',
            headers: { accept: JSON_CONTENT_TYPE, [CONTENT_TYPE_HEADER]: 'application/x-www-form-urlencoded' },
            body,
        });
        if (!response.ok) return failed('STS AssumeRoleWithWebIdentity', response);
        const parsed = (await response.json()) as {
            AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: ExpiringKeys } };
        };
        return fromExpiring(parsed.AssumeRoleWithWebIdentityResponse.AssumeRoleWithWebIdentityResult.Credentials);
    }

    const { static: staticKeys } = sources;
    if (staticKeys) return async () => ({ ...staticKeys });

    let fetchKeys: () => Promise<Credentials>;
    if (podIdentityUri && podIdentityTokenFile) fetchKeys = () => podIdentity(podIdentityUri, podIdentityTokenFile);
    else if (webIdentityTokenFile && roleArn) fetchKeys = () => webIdentity(webIdentityTokenFile, roleArn);
    else {
        return async () => {
            throw new Error(
                'no S3 credentials: set ARTIFACTS_ACCESS_KEY_ID and ARTIFACTS_SECRET_ACCESS_KEY, or run with EKS Pod Identity or an IRSA role'
            );
        };
    }

    let cached: Credentials | null = null;
    let pending: Promise<Credentials> | null = null;
    return async () => {
        if (cached && (cached.expiresAt ?? Infinity) - REFRESH_MARGIN_MS > now()) return cached;
        // One refresh at a time: concurrent chunk writes share a single credential fetch.
        pending ??= fetchKeys()
            .then((keys) => (cached = keys))
            .finally(() => {
                pending = null;
            });
        return pending;
    };
}
