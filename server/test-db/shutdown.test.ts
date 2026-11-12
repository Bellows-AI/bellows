import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { LOCAL_ORG_ID } from '../src/identifiers.js';
import { start } from '../src/main.js';
import { SHUTDOWN_DEADLINE_MS } from '../src/shutdown.js';
import { useTestDb } from './harness.js';

/**
 * Graceful shutdown: `start()` returns a handle whose `close()` answers the open settle long-polls at once,
 * refuses new requests, settles every loop and ends the pools — all inside one deadline, so a SIGTERM never strands a
 * request until its timeout nor cuts a pass mid-query.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ orgs: [LOCAL_ORG_ID] });

afterEach(() => {
    vi.unstubAllEnvs();
});

const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as { port: number };
            probe.close(() => resolve(port));
        });
    });

const key = () => randomBytes(32).toString('base64');

describe.skipIf(!enabled)('start().close()', () => {
    it('answers a settle long-poll at once, refuses new requests and ends within the deadline', async () => {
        const port = await freePort();
        for (const [name, value] of Object.entries({
            DATABASE_URL: db.url!,
            AUTH_MODE: 'none',
            HOST: '127.0.0.1',
            PORT: String(port),
            SECRETS_BACKEND: 'database',
            SECRETS_DATA_KEYS: `k1:${key()}`,
            SECRETS_ACTIVE_KEY_ID: 'k1',
            SECRETS_OPERATION_KEY: key(),
            SECRETS_FINGERPRINT_KEY: key(),
        })) {
            vi.stubEnv(name, value);
        }
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const { close } = await start({ github: { mode: 'none' } });
        const base = `http://127.0.0.1:${port}`;
        try {
            const jobs = createJobStore({
                sql: db.sql,
                orgId: LOCAL_ORG_ID,
                prs: createPrLifecycleStore({ sql: db.sql, orgId: LOCAL_ORG_ID }),
            });
            const ref = await jobs.create('echo hi', null, { repo: null, executor: null });
            if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
            const { id } = ref;

            const polling = fetch(`${base}/api/jobs/${id}?waitFor=terminal&timeout=30`, {
                headers: { connection: 'close' },
            });
            await new Promise((resolve) => setTimeout(resolve, 600));

            const began = Date.now();
            const closing = close();
            const held = await polling;
            const heldFor = Date.now() - began;
            expect(held.status).toBe(200);
            expect(await held.json()).toMatchObject({ result: 'timeout' });
            expect(heldFor).toBeLessThan(5_000);

            const refused = await fetch(`${base}/api/jobs/${id}`).then(
                (r) => r.status,
                () => 'refused'
            );
            expect([503, 'refused']).toContain(refused);

            await closing;
            expect(Date.now() - began).toBeLessThan(SHUTDOWN_DEADLINE_MS);
            // The pools are ended: one more close is the same settled promise, not a second teardown.
            await expect(close()).resolves.toBeUndefined();
        } finally {
            await close().catch(() => {});
        }
    });
});
