import { isAbsolute } from 'node:path';
import { normalizePrefix } from './keys.js';

/**
 * Where artifacts live (docs/configuration.md). Environment only, parsed by `loadConfig` like the
 * rest; the chart's `artifacts:` values render to exactly these variables.
 */
export type ArtifactBackendConfig =
    | {
          readonly kind: 'filesystem';
          /** Absolute. A directory is the store, so this is a single-replica backend. */
          readonly root: string;
      }
    | {
          readonly kind: 's3';
          readonly bucket: string;
          readonly region: string;
          /** Empty: AWS. Set for an S3-compatible store. */
          readonly endpoint: string;
          readonly forcePathStyle: boolean;
          /** Normalized: empty or one trailing slash. */
          readonly prefix: string;
          /** Empty: SSE-S3. */
          readonly kmsKeyId: string;
          /** Both keys or neither; neither means Pod Identity, then IRSA. */
          readonly staticCredentials: { accessKeyId: string; secretAccessKey: string } | null;
      };

export interface ArtifactsConfig {
    readonly backend: ArtifactBackendConfig;
    /** A board sweep deletes artifacts of a removed task after this many days. */
    readonly retentionDays: number;
    /** Per-org byte quota; 0 is off. */
    readonly orgQuotaBytes: number;
}

const BACKENDS = ['s3', 'filesystem'] as const;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_S3_PREFIX = 'factory/';
const DEFAULT_REGION = 'us-east-1';
const DEFAULT_FILESYSTEM_DIR = 'factory-artifacts';

function count(raw: string | undefined, fallback: number, label: string, min: number): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) {
        throw new Error(`${label} must be an integer >= ${min}, got "${raw}"`);
    }
    return value;
}

function flag(raw: string | undefined, label: string): boolean {
    const value = raw?.trim().toLowerCase();
    if (value === undefined || value === '') return false;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new Error(`${label} must be true or false, got "${raw}"`);
}

function backendOf(env: NodeJS.ProcessEnv): ArtifactBackendConfig {
    const raw = env.ARTIFACTS_BACKEND?.trim() || 'filesystem';
    const kind = BACKENDS.find((name) => name === raw);
    if (!kind) throw new Error(`ARTIFACTS_BACKEND must be "s3" or "filesystem", got "${raw}"`);
    if (kind === 'filesystem') {
        const root = env.ARTIFACTS_FS_ROOT?.trim() || `${env.TMPDIR?.trim() || '/tmp'}/${DEFAULT_FILESYSTEM_DIR}`;
        if (!isAbsolute(root)) throw new Error(`ARTIFACTS_FS_ROOT must be an absolute path, got "${root}"`);
        return { kind, root };
    }
    return s3BackendOf(env);
}

function s3BackendOf(env: NodeJS.ProcessEnv): Extract<ArtifactBackendConfig, { kind: 's3' }> {
    const bucket = env.ARTIFACTS_S3_BUCKET?.trim() ?? '';
    if (!bucket) throw new Error('ARTIFACTS_S3_BUCKET is required when ARTIFACTS_BACKEND is "s3"');
    const endpoint = env.ARTIFACTS_S3_ENDPOINT?.trim() ?? '';
    const region = env.ARTIFACTS_S3_REGION?.trim() || (endpoint ? DEFAULT_REGION : '');
    if (!region) throw new Error('ARTIFACTS_S3_REGION is required when ARTIFACTS_BACKEND is "s3" without an endpoint');
    const accessKeyId = env.ARTIFACTS_ACCESS_KEY_ID?.trim() ?? '';
    const secretAccessKey = env.ARTIFACTS_SECRET_ACCESS_KEY?.trim() ?? '';
    if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
        throw new Error('ARTIFACTS_ACCESS_KEY_ID and ARTIFACTS_SECRET_ACCESS_KEY must be set together');
    }
    return {
        kind: 's3',
        bucket,
        region,
        endpoint,
        forcePathStyle: flag(env.ARTIFACTS_S3_FORCE_PATH_STYLE, 'ARTIFACTS_S3_FORCE_PATH_STYLE'),
        prefix: normalizePrefix(env.ARTIFACTS_S3_PREFIX ?? DEFAULT_S3_PREFIX),
        kmsKeyId: env.ARTIFACTS_S3_KMS_KEY_ID?.trim() ?? '',
        staticCredentials: accessKeyId ? { accessKeyId, secretAccessKey } : null,
    };
}

export function loadArtifactsConfig(env: NodeJS.ProcessEnv): ArtifactsConfig {
    return {
        backend: backendOf(env),
        retentionDays: count(env.ARTIFACTS_RETENTION_DAYS, DEFAULT_RETENTION_DAYS, 'ARTIFACTS_RETENTION_DAYS', 1),
        orgQuotaBytes: count(env.ARTIFACTS_ORG_QUOTA_BYTES, 0, 'ARTIFACTS_ORG_QUOTA_BYTES', 0),
    };
}
