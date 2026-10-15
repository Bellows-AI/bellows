import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import type { ObjectStore } from '../src/artifacts/object-store.js';
import { createCredentialProvider } from '../src/artifacts/s3-credentials.js';
import { createS3Store } from '../src/artifacts/s3-store.js';

/**
 * The two backends the artifact suites run against. The S3 one talks to the `s3` service that
 * `.bellows.yaml` declares (RustFS, credentials as set there) — the same container compose runs —
 * so it exists only where that service does: `s3Reachable` is false on a laptop with no compose
 * stack, and the S3 suites skip there rather than fail. `ARTIFACTS_TEST_S3_ENDPOINT` points them at
 * another store; `ARTIFACTS_TEST_REQUIRE_S3=1` turns an unreachable store into a failure.
 */
const S3_ENDPOINT = process.env.ARTIFACTS_TEST_S3_ENDPOINT ?? 'http://s3:9000';
const S3_KEYS = { accessKeyId: 'factory', secretAccessKey: 'factory-dev' };
const PROBE_TIMEOUT_MS = 2000;

async function probe(): Promise<boolean> {
    try {
        await fetch(`${S3_ENDPOINT}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return true;
    } catch {
        return false;
    }
}

export const s3Reachable = await probe();
if (!s3Reachable && process.env.ARTIFACTS_TEST_REQUIRE_S3) {
    throw new Error(`ARTIFACTS_TEST_REQUIRE_S3 is set but ${S3_ENDPOINT} is unreachable`);
}

export interface TestBackend {
    name: string;
    /** A fresh, isolated store: its own directory, or its own bucket. */
    make(): Promise<ObjectStore>;
    /** The key prefix the backend runs under, as its config would normalize it. */
    prefix: string;
    skip: boolean;
}

export const BACKENDS: TestBackend[] = [
    {
        name: 'filesystem',
        prefix: '',
        skip: false,
        make: async () => createFilesystemStore(await mkdtemp(join(tmpdir(), 'factory-artifacts-'))),
    },
    {
        name: 's3 (RustFS)',
        prefix: 'factory/',
        skip: !s3Reachable,
        make: async () => {
            const store = createS3Store({
                bucket: `factory-test-${randomUUID().slice(0, 8)}`,
                region: 'us-east-1',
                endpoint: S3_ENDPOINT,
                forcePathStyle: true,
                kmsKeyId: '',
                credentials: createCredentialProvider({ static: S3_KEYS, env: {}, region: 'us-east-1' }),
            });
            await store.ensureBucket();
            return store;
        },
    },
];
