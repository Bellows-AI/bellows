import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The fake forge serves https when it is given a certificate (`FAKE_FORGE_TLS_CERT`): the lanes' GitLab is reached by
 * the runner's helper, which answers https only, and by the board, which trusts the connection's CA bundle.
 */
const ROOT = new URL('../..', import.meta.url).pathname;
const { createFakeForge } = (await import(pathToFileURL(join(ROOT, 'scripts/fake-forge/server.mjs')).href)) as {
    createFakeForge: (options: { stateDir: string; tls: { cert: Buffer; key: Buffer } }) => {
        listen: (port: number, host: string) => Promise<number>;
        close: () => Promise<void>;
    };
};

let dir: string;
let ca: Buffer;
let forge: ReturnType<typeof createFakeForge>;
let port: number;

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fake-tls-'));
    execFileSync(
        'openssl',
        [
            ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=fake-gitlab'],
            ...[
                '-addext',
                'subjectAltName=IP:127.0.0.1',
                '-keyout',
                join(dir, 'key.pem'),
                '-out',
                join(dir, 'cert.pem'),
            ],
        ],
        { stdio: 'ignore' }
    );
    ca = readFileSync(join(dir, 'cert.pem'));
    forge = createFakeForge({
        stateDir: join(dir, 'state'),
        tls: { cert: ca, key: readFileSync(join(dir, 'key.pem')) },
    });
    port = await forge.listen(0, '127.0.0.1');
});
afterAll(async () => {
    await forge?.close();
    rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, trust: Buffer | undefined) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
        request({ host: '127.0.0.1', port, path, ...(trust ? { ca: trust } : {}) }, (response) => {
            let body = '';
            response.on('data', (chunk) => (body += chunk));
            response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        })
            .on('error', reject)
            .end();
    });

describe('the fake forge over TLS', () => {
    it('answers https to a client that trusts its certificate', async () => {
        const answer = await get('/api/v4/version', ca);
        expect(answer.status).toBe(401);
    });

    it('is refused by a client that does not trust it', async () => {
        await expect(get('/api/v4/version', undefined)).rejects.toThrow(/self[- ]signed|certificate/i);
    });
});
