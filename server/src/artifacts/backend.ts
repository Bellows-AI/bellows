import { mkdir } from 'node:fs/promises';
import type { ArtifactsConfig } from '../config-artifacts.js';
import { createFilesystemStore } from './fs-store.js';
import type { ObjectStore } from './object-store.js';
import { createCredentialProvider } from './s3-credentials.js';
import { createS3Store } from './s3-store.js';

export interface ArtifactBackend {
    objects: ObjectStore;
    /** Key prefix for this backend: the S3 prefix, empty for the filesystem (its root is the prefix). */
    prefix: string;
    /** Boot step: makes the filesystem root, or creates a missing bucket. Returns a log line. */
    prepare(): Promise<string>;
}

const PREPARE_ATTEMPTS = 10;
const PREPARE_BACKOFF_MS = 3000;

/**
 * Runs the backend's boot step, retrying: a declared service starts with no health wait, so a
 * first refused connection is usually a store still booting. Never throws and never blocks the
 * caller — the dashboard serves without artifacts, and a write that cannot reach the store fails
 * on its own.
 */
export async function prepareArtifactBackend(
    backend: ArtifactBackend,
    log: (line: string) => void,
    backoffMs = PREPARE_BACKOFF_MS
): Promise<void> {
    for (let attempt = 1; attempt <= PREPARE_ATTEMPTS; attempt++) {
        try {
            log(await backend.prepare());
            return;
        } catch (e) {
            log(`prepare failed (${attempt}/${PREPARE_ATTEMPTS}): ${(e as Error).message}`);
            if (attempt < PREPARE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
    }
}

/** The one place the configured backend becomes an `ObjectStore`; the process builds it once. */
export function createArtifactBackend(config: ArtifactsConfig, env: NodeJS.ProcessEnv = process.env): ArtifactBackend {
    const { backend } = config;
    if (backend.kind === 'filesystem') {
        return {
            objects: createFilesystemStore(backend.root),
            prefix: '',
            async prepare() {
                await mkdir(backend.root, { recursive: true });
                return `filesystem ${backend.root} (single replica only)`;
            },
        };
    }
    const s3 = createS3Store({
        bucket: backend.bucket,
        region: backend.region,
        endpoint: backend.endpoint,
        forcePathStyle: backend.forcePathStyle,
        kmsKeyId: backend.kmsKeyId,
        credentials: createCredentialProvider({ static: backend.staticCredentials, env, region: backend.region }),
    });
    return {
        objects: s3,
        prefix: backend.prefix,
        async prepare() {
            const bucket = await s3.ensureBucket();
            return `s3 bucket ${backend.bucket} ${bucket === 'created' ? 'created' : 'ready'}${backend.endpoint ? ` at ${backend.endpoint}` : ''}`;
        },
    };
}
