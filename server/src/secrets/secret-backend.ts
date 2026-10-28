import type { Sql } from 'postgres';
import { createCredentialProvider } from '../artifacts/s3-credentials.js';
import { createAwsObjectClient } from './aws-secrets-manager.js';
import { createExternalPayloads } from './external-payloads.js';
import { createSecretRepo } from './postgres-secret-repo.js';
import {
    type CoordinatedSecretStore,
    createPostgresSecretStore,
    createSecretStoreOver,
} from './postgres-secret-store.js';
import {
    type OperationKeys,
    SecretKeyConfigError,
    type SecretKeys,
    loadOperationKeys,
    loadSecretKeys,
} from './secret-keys.js';
import type { SecretDiagnostic } from './secret-store.js';
import { createVaultObjectClient } from './vault-kv.js';
import type { VaultAuth } from './vault-token.js';

/**
 * Which backend holds the secret payloads (docs/secrets.md): `SECRETS_BACKEND=database|aws|vault`, required on
 * every boot with no default, one per deployment. Pure: no I/O, and every refusal names a variable and never a
 * value. A variable that belongs to another backend is refused rather than ignored, because a deployment that
 * thinks it is on one backend while configured for another is the failure this rules out.
 */

export const BACKENDS = ['database', 'aws', 'vault'] as const;
export type SecretBackendName = (typeof BACKENDS)[number];

/** Variables that only make sense in one backend; set in another they are refused. */
const OWNED_PREFIXES: Record<SecretBackendName, string> = {
    database: '',
    aws: 'SECRETS_AWS_',
    vault: 'SECRETS_VAULT_',
};
const DATA_KEY_VARIABLES = ['SECRETS_DATA_KEYS', 'SECRETS_ACTIVE_KEY_ID'];

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const PREFIX_SEGMENT = /^[A-Za-z0-9_+=.@-]+$/;
const MAX_PREFIX_CHARS = 200;
const VAULT_SEGMENT = /^[A-Za-z0-9_+=@-][A-Za-z0-9_+=.@-]*$/;

export interface AwsBackendConfig {
    region: string;
    /** The namespace in the account every object lives under: no leading or trailing slash. */
    prefix: string;
    endpoint: string | null;
    /** Development only; production uses workload identity. */
    staticCredentials: { accessKeyId: string; secretAccessKey: string } | null;
}

export interface VaultBackendConfig {
    /** The Vault origin, no path and no trailing slash. */
    addr: string;
    /** The KV v2 mount path. */
    mount: string;
    /** The namespace in the mount every object lives under: no leading or trailing slash. */
    prefix: string;
    /** Kubernetes login in a cluster; a fixed token for development and tests only. */
    auth: VaultAuth;
}

export type SecretBackendConfig =
    | { kind: 'database'; keys: SecretKeys }
    | { kind: 'aws'; keys: OperationKeys; aws: AwsBackendConfig }
    | { kind: 'vault'; keys: OperationKeys; vault: VaultBackendConfig };

type Env = Record<string, string | undefined>;

/** A variable's trimmed value; a blank one (as a rendered chart leaves it) is unset. */
const trimmed = (env: Env, name: string): string | undefined => env[name]?.trim() || undefined;

function required(env: Env, name: string): string {
    const value = trimmed(env, name);
    if (value === undefined) {
        throw new SecretKeyConfigError(`${name} is required`);
    }
    return value;
}

function refuseForeign(env: Env, mode: SecretBackendName): void {
    const foreign = BACKENDS.filter((other) => other !== mode && OWNED_PREFIXES[other] !== '');
    for (const name of Object.keys(env).sort()) {
        if (foreign.some((other) => name.startsWith(OWNED_PREFIXES[other])) && trimmed(env, name) !== undefined) {
            throw new SecretKeyConfigError(`${name} is only valid with SECRETS_BACKEND=${ownerOf(name)}`);
        }
    }
    if (mode !== 'database') {
        for (const name of DATA_KEY_VARIABLES) {
            if (trimmed(env, name) !== undefined) {
                throw new SecretKeyConfigError(`${name} is only valid with SECRETS_BACKEND=database`);
            }
        }
    }
}

const ownerOf = (name: string): SecretBackendName =>
    BACKENDS.find((backend) => OWNED_PREFIXES[backend] !== '' && name.startsWith(OWNED_PREFIXES[backend])) ??
    'database';

function awsPrefix(raw: string): string {
    const segments = raw.split('/');
    if (raw.length > MAX_PREFIX_CHARS || !segments.every((segment) => PREFIX_SEGMENT.test(segment))) {
        throw new SecretKeyConfigError(
            `SECRETS_AWS_PREFIX must be slash-separated names of letters, digits and _+=.@- (at most ${MAX_PREFIX_CHARS} characters), with no leading or trailing slash`
        );
    }
    return raw;
}

/** A Vault path of slash-separated names that cannot start with a dot, so none is `.` or `..` for a URL to resolve. */
function vaultPath(name: string, raw: string): string {
    const segments = raw.split('/');
    if (raw.length > MAX_PREFIX_CHARS || !segments.every((segment) => VAULT_SEGMENT.test(segment))) {
        throw new SecretKeyConfigError(
            `${name} must be slash-separated names of letters, digits and _+=.@- that do not start with a dot (at most ${MAX_PREFIX_CHARS} characters), with no leading or trailing slash`
        );
    }
    return raw;
}

function vaultAddr(raw: string): string {
    try {
        const url = new URL(raw);
        const bare = url.pathname === '/' && url.search === '' && url.hash === '' && !url.username && !url.password;
        if ((url.protocol === 'http:' || url.protocol === 'https:') && bare) {
            return raw.replace(/\/$/, '');
        }
    } catch {
        // Falls through to the one refusal below.
    }
    throw new SecretKeyConfigError(
        'SECRETS_VAULT_ADDR must be an http or https origin with no path, credentials or query'
    );
}

function awsEndpoint(raw: string | undefined): string | null {
    if (raw === undefined) {
        return null;
    }
    try {
        const url = new URL(raw);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
            return raw;
        }
    } catch {
        // Falls through to the one refusal below.
    }
    throw new SecretKeyConfigError('SECRETS_AWS_ENDPOINT must be an http or https URL');
}

/** Static keys for development, both or neither; with neither, a workload identity must be present. */
function awsCredentials(env: Env): AwsBackendConfig['staticCredentials'] {
    const accessKeyId = trimmed(env, 'SECRETS_AWS_ACCESS_KEY_ID');
    const secretAccessKey = trimmed(env, 'SECRETS_AWS_SECRET_ACCESS_KEY');
    if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
        throw new SecretKeyConfigError(
            'SECRETS_AWS_ACCESS_KEY_ID and SECRETS_AWS_SECRET_ACCESS_KEY must be set together'
        );
    }
    if (accessKeyId !== undefined && secretAccessKey !== undefined) {
        return { accessKeyId, secretAccessKey };
    }
    const podIdentity =
        trimmed(env, 'AWS_CONTAINER_CREDENTIALS_FULL_URI') && trimmed(env, 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE');
    const irsa = trimmed(env, 'AWS_WEB_IDENTITY_TOKEN_FILE') && trimmed(env, 'AWS_ROLE_ARN');
    if (!podIdentity && !irsa) {
        throw new SecretKeyConfigError(
            'SECRETS_BACKEND=aws has no credentials: run with an IRSA role or EKS Pod Identity, or set SECRETS_AWS_ACCESS_KEY_ID and SECRETS_AWS_SECRET_ACCESS_KEY for development'
        );
    }
    return null;
}

function loadAws(env: Env): AwsBackendConfig {
    const region = required(env, 'SECRETS_AWS_REGION');
    if (!REGION.test(region)) {
        throw new SecretKeyConfigError('SECRETS_AWS_REGION must be an AWS region name such as eu-west-1');
    }
    return {
        region,
        prefix: awsPrefix(required(env, 'SECRETS_AWS_PREFIX')),
        endpoint: awsEndpoint(trimmed(env, 'SECRETS_AWS_ENDPOINT')),
        staticCredentials: awsCredentials(env),
    };
}

const VAULT_AUTH_METHODS = ['kubernetes', 'token'] as const;
/** Variables that belong to one auth method; set under the other they are refused, as a foreign backend's are. */
const VAULT_AUTH_VARIABLES: Record<(typeof VAULT_AUTH_METHODS)[number], string[]> = {
    kubernetes: ['SECRETS_VAULT_ROLE', 'SECRETS_VAULT_TOKEN_FILE'],
    token: ['SECRETS_VAULT_TOKEN'],
};

function vaultAuth(env: Env): VaultAuth {
    const raw = required(env, 'SECRETS_VAULT_AUTH');
    const method = VAULT_AUTH_METHODS.find((name) => name === raw);
    if (method === undefined) {
        throw new SecretKeyConfigError(`SECRETS_VAULT_AUTH must be one of ${VAULT_AUTH_METHODS.join(', ')}`);
    }
    const other = VAULT_AUTH_METHODS.find((name) => name !== method) ?? method;
    for (const name of VAULT_AUTH_VARIABLES[other]) {
        if (trimmed(env, name) !== undefined) {
            throw new SecretKeyConfigError(`${name} is only valid with SECRETS_VAULT_AUTH=${other}`);
        }
    }
    if (method === 'token') {
        return { kind: 'token', token: required(env, 'SECRETS_VAULT_TOKEN') };
    }
    return {
        kind: 'kubernetes',
        role: required(env, 'SECRETS_VAULT_ROLE'),
        tokenFile: required(env, 'SECRETS_VAULT_TOKEN_FILE'),
    };
}

function loadVault(env: Env): VaultBackendConfig {
    return {
        addr: vaultAddr(required(env, 'SECRETS_VAULT_ADDR')),
        mount: vaultPath('SECRETS_VAULT_MOUNT', required(env, 'SECRETS_VAULT_MOUNT')),
        prefix: vaultPath('SECRETS_VAULT_PREFIX', required(env, 'SECRETS_VAULT_PREFIX')),
        auth: vaultAuth(env),
    };
}

export function loadSecretBackend(env: Env): SecretBackendConfig {
    const raw = trimmed(env, 'SECRETS_BACKEND');
    if (raw === undefined) {
        throw new SecretKeyConfigError(
            'SECRETS_BACKEND is required (database, aws or vault); for an existing secrets.env, run `npm run secrets:init` to add it'
        );
    }
    const mode = BACKENDS.find((name) => name === raw);
    if (mode === undefined) {
        throw new SecretKeyConfigError(`SECRETS_BACKEND must be one of ${BACKENDS.join(', ')}`);
    }
    refuseForeign(env, mode);
    if (mode === 'database') {
        return { kind: 'database', keys: loadSecretKeys(env) };
    }
    if (mode === 'vault') {
        return { kind: 'vault', keys: loadOperationKeys(env), vault: loadVault(env) };
    }
    return { kind: 'aws', keys: loadOperationKeys(env), aws: loadAws(env) };
}

/** The data keys key rotation re-encrypts under; an external backend has none, so it has nothing to rotate. */
export function rotationKeys(env: Env): SecretKeys {
    const backend = loadSecretBackend(env);
    if (backend.kind !== 'database') {
        throw new SecretKeyConfigError(
            `rotation re-encrypts database payloads, so it needs SECRETS_BACKEND=database; this deployment uses ${backend.kind}`
        );
    }
    return backend.keys;
}

export interface SecretStoreOptions {
    sql: Sql;
    ready?: Promise<unknown> | undefined;
    backend: SecretBackendConfig;
    log?: ((diagnostic: SecretDiagnostic) => void) | undefined;
    /** The process environment the workload-identity variables are read from. */
    env?: NodeJS.ProcessEnv | undefined;
}

/** The store for the selected backend. Database mode also offers rotation; use `createPostgresSecretStore` for that. */
export function createSecretStore(options: SecretStoreOptions): CoordinatedSecretStore {
    const { sql, ready, backend, log } = options;
    if (backend.kind === 'database') {
        return createPostgresSecretStore({ sql, ready, keys: backend.keys, log });
    }
    const client =
        backend.kind === 'vault'
            ? createVaultObjectClient(backend.vault)
            : createAwsClient(backend.aws, options.env ?? process.env);
    return createSecretStoreOver({
        repo: createSecretRepo(sql),
        keys: backend.keys,
        payloads: createExternalPayloads(client, backend.keys),
        ready,
        log,
    });
}

function createAwsClient(aws: AwsBackendConfig, env: NodeJS.ProcessEnv) {
    return createAwsObjectClient({
        region: aws.region,
        prefix: aws.prefix,
        endpoint: aws.endpoint ?? undefined,
        credentials: createCredentialProvider({ static: aws.staticCredentials, env, region: aws.region }),
    });
}
