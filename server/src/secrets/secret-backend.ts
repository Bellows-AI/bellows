import type { Sql } from 'postgres';
import { createCredentialProvider } from '../artifacts/s3-credentials.js';
import { createAwsObjectClient } from './aws-secrets-manager.js';
import { createExternalPayloads } from './external-payloads.js';
import { createGcpTokenProvider } from './gcp-credentials.js';
import { createGcpObjectClient } from './gcp-secret-manager.js';
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
 * Which backend holds the secret payloads (docs/secrets.md): `SECRETS_BACKEND=database|aws|vault|gcp`, required on
 * every boot with no default, one per deployment. Pure: no I/O, and every refusal names a variable and never a
 * value. A variable that belongs to another backend is refused rather than ignored, because a deployment that
 * thinks it is on one backend while configured for another is the failure this rules out.
 */

export const BACKENDS = ['database', 'aws', 'vault', 'gcp'] as const;
export type SecretBackendName = (typeof BACKENDS)[number];

/** Variables that only make sense in one backend; set in another they are refused. */
const OWNED_PREFIXES: Record<SecretBackendName, string> = {
    database: '',
    aws: 'SECRETS_AWS_',
    vault: 'SECRETS_VAULT_',
    gcp: 'SECRETS_GCP_',
};
const DATA_KEY_VARIABLES = ['SECRETS_DATA_KEYS', 'SECRETS_ACTIVE_KEY_ID'];

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const PREFIX_SEGMENT = /^[A-Za-z0-9_+=.@-]+$/;
const MAX_PREFIX_CHARS = 200;
const GCP_PROJECT = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]+)$/;
const GCP_PREFIX = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const GCP_LOCATION = /^[a-z]+-[a-z]+[0-9]+$/;
const GCP_KMS_KEY = /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/;
const GCP_DEFAULT_PREFIX = 'bellows-';
const GCP_DEFAULT_LOCATION = 'europe-west3';
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

export interface GcpBackendConfig {
    /** The project id the secrets live in; credentials come from Application Default Credentials only. */
    project: string;
    /** Starts every secret's name, so an IAM condition on the name prefix can fence the backend in. */
    prefix: string;
    /** The one region a secret is replicated to (user-managed replication). */
    location: string;
    /** The customer-managed key that encrypts the replica, or null for Google-managed encryption. */
    kmsKey: string | null;
}

export type SecretBackendConfig =
    | { kind: 'database'; keys: SecretKeys }
    | { kind: 'aws'; keys: OperationKeys; aws: AwsBackendConfig }
    | { kind: 'vault'; keys: OperationKeys; vault: VaultBackendConfig }
    | { kind: 'gcp'; keys: OperationKeys; gcp: GcpBackendConfig };

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

interface GcpSetting {
    pattern: RegExp;
    fallback: string | null;
    shape: string;
}

/** A GCP setting that must match its shape; the refusal names the variable and never the value. */
function gcpSetting(env: Env, name: string, { pattern, fallback, shape }: GcpSetting): string | null {
    const raw = trimmed(env, name) ?? fallback;
    if (raw !== null && !pattern.test(raw)) {
        throw new SecretKeyConfigError(`${name} must be ${shape}`);
    }
    return raw;
}

function loadGcp(env: Env): GcpBackendConfig {
    const project = gcpSetting(env, 'SECRETS_GCP_PROJECT', {
        pattern: GCP_PROJECT,
        fallback: required(env, 'SECRETS_GCP_PROJECT'),
        shape: 'a Google Cloud project id or number',
    });
    const prefix = gcpSetting(env, 'SECRETS_GCP_PREFIX', {
        pattern: GCP_PREFIX,
        fallback: GCP_DEFAULT_PREFIX,
        shape: 'a non-empty name of letters, digits, _ and -, starting with a letter (at most 128 characters)',
    });
    const location = gcpSetting(env, 'SECRETS_GCP_LOCATION', {
        pattern: GCP_LOCATION,
        fallback: GCP_DEFAULT_LOCATION,
        shape: 'a Google Cloud region name such as europe-west3',
    });
    const kmsKey = gcpSetting(env, 'SECRETS_GCP_KMS_KEY', {
        pattern: GCP_KMS_KEY,
        fallback: null,
        shape: 'a key name projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key> with no version',
    });
    return {
        project: project ?? '',
        prefix: prefix ?? GCP_DEFAULT_PREFIX,
        location: location ?? GCP_DEFAULT_LOCATION,
        kmsKey,
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
            'SECRETS_BACKEND is required (database, aws, vault or gcp); for an existing secrets.env, run `npm run secrets:init` to add it'
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
    if (mode === 'gcp') {
        return { kind: 'gcp', keys: loadOperationKeys(env), gcp: loadGcp(env) };
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
    const env = options.env ?? process.env;
    const client =
        backend.kind === 'vault'
            ? createVaultObjectClient(backend.vault)
            : backend.kind === 'gcp'
              ? createGcpClient(backend.gcp, env)
              : createAwsClient(backend.aws, env);
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

function createGcpClient(gcp: GcpBackendConfig, env: NodeJS.ProcessEnv) {
    return createGcpObjectClient({ ...gcp, credentials: createGcpTokenProvider({ env }) });
}
