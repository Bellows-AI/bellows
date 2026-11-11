import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createGcsStore } from '../src/artifacts/gcs-store.js';
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

/**
 * A fake of the slice of the GCS JSON API the store uses, in this process: create-only upload
 * (`ifGenerationMatch=0` answers 412 for a taken name), media read, size metadata and delete. One
 * server for the run; each `make()` gets its own bucket name, so stores stay isolated.
 */
const gcsObjects = new Map<string, Uint8Array>();
const gcsServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
        const upload = url.pathname.match(/^\/upload\/storage\/v1\/b\/([^/]+)\/o$/);
        const object = url.pathname.match(/^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/);
        const reply = (status: number, body: string | Uint8Array = '') => {
            res.writeHead(status);
            res.end(body);
        };
        if (req.method === 'POST' && upload) {
            const id = `${upload[1]}/${url.searchParams.get('name')}`;
            if (url.searchParams.get('ifGenerationMatch') !== '0') return reply(400);
            if (gcsObjects.has(id)) return reply(412);
            gcsObjects.set(id, new Uint8Array(Buffer.concat(chunks)));
            return reply(200, '{}');
        }
        if (object) {
            const id = `${object[1]}/${decodeURIComponent(object[2]!)}`;
            const body = gcsObjects.get(id);
            if (req.method === 'DELETE') {
                gcsObjects.delete(id);
                return reply(body ? 204 : 404);
            }
            if (!body) return reply(404);
            return url.searchParams.get('alt') === 'media'
                ? reply(200, body)
                : reply(200, JSON.stringify({ size: String(body.byteLength) }));
        }
        return reply(400);
    });
});
const gcsEndpoint = await new Promise<string>((resolve) => {
    gcsServer.listen(0, '127.0.0.1', () => {
        gcsServer.unref();
        const address = gcsServer.address();
        resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`);
    });
});

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
    {
        name: 'gcs (in-process fake)',
        prefix: 'factory/',
        skip: false,
        make: async () =>
            createGcsStore({
                bucket: `factory-test-${randomUUID().slice(0, 8)}`,
                kmsKey: '',
                token: async () => 'test-token',
                endpoint: gcsEndpoint,
            }),
    },
];
