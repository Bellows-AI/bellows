import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ArtifactBackend } from '../src/artifacts/backend.js';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import { chunkKey } from '../src/artifacts/keys.js';
import type { ObjectStore } from '../src/artifacts/object-store.js';
import { attachmentKey } from '../src/attachments/attachment-store.js';
import { hashToken } from '../src/auth/session.js';
import { type AuthStore, createAuthStore } from '../src/auth/store.js';
import { EXPORT_OMITTED_COLUMNS, EXPORT_PAGE_ROWS } from '../src/db/org-export.js';
import { ORG_TABLES } from '../src/db/org-tables.js';
import { skillObjectKey } from '../src/db/skill-store.js';
import { ORG_OWNER } from '../src/notifications/subscription-store.js';
import { createOrgRegistry, type OrgRuntime } from '../src/orgs.js';
import { githubAuth, testConfig } from '../test/helpers-config.js';
import { testSecretStore } from './env-secrets-harness.js';
import { craftJob, randomGithubId, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * `GET /api/org/export`: an admin streams one tar of the caller's organization — an NDJSON file per registered org
 * table, read in pages, and the bodies of the org's objects — with no secret value, credential or other org's row
 * in it. A member is refused; every export writes an audit row; the stream settles on abort and on a failed read,
 * and leaves no pool connection behind.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

const OK = 200;
const FORBIDDEN = 403;
const PREFIX = 'factory/';

interface Person {
    userId: string;
    token: string;
}

let sql: Sql;
let auth: AuthStore;
let app: FastifyInstance;
let objects: ObjectStore;
let org: string;
let otherOrg: string;
let admin: Person;
let member: Person;

const bytes = (text: string) => new TextEncoder().encode(text);
const backendOf = (store: ObjectStore): ArtifactBackend => ({
    objects: store,
    prefix: PREFIX,
    prepare: async () => 'ready',
});
const streamRef = (job: string, stream: string) => ({
    member: 'member-1',
    root: job,
    job,
    claimSeq: 1,
    executor: 'claude-code',
    session: 'session-1',
    stream,
});

async function personIn(orgId: string): Promise<Person> {
    const login = `u-${randomUUID().slice(0, 8)}`;
    const caller = await auth.signIn(
        { githubUserId: randomGithubId(), login, displayName: login, avatarUrl: null },
        orgId,
        [{ id: orgId, name: orgId }]
    );
    const token = `fat_${randomUUID()}`;
    await auth.createAccessToken({
        kind: 'personal',
        orgId,
        userId: caller.user.id,
        createdBy: caller.user.id,
        label: 'export',
        tokenHash: hashToken(token),
    });
    return { userId: caller.user.id, token };
}

const registryOver = (pool: Sql, store: ObjectStore) => {
    const config = testConfig({ auth: githubAuth() });
    return createOrgRegistry({
        sql: pool,
        ready: Promise.resolve(),
        config,
        withStores: true,
        secrets: testSecretStore(pool),
        secretLog: () => {},
        artifacts: backendOf(store),
    });
};

async function boot(pool: Sql = sql, store: ObjectStore = objects): Promise<void> {
    const ready = Promise.resolve();
    const config = testConfig({ auth: githubAuth() });
    app = await buildApp({ config, orgs: registryOver(pool, store), auth, ready, version: '0.0.0' });
}

const runtimeOf = async (orgId: string): Promise<OrgRuntime> =>
    (await registryOver(sql, objects).for(orgId)) as OrgRuntime;

beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    [org, otherOrg] = [testOrg(), testOrg()];
    for (const id of [org, otherOrg]) await sql`insert into organization (id, name) values (${id}, ${id})`;
    auth = createAuthStore({ sql });
    admin = await personIn(org);
    member = await personIn(org);
    objects = createFilesystemStore(await mkdtemp(join(tmpdir(), 'factory-export-')));
    await boot();
});

afterEach(async () => {
    if (enabled) await app?.close();
});

const exportAs = (who: Person) =>
    app.inject({ method: 'GET', url: '/api/org/export', headers: { authorization: `Bearer ${who.token}` } });

/** Extracts the archive with the system `tar`, which refuses a malformed one, and answers the directory. */
async function extract(archive: Buffer): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'factory-export-out-'));
    const file = join(dir, 'archive.tar');
    await writeFile(file, archive);
    const out = join(dir, 'out');
    execFileSync('mkdir', [out]);
    execFileSync('tar', ['-xf', file, '-C', out]);
    return out;
}

/** Every row of one table's NDJSON pages, in page order. */
async function rowsIn(out: string, table: string): Promise<Record<string, unknown>[]> {
    const dir = join(out, 'tables', table);
    const pages = (await readdir(dir)).sort();
    const rows: Record<string, unknown>[] = [];
    for (const page of pages) {
        const text = await readFile(join(dir, page), 'utf8');
        for (const line of text.split('\n')) if (line) rows.push(JSON.parse(line) as Record<string, unknown>);
    }
    return rows;
}

describe.skipIf(!enabled)('GET /api/org/export', () => {
    it('streams a valid tar holding the org’s tasks, logs, transcripts and settings', async () => {
        const command = `export-task-${randomUUID()}`;
        const job = await craftJob({ sql, org, author: admin.userId }, { command, summary: 'done' });
        const rt = await runtimeOf(org);
        await rt.envVars!.replaceOrg(admin.userId, [{ name: 'REGION', value: 'eu-central', isSecret: false }]);
        await sql`insert into tracked_repo (org_id, owner, name) values (${org}, 'acme', 'widgets')`;
        const log = chunkKey(PREFIX, org, streamRef(job, 'log'), 0);
        const transcript = chunkKey(PREFIX, org, streamRef(job, 'transcript'), 0);
        const attachment = attachmentKey(PREFIX, org, randomUUID());
        const skill = skillObjectKey(PREFIX, org, 'a'.repeat(64));
        await objects.put(log, bytes('log line\n'));
        await objects.put(transcript, bytes('{"type":"assistant"}\n'));
        await objects.put(attachment, bytes('attached'));
        await objects.put(skill, bytes('skill bundle'));

        const response = await exportAs(admin);
        expect(response.statusCode).toBe(OK);
        expect(response.headers['content-type']).toContain('application/x-tar');
        expect(response.headers['content-disposition']).toContain('attachment');
        const out = await extract(response.rawPayload);

        // One directory per registered table, so a new org table is exported without touching the exporter.
        expect((await readdir(join(out, 'tables'))).sort()).toEqual([...ORG_TABLES].sort());
        const jobs = await rowsIn(out, 'job');
        expect(jobs).toEqual([expect.objectContaining({ id: job, command, org_id: org, summary: 'done' })]);
        expect(await rowsIn(out, 'env_var')).toEqual([
            expect.objectContaining({ name: 'REGION', value: 'eu-central', is_secret: false }),
        ]);
        expect(await rowsIn(out, 'tracked_repo')).toEqual([
            expect.objectContaining({ owner: 'acme', name: 'widgets' }),
        ]);

        const body = (key: string) => readFile(join(out, 'objects', key.slice(PREFIX.length)), 'utf8');
        expect(await body(log)).toBe('log line\n');
        expect(await body(transcript)).toBe('{"type":"assistant"}\n');
        expect(await body(attachment)).toBe('attached');
        expect(await body(skill)).toBe('skill bundle');
    });

    it('reads a table in pages: every row once, past a page boundary', async () => {
        const count = EXPORT_PAGE_ROWS + 3;
        await sql`
            insert into tracked_repo (org_id, owner, name)
            select ${org}, 'acme', 'repo-' || lpad(g::text, 5, '0') from generate_series(1, ${count}) g
        `;
        const out = await extract((await exportAs(admin)).rawPayload);
        const names = (await rowsIn(out, 'tracked_repo')).map((row) => row.name);
        expect(names).toHaveLength(count);
        expect(new Set(names).size).toBe(count);
        expect((await readdir(join(out, 'tables', 'tracked_repo'))).length).toBe(2);
    });

    it('pages the org’s telemetry points, a partitioned table without a key, and no other org’s', async () => {
        const count = EXPORT_PAGE_ROWS + 2;
        const insertPoints = (orgId: string, n: number) => sql`
            insert into metric_point (org_id, metric, session_id, value, temporality, time, attrs)
            select ${orgId}, 'claude_code.token.usage', ${randomUUID()}, g, 'delta', now() - g * interval '1 second', '{}'
            from generate_series(1, ${n}) g
        `;
        await insertPoints(org, count);
        await insertPoints(otherOrg, 3);

        const out = await extract((await exportAs(admin)).rawPayload);
        const points = await rowsIn(out, 'metric_point');
        expect(points).toHaveLength(count);
        expect(new Set(points.map((row) => row.value)).size).toBe(count);
        expect(points.every((row) => row.org_id === org)).toBe(true);
    });

    it('holds only the caller’s organization', async () => {
        const marker = `other-org-${randomUUID()}`;
        const outsider = await personIn(otherOrg);
        await craftJob({ sql, org: otherOrg, author: outsider.userId }, { command: marker });
        await sql`insert into tracked_repo (org_id, owner, name) values (${otherOrg}, 'acme', ${marker})`;
        await objects.put(chunkKey(PREFIX, otherOrg, streamRef(randomUUID(), 'log'), 0), bytes(marker));
        await objects.put(attachmentKey(PREFIX, otherOrg, randomUUID()), bytes(marker));
        await craftJob({ sql, org, author: admin.userId }, { command: 'mine' });

        const archive = (await exportAs(admin)).rawPayload;
        expect(archive.includes(marker)).toBe(false);
        expect(archive.includes(otherOrg)).toBe(false);
        expect(archive.includes(outsider.userId)).toBe(false);
        const out = await extract(archive);
        expect((await rowsIn(out, 'job')).map((row) => row.command)).toEqual(['mine']);
    });

    it('holds no secret value, credential or credential hash anywhere in the archive', async () => {
        const envSecret = `env-secret-${randomUUID()}`;
        const providerKey = `sk-ant-${randomUUID()}`;
        const hook = `https://discord.example.test/hook/${randomUUID()}`;
        const rt = await runtimeOf(org);
        await rt.envVars!.replaceOrg(admin.userId, [
            { name: 'API_KEY', value: envSecret, isSecret: true },
            { name: 'PLAIN', value: 'visible', isSecret: false },
        ]);
        await rt.userExecutors!.createOrg({
            name: 'team',
            type: 'claude-code',
            config: { env: { ANTHROPIC_API_KEY: providerKey } },
            createdBy: admin.userId,
        });
        await rt.notificationSubscriptions!.create(
            ORG_OWNER,
            {
                connectorKind: 'fake',
                connectorConfig: { target: 'room' },
                eventKinds: ['task.ready'],
                repos: [],
                enabled: true,
            },
            hook
        );
        const job = await craftJob({ sql, org, author: admin.userId }, { lease: 'live' });
        const [{ lease_token: leaseToken } = { lease_token: '' }] = await sql<{ lease_token: string }[]>`
            update job set lease_token = gen_random_uuid() where id = ${job} returning lease_token
        `;

        const archive = (await exportAs(admin)).rawPayload;
        const hashHex = (token: string) => Buffer.from(hashToken(token)).toString('hex');
        for (const secret of [
            envSecret,
            providerKey,
            hook,
            admin.token,
            member.token,
            hashHex(admin.token),
            hashHex(member.token),
            leaseToken,
        ]) {
            expect(archive.includes(secret), secret.slice(0, 12)).toBe(false);
        }

        const out = await extract(archive);
        const env = await rowsIn(out, 'env_var');
        expect(env.find((row) => row.name === 'PLAIN')).toMatchObject({ value: 'visible' });
        // A secret's reference is exported, never its value.
        expect(env.find((row) => row.name === 'API_KEY')).toMatchObject({
            secret_ref: expect.any(String),
            value: null,
        });
    });

    it('holds no provider key of a profile saved before keys moved to the secret store, unconverted yet', async () => {
        // The executor store converts such a row on its first read; an export taken before that read must not
        // carry the plaintext, nor any credential-shaped value nested in any row.
        const providerKey = `sk-ant-legacy-${randomUUID()}`;
        const nested = `nested-secret-${randomUUID()}`;
        const config = {
            model: 'sonnet',
            env: { ANTHROPIC_API_KEY: providerKey, REGION: 'eu' },
            mcp: [{ headers: { auth_token: nested } }],
        };
        await sql`
            insert into executor_profile (org_id, user_id, name, type, config, position)
            values (${org}, ${admin.userId}, 'legacy', 'claude-code', ${sql.json(config)}, 0)
        `;

        const archive = (await exportAs(admin)).rawPayload;
        expect(archive.includes(providerKey)).toBe(false);
        expect(archive.includes(nested)).toBe(false);
        const [profile] = await rowsIn(await extract(archive), 'executor_profile');
        expect(profile).toMatchObject({ name: 'legacy', config: { model: 'sonnet', env: { REGION: 'eu' } } });
    });

    it('omits every credential-shaped column of the registered tables, or names it a reference', async () => {
        // A column whose name looks like a credential is either left out of the export or is one of these:
        // references into the secret store, flags, ids and enums that hold no credential themselves.
        const KEPT = new Set([
            'attachment_upload.access_token_id',
            'connector_connection.credential',
            // The id of a driver credential serving the org; the token's hash lives in driver_credential, never exported.
            'driver_credential_org.credential_id',
            'env_var.is_secret',
            'env_var.secret_ref',
            'env_var.secret_version',
            'executor_profile.secret_refs',
            'integration_authorization.secret_operation_id',
            'integration_authorization.secret_ref',
            'integration_grant.lineage_secret_ref',
            'integration_grant.secret_destroyed_at',
            'integration_grant.secret_ref',
            'integration_grant.secret_version',
            'integration_grant.secret_wedged_at',
            'job_connection_binding.credential',
            'notification_subscription.secret_ref',
            'notification_subscription.secret_version',
            'batch_pr_observation.claim_token',
            'commerce_usage_report.claim_token',
            'notification_outbox.claim_token',
            'pr_follow.claim_token',
            'task_reclaim.claim_token',
            'task_reclaim_ack.claim_token',
            // Counts of model tokens (the plan's allowance and the usage rollup), not credentials.
            'org_plan.max_tokens',
            'org_token_usage.tokens',
        ]);
        const columns = await sql<{ table_name: string; column_name: string }[]>`
            select table_name, column_name from information_schema.columns
            where table_schema = current_schema() and table_name = any(${[...ORG_TABLES]})
              and column_name ~ '(token|hash|secret|verifier|challenge|credential|password|private|cipher)'
        `;
        const unclassified = columns
            .filter((c) => !(EXPORT_OMITTED_COLUMNS[c.table_name] ?? []).includes(c.column_name))
            .map((c) => `${c.table_name}.${c.column_name}`)
            .filter((name) => !KEPT.has(name));
        expect(unclassified).toEqual([]);
    });

    it('refuses a member with 403', async () => {
        expect((await exportAs(member)).statusCode).toBe(FORBIDDEN);
    });

    it('writes one audit row naming the admin who exported', async () => {
        await exportAs(admin);
        await exportAs(member);
        const rows = await sql<{ actor_kind: string; actor_id: string }[]>`
            select actor_kind, actor_id from audit_event where org_id = ${org} and action = 'org.export'
        `;
        expect(rows).toEqual([{ actor_kind: 'user', actor_id: admin.userId }]);
    });

    it('settles when an object read fails mid-stream, with no end-of-archive', async () => {
        await app.close();
        await objects.put(chunkKey(PREFIX, org, streamRef(randomUUID(), 'log'), 0), bytes('x'));
        const failing: ObjectStore = {
            ...objects,
            list: async () => {
                throw new Error('list failed');
            },
        };
        await boot(sql, failing);
        const settled = await Promise.race([
            exportAs(admin).then(
                () => 'settled',
                () => 'settled'
            ),
            new Promise((resolve) => setTimeout(() => resolve('hung'), 5_000)),
        ]);
        expect(settled).toBe('settled');
    });

    it('stops reading when the client goes away, and holds no pool connection', async () => {
        await app.close();
        let reads = 0;
        // An endless namespace: every page names fresh keys, every body takes a moment.
        const endless: ObjectStore = {
            ...objects,
            list: async (prefix) =>
                prefix === `${PREFIX}${org}/` ? [0, 1, 2].map(() => `${prefix}${randomUUID()}`) : [],
            get: async () => {
                reads += 1;
                await new Promise((resolve) => setTimeout(resolve, 5));
                return bytes('x'.repeat(4096));
            },
        };
        const one = postgres(db.url!, { max: 1 });
        try {
            await boot(one, endless);
            await app.listen({ port: 0, host: '127.0.0.1' });
            const { port } = app.server.address() as AddressInfo;
            await new Promise<void>((resolve, reject) => {
                const request = get(
                    {
                        host: '127.0.0.1',
                        port,
                        path: '/api/org/export',
                        headers: { authorization: `Bearer ${admin.token}` },
                    },
                    (response) => {
                        response.on('data', () => {
                            if (reads < 3) return;
                            request.destroy();
                            resolve();
                        });
                    }
                );
                request.on('error', (error) => (request.destroyed ? resolve() : reject(error)));
            });
            await new Promise((resolve) => setTimeout(resolve, 200));
            const after = reads;
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(reads).toBe(after);
            const [answer] = await Promise.race([
                one<{ ok: number }[]>`select 1 as ok`,
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('pool held')), 5_000)),
            ]);
            expect(answer?.ok).toBe(1);
        } finally {
            await app.close();
            await one.end();
        }
    });

    /** Holds the store's `held` call open until its signal fires, drops the client meanwhile: did the signal fire? */
    async function disconnectWhilePending(held: 'list' | 'get'): Promise<AbortSignal | undefined> {
        await app.close();
        let signalOf: AbortSignal | undefined;
        let reached = () => {};
        const pendingReached = new Promise<void>((resolve) => {
            reached = resolve;
        });
        const pending = (signal: AbortSignal | undefined) =>
            new Promise<never>((_, reject) => {
                signalOf = signal;
                reached();
                signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        const store: ObjectStore = {
            ...objects,
            list: async (prefix, options) => {
                if (held === 'list') return pending(options?.signal);
                return prefix === `${PREFIX}${org}/` && options?.after === undefined ? [`${prefix}held`] : [];
            },
            get: async (_key, options) => pending(options?.signal),
        };
        await boot(sql, store);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const { port } = app.server.address() as AddressInfo;
        const request = get({
            host: '127.0.0.1',
            port,
            path: '/api/org/export',
            headers: { authorization: `Bearer ${admin.token}` },
        });
        request.on('error', () => {});
        await pendingReached;
        request.destroy();
        await expect.poll(() => signalOf?.aborted, { timeout: 5_000 }).toBe(true);
        // The route settled: closing the app waits on no open response.
        const closed = await Promise.race([
            app.close().then(() => 'closed'),
            new Promise((resolve) => setTimeout(() => resolve('held'), 5_000)),
        ]);
        expect(closed).toBe('closed');
        return signalOf;
    }

    it('aborts a listing that is pending when the client goes away', async () => {
        expect((await disconnectWhilePending('list'))?.aborted).toBe(true);
    });

    it('aborts an object read that is pending when the client goes away', async () => {
        expect((await disconnectWhilePending('get'))?.aborted).toBe(true);
    });
});
