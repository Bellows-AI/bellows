import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildApp } from '../src/app.js';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import { hashToken } from '../src/auth/session.js';
import { type AuthStore, createAuthStore } from '../src/auth/store.js';
import { runOrgPurgePass } from '../src/db/org-purge.js';
import { createOrgRegistry } from '../src/orgs.js';
import { githubAuth, testConfig } from '../test/helpers-config.js';
import { testSecretStore } from './env-secrets-harness.js';
import { randomGithubId, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The erasure script (`scripts/org-erasure.mjs`, docs/organizations.md) over HTTP against the real operator routes:
 * it shows the org, suspends it, queues the purge, waits until the org is gone, and prints a receipt. It never reports
 * done on an inconclusive read, and a declined confirmation changes nothing.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/org-erasure.mjs', import.meta.url));
const { eraseOrg } = (await import(SCRIPT)) as { eraseOrg: (options: Record<string, unknown>) => Promise<unknown> };
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

let sql: Sql;
let auth: AuthStore;
let app: FastifyInstance;
let baseUrl: string;
let org: string;
let operatorToken: string;

async function signInto(orgId: string): Promise<{ userId: string; githubUserId: number }> {
    const githubUserId = randomGithubId();
    const login = `u-${randomUUID().slice(0, 8)}`;
    const caller = await auth.signIn({ githubUserId, login, displayName: login, avatarUrl: null }, orgId, [
        { id: orgId, name: `acct-${orgId}` },
    ]);
    return { userId: caller.user.id, githubUserId };
}

beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    auth = createAuthStore({ sql });
    org = testOrg();
    const operatorOrg = testOrg();
    await signInto(org);
    const operator = await signInto(operatorOrg);
    operatorToken = `fat_${randomUUID()}`;
    await auth.createAccessToken({
        kind: 'personal',
        orgId: operatorOrg,
        userId: operator.userId,
        createdBy: operator.userId,
        label: 'operator',
        tokenHash: hashToken(operatorToken),
    });
    const ready = Promise.resolve();
    const config = testConfig({
        auth: githubAuth(),
        deploymentMode: 'cloud',
        operatorGithubIds: [operator.githubUserId],
    });
    app = await buildApp({
        config,
        orgs: createOrgRegistry({
            sql,
            ready,
            config,
            withStores: true,
            secrets: testSecretStore(sql),
            secretLog: () => {},
        }),
        auth,
        ready,
        version: '0.0.0',
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
    if (enabled) await app?.close();
});

/** A sleep that lets the board's purge run one pass, standing in for the interval loop. */
const purgePass = async () =>
    runOrgPurgePass({
        sql,
        secrets: {
            issueOperationId: async () => {
                throw new Error('the org owns no secret');
            },
            delete: async () => {
                throw new Error('the org owns no secret');
            },
            reconcileOperation: async () => {
                throw new Error('the org owns no secret');
            },
            collect: async () => undefined,
        },
        objects: createFilesystemStore(await mkdtemp(join(tmpdir(), 'org-erasure-'))),
        prefix: 'factory/',
        deploymentMode: 'cloud',
        log: () => {},
        writeDrainMs: 0,
    });

const run = (over: Record<string, unknown> = {}) => {
    const out: string[] = [];
    return {
        out,
        done: eraseOrg({
            baseUrl,
            token: operatorToken,
            orgId: org,
            yes: true,
            out: (line: string) => out.push(line),
            sleep: purgePass,
            pollMs: 0,
            ...over,
        }) as Promise<{ ok: boolean; reason?: string; receipt?: string }>,
    };
};

describe.skipIf(!enabled)('the org erasure script', () => {
    it('suspends, queues the purge, waits for the org to be gone and prints a receipt', async () => {
        const { out, done } = run();
        const result = await done;
        expect(result.ok).toBe(true);
        expect(out[0]).toContain(`Organization ${org} (acct-${org}), status active`);
        expect(out[0]).toContain('members: 1');
        expect(out).toContain('suspended');
        expect(out).toContain('purge queued');
        expect(result.receipt).toContain(`Organization id:        ${org}`);
        expect(result.receipt).toContain('within 7 days');
        expect(result.receipt).toContain('GitHub App');
        expect(await sql`select 1 from organization where id = ${org}`).toHaveLength(0);
    });

    it('changes nothing when the confirmation is declined', async () => {
        const { done } = run({ yes: false, confirm: async () => false });
        expect(await done).toMatchObject({ ok: false });
        expect((await sql<{ status: string }[]>`select status from organization where id = ${org}`)[0]?.status).toBe(
            'active'
        );
    });

    it('never reports done on an unconfirmed read, and reports the purge’s last_error', async () => {
        let reads = 0;
        const flaky = async (url: string, init?: RequestInit) => {
            const isRead = (init?.method ?? 'GET') === 'GET';
            if (isRead && reads++ >= 1) throw new Error('connection reset');
            return fetch(url, init);
        };
        await sql`update organization set status = 'suspended' where id = ${org}`;
        const { out, done } = run({ fetch: flaky, sleep: async () => undefined, timeoutMs: 0 });
        const result = await done;
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('inconclusive');
        expect(out.join('\n')).not.toContain('receipt');

        await sql`update org_purge set last_error = 'objects-unconfirmed' where org_id = ${org}`;
        const again = run({ sleep: async () => undefined, timeoutMs: 0 });
        expect((await again.done).reason).toContain('last_error objects-unconfirmed');
    });

    it('refuses an unknown org', async () => {
        const result = await run({ orgId: testOrg() }).done;
        expect(result).toMatchObject({ ok: false });
        expect(result.reason).toContain('no organization');
    });
});
