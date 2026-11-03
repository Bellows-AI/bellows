import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Sql } from 'postgres';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { McpCaller, OAuthStore } from '../src/auth/oauth-store.js';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore } from '../src/auth/store.js';
import { createBatchStore } from '../src/db/batches/batch-store.js';
import type { BatchStore } from '../src/db/batches/batch-store-types.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { OrgRegistry } from '../src/orgs.js';
import { githubAuth, staticRegistry, stubTelemetryClient, telemetryStoreStub, testConfig } from '../test/helpers.js';
import { BATCH_REPO, jobCount, prTask } from './batch-fixtures.js';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import { buildWorld } from './oauth-rig.js';

/**
 * The batch tools over real stores for members of two organizations: the board's own answers, verbatim.
 * `server/test/mcp.tools-batch.test.ts` holds the in-memory double.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const LOCALHOST = '127.0.0.1';
const MODERN = '2026-07-28';
const OTHER_REPO = 'acme/api';
const ORG = testOrg();
const OTHER_ORG = testOrg();
const db = useTestDb({ orgs: [ORG, OTHER_ORG] });

let sql: Sql;
let jobs: JobStore;
let batches: BatchStore;
let otherBatches: BatchStore;
beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    const prs = createPrLifecycleStore({ sql, orgId: ORG });
    jobs = createJobStore({ sql, orgId: ORG, prs });
    batches = createBatchStore({
        sql,
        orgId: ORG,
        stop: (id, by) => jobs.stop(id, by),
        close: (id, by) => jobs.markDone(id, by),
    });
    const otherJobs = createJobStore({ sql, orgId: OTHER_ORG });
    otherBatches = createBatchStore({
        sql,
        orgId: OTHER_ORG,
        stop: (id, by) => otherJobs.stop(id, by),
        close: (id, by) => otherJobs.markDone(id, by),
    });
});

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const close of closers.splice(0)) await close();
});

const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, LOCALHOST, () => {
            const address = probe.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            probe.close(() => resolve(port));
        });
    });

type Who = 'alice' | 'bob';
const tokenOf = (who: Who) => `mat_dbbatch-${who}-token-0123456789`;

/** A repo source whose installation listing carries default branches, as the real one does. */
const reposWithDefaults = () => {
    const entries = [BATCH_REPO, OTHER_REPO].map((full) => {
        const [owner, name] = full.split('/') as [string, string];
        return { owner, name };
    });
    return {
        ...staticRepoSource(entries),
        detail: async () => ({
            repos: entries.map((entry) => ({ ...entry, private: false, defaultBranch: 'main', pushedAt: null })),
            installation: null,
            error: null,
        }),
    };
};

async function boot(wrap: (store: BatchStore) => BatchStore = (store) => store) {
    const port = await freePort();
    const publicUrl = `http://${LOCALHOST}:${port}`;
    const resource = `${publicUrl}/api/mcp`;
    const people = { alice: (await buildWorld(sql, ORG)).caller, bob: (await buildWorld(sql, OTHER_ORG)).caller };
    const tokens = new Map<string, McpCaller>(
        (Object.keys(people) as Who[]).map((who) => [
            hashToken(tokenOf(who)).toString('hex'),
            {
                ...people[who],
                scopes: ['factory:read', 'factory:write'],
                clientId: 'c',
                resource,
                familyId: `f-${who}`,
            } as McpCaller,
        ])
    );
    const oauth: Pick<OAuthStore, 'findAccessToken'> = {
        findAccessToken: async (hash) => tokens.get(hash.toString('hex')) ?? null,
    };
    const config = testConfig({
        auth: githubAuth({ publicUrl }),
        port,
        mcp: { enabled: true, resource, trustedOrigins: [] },
    });
    const repos = reposWithDefaults();
    const orgA = staticRegistry({ config, telemetry: stubTelemetryClient(), repos, jobs, batches: wrap(batches) });
    const orgB = staticRegistry({ config, telemetry: stubTelemetryClient(), repos, batches: otherBatches });
    const orgs: OrgRegistry = { ...orgA, for: (id) => (id === OTHER_ORG ? orgB.for(id) : orgA.for(id)) };
    const app = await buildApp({
        config,
        orgs,
        store: telemetryStoreStub(),
        auth: createAuthStore({ sql }),
        oauth: oauth as OAuthStore,
    });
    closers.push(() => app.close());
    await app.listen({ port, host: LOCALHOST });
    return { url: new URL(resource), userOf: (who: Who) => people[who].user.id };
}

const call = async (url: URL, who: Who, name: string, args: Record<string, unknown> = {}) => {
    const client = new Client({ name: 'dbbatch', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(
        new StreamableHTTPClientTransport(url, {
            requestInit: { headers: { authorization: `Bearer ${tokenOf(who)}` } },
        })
    );
    try {
        const result = await client.callTool({ name, arguments: args });
        // biome-ignore lint/suspicious/noExplicitAny: structured content is asserted field by field below
        return { ...result, data: result.structuredContent as Record<string, any> };
    } finally {
        await client.close();
    }
};

const planOf = (title: string, extra: Record<string, unknown> = {}) => ({
    planVersion: 1,
    title,
    targets: [{ key: 'web', repo: BATCH_REPO }],
    defaultTarget: 'web',
    concurrency: 2,
    stages: [
        { key: 'one', tasks: [prTask('a'), prTask('b')] },
        { key: 'two', tasks: [prTask('c')] },
    ],
    ...extra,
});

const twoRepoPlan = (title: string) =>
    planOf(title, {
        targets: [
            { key: 'web', repo: BATCH_REPO },
            { key: 'api', repo: OTHER_REPO },
        ],
        stages: [{ key: 'one', tasks: [prTask('a'), { ...prTask('b'), target: 'api' }] }],
    });

const imported = async (url: URL, title: string, source: unknown = planOf(title)) => {
    const made = await call(url, 'alice', 'import_batch', { plan: source });
    expect(made.isError, JSON.stringify(made.data)).toBeFalsy();
    return made.data.id as string;
};

const started = async (url: URL, title: string) => {
    const id = await imported(url, title);
    const begun = await call(url, 'alice', 'start_batch', { batchId: id, version: 1 });
    expect(begun.isError, JSON.stringify(begun.data)).toBeFalsy();
    return id;
};

describe.skipIf(!enabled)('the batch tools — database', () => {
    it('imports, validates, starts and inspects a batch in the real store, the board answering at each step', async () => {
        const { url, userOf } = await boot();
        const title = `import ${randomUUID()}`;
        const id = await imported(url, title);
        expect(await batches.get(id)).toMatchObject({ status: 'draft', version: 1, createdBy: userOf('alice') });

        const checked = await call(url, 'alice', 'validate_batch', { batchId: id });
        expect(checked.isError, JSON.stringify(checked.data)).toBeFalsy();
        expect(checked.data).toMatchObject({ valid: true, version: 1 });
        expect(checked.data.plan.targets[0]).toMatchObject({ repo: BATCH_REPO, branch: 'main' });
        expect(await batches.get(id)).toMatchObject({ status: 'draft' });

        const draft = await call(url, 'alice', 'inspect_batch', { batchId: id });
        expect(draft.data.standing.verdict).toBe('draft');

        const begun = await call(url, 'alice', 'start_batch', { batchId: id, version: 1 });
        expect(begun.isError, JSON.stringify(begun.data)).toBeFalsy();
        expect(begun.data).toMatchObject({ id, status: 'running' });

        const inspected = await call(url, 'alice', 'inspect_batch', { batchId: id });
        expect(inspected.data.tasks.map((t: { key: string }) => t.key).sort()).toEqual(['a', 'b', 'c']);
        expect(inspected.data.standing).toMatchObject({ verdict: 'running', verificationFailures: [] });
        expect(inspected.data.report.tasks).toHaveLength(3);

        const report = await call(url, 'alice', 'batch_report', { batchId: id });
        expect(report.isError, JSON.stringify(report.data)).toBeFalsy();
        expect(report.data.report.tasks.map((t: { key: string }) => t.key).sort()).toEqual(['a', 'b', 'c']);
        expect(report.data.standing.verdict).toBe('running');
        expect(report.data.stale).toBe(false);

        const listing = await call(url, 'alice', 'list_batches');
        expect(listing.data.batches.find((b: { id: string }) => b.id === id)).toMatchObject({
            title,
            status: 'running',
            taskCount: 3,
        });
    });

    it('refuses a stale-version update and leaves the stored draft exactly as it was', async () => {
        const { url } = await boot();
        const id = await imported(url, `stale ${randomUUID()}`);
        const second = planOf(`second ${randomUUID()}`);
        const next = await call(url, 'alice', 'update_batch', { batchId: id, version: 1, plan: second });
        expect(next.data).toMatchObject({ id, status: 'draft', version: 2 });
        const before = await batches.get(id);

        const stale = await call(url, 'alice', 'update_batch', { batchId: id, version: 1, plan: planOf('third') });
        expect(stale.isError).toBe(true);
        expect(stale.data).toMatchObject({ outcome: 'refused', code: 'BATCH_STALE', status: 409 });
        expect(await batches.get(id)).toEqual(before);

        const staleStart = await call(url, 'alice', 'start_batch', { batchId: id, version: 1 });
        expect(staleStart.data).toMatchObject({ outcome: 'refused', code: 'BATCH_STALE' });
        expect(await batches.get(id)).toEqual(before);
    });

    it('stores a multi-target plan, and the board refuses to start it with BATCH_UNSUPPORTED: nothing launches', async () => {
        const { url } = await boot();
        const id = await imported(url, `multi ${randomUUID()}`, twoRepoPlan(`multi ${randomUUID()}`));
        const jobsBefore = await jobCount(sql);
        const refused = await call(url, 'alice', 'start_batch', { batchId: id, version: 1 });
        expect(refused.isError).toBe(true);
        expect(refused.data).toMatchObject({
            outcome: 'refused',
            code: 'BATCH_UNSUPPORTED',
            reason: 'multi_target',
            status: 409,
        });
        expect(refused.data.message).toContain('one repository and branch');
        expect(await batches.get(id)).toMatchObject({ status: 'draft', startedAt: null });
        expect(await jobCount(sql)).toBe(jobsBefore);
        const validate = await call(url, 'alice', 'validate_batch', { batchId: id });
        expect(validate.data).toMatchObject({
            outcome: 'refused',
            code: 'BATCH_UNSUPPORTED',
            reason: 'multi_target',
        });
    });

    it('starts once per idempotency key: a retry returns the same batch and launches nothing twice', async () => {
        const { url } = await boot();
        const id = await imported(url, `start-keyed ${randomUUID()}`);
        const key = `start-${randomUUID()}`;
        const first = await call(url, 'alice', 'start_batch', { batchId: id, version: 1, idempotencyKey: key });
        expect(first.isError, JSON.stringify(first.data)).toBeFalsy();
        const jobs = await jobCount(sql);
        const again = await call(url, 'alice', 'start_batch', { batchId: id, version: 1, idempotencyKey: key });
        expect(again.isError, JSON.stringify(again.data)).toBeFalsy();
        expect(again.data.id).toBe(id);
        expect(await jobCount(sql)).toBe(jobs);
        const other = await call(url, 'alice', 'start_batch', { batchId: id, version: 2, idempotencyKey: key });
        expect(other.isError).toBe(true);
        expect(other.data).toMatchObject({ outcome: 'refused' });
        expect(await jobCount(sql)).toBe(jobs);
    });

    it('imports once per idempotency key', async () => {
        const { url } = await boot();
        const key = `import-${randomUUID()}`;
        const source = planOf(`keyed ${randomUUID()}`);
        const first = await call(url, 'alice', 'import_batch', { plan: source, idempotencyKey: key });
        const again = await call(url, 'alice', 'import_batch', { plan: source, idempotencyKey: key });
        expect(again.data.id).toBe(first.data.id);
        const other = await call(url, 'alice', 'import_batch', { plan: planOf('other'), idempotencyKey: key });
        expect(other.isError).toBe(true);
        expect(other.data.outcome).toBe('refused');
        const rows = await sql<{ n: string }[]>`select count(*) as n from batch where org_id = ${ORG}`;
        expect(Number(rows[0]!.n)).toBe(1);
    });

    it('a member of another organization cannot read, write or start the batch, and does not see it listed', async () => {
        const { url } = await boot();
        const id = await started(url, `mine ${randomUUID()}`);
        const before = await batches.get(id);
        const attempts: [string, Record<string, unknown>][] = [
            ['inspect_batch', { batchId: id }],
            ['batch_report', { batchId: id }],
            ['validate_batch', { batchId: id }],
            ['update_batch', { batchId: id, version: 1, plan: planOf('hijack') }],
            ['start_batch', { batchId: id, version: 1 }],
        ];
        for (const [name, args] of attempts) {
            const foreign = await call(url, 'bob', name, args);
            expect(foreign.isError, name).toBe(true);
            expect(foreign.data, name).toMatchObject({ outcome: 'refused', code: 'NOT_FOUND', status: 404 });
        }
        const listing = await call(url, 'bob', 'list_batches');
        expect(listing.data.batches).toEqual([]);
        expect(await batches.get(id)).toEqual(before);
    });

    it('a report the board returns without one of the batch tasks is inconclusive, never a verdict', async () => {
        const { url } = await boot((store) => ({
            ...store,
            report: async (id) => {
                const whole = await store.report(id);
                return whole && { ...whole, tasks: whole.tasks.slice(1) };
            },
        }));
        const id = await started(url, `partial ${randomUUID()}`);
        const partial = await call(url, 'alice', 'batch_report', { batchId: id });
        expect(partial.isError).toBe(true);
        expect(partial.data).toMatchObject({ outcome: 'inconclusive' });
        expect(partial.data.standing).toBeUndefined();
    });

    it('inspect on an unreadable snapshot reports the board verdict inconclusive and no report', async () => {
        const { url } = await boot((store) => ({
            ...store,
            snapshot: async (id) => {
                if ((await store.get(id))?.status !== 'draft') throw new Error('snapshot unreadable');
                return store.snapshot(id);
            },
        }));
        const id = await started(url, `snapshot ${randomUUID()}`);
        const inspected = await call(url, 'alice', 'inspect_batch', { batchId: id });
        expect(inspected.isError).toBeFalsy();
        expect(inspected.data.standing.verdict).toBe('inconclusive');
        expect(inspected.data.report).toBeNull();
        const report = await call(url, 'alice', 'batch_report', { batchId: id });
        expect(report.isError).toBeFalsy();
        expect(report.data.stale).toBe(true);
    });
});
