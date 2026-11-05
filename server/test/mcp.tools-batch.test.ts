import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { McpCaller, OAuthStore } from '../src/auth/oauth-store.js';
import { hashToken } from '../src/auth/session.js';
import type { BatchStore } from '../src/db/batches/batch-store-types.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import {
    githubAuth,
    jobStoreSlice,
    memoryAuthStore,
    memoryBatchStore,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
    type MemoryBatchStore,
} from './helpers.js';
import { trackApps } from './helpers-http.js';

/**
 * The batch tools (import, update, validate, start, list, inspect, report, wait, retry, accept, cancel, task list) through the real auth plugin, bridge and batch
 * routes, driven by a v2 client over `POST /api/mcp`, on the in-memory batch store.
 * `server/test-db/mcp.tools-batch.test.ts` runs them over the real stores.
 */

const track = trackApps();
const LOCALHOST = '127.0.0.1';
const MODERN = '2026-07-28';
const ORG = 'org-a';
const OTHER_ORG = 'org-b';
const WEB = 'acme/web';
const API = 'acme/api';
const TOKENS = {
    reader: 'mat_batch-reader-token-0123456789',
    writer: 'mat_batch-writer-token-0123456789',
    both: 'mat_batch-both-token-0123456789',
    outsider: 'mat_batch-outsider-token-0123456789',
} as const;
type Who = keyof typeof TOKENS;
const UNKNOWN_BATCH = '99999999-9999-4999-8999-999999999999';

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

const task = (key: string, extra: Record<string, unknown> = {}) => ({
    key,
    objective: `do ${key}`,
    acceptance: 'it works',
    verification: 'npm test',
    ...extra,
});

const plan = (overrides: Record<string, unknown> = {}) => ({
    planVersion: 1,
    title: 'Upgrade',
    targets: [{ key: 'web', repo: WEB }],
    defaultTarget: 'web',
    stages: [
        { key: 'one', tasks: [task('a'), task('b')] },
        { key: 'two', tasks: [task('c')] },
    ],
    ...overrides,
});

const twoRepoPlan = () =>
    plan({
        targets: [
            { key: 'web', repo: WEB },
            { key: 'api', repo: API },
        ],
        stages: [{ key: 'one', tasks: [task('a'), task('b', { target: 'api' })] }],
    });

/** A repo source whose installation listing carries default branches, as the real one does. */
const reposWithDefaults = () => {
    const entries = [WEB, API].map((full) => {
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

interface Rig {
    url: URL;
    store: MemoryBatchStore;
    otherStore: MemoryBatchStore;
}

async function boot(
    wrap: (store: MemoryBatchStore) => BatchStore = (store) => store,
    batchesEnabled = true
): Promise<Rig> {
    const port = await freePort();
    const publicUrl = `http://${LOCALHOST}:${port}`;
    const resource = `${publicUrl}/api/mcp`;
    const auth = memoryAuthStore();
    const people = {
        reader: auth.seedMember(ORG, 'reader', 'member'),
        writer: auth.seedMember(ORG, 'writer', 'member'),
        both: auth.seedMember(ORG, 'both', 'member'),
        outsider: auth.seedMember(OTHER_ORG, 'outsider', 'member'),
    };
    const scopes: Record<Who, McpCaller['scopes']> = {
        reader: ['factory:read'],
        writer: ['factory:write'],
        both: ['factory:read', 'factory:write'],
        outsider: ['factory:read', 'factory:write'],
    };
    const tokens = new Map<string, McpCaller>(
        (Object.keys(TOKENS) as Who[]).map((who) => [
            hashToken(TOKENS[who]).toString('hex'),
            { ...people[who], scopes: scopes[who], clientId: 'c', resource, familyId: `f-${who}` },
        ])
    );
    const oauth: Pick<OAuthStore, 'findAccessToken'> = {
        findAccessToken: async (hash) => tokens.get(hash.toString('hex')) ?? null,
    };
    const config = testConfig({
        auth: githubAuth({ publicUrl }),
        port,
        mcp: { enabled: true, resource, trustedOrigins: [] },
        batches: { enabled: batchesEnabled },
    });
    const store = memoryBatchStore();
    const otherStore = memoryBatchStore();
    const orgs = staticRegistry({
        config,
        telemetry: stubTelemetryClient(),
        repos: reposWithDefaults(),
        jobs: jobStoreSlice({}),
        batchesByOrg: { [ORG]: wrap(store), [OTHER_ORG]: otherStore },
    });
    const app = track(await buildApp({ config, orgs, store: telemetryStoreStub(), auth, oauth: oauth as OAuthStore }));
    await app.listen({ port, host: LOCALHOST });
    return { url: new URL(resource), store, otherStore };
}

const connect = async (url: URL, who: Who) => {
    const client = new Client({ name: 'batches', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(
        new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TOKENS[who]}` } } })
    );
    return client;
};

const call = async (url: URL, who: Who, name: string, args: Record<string, unknown> = {}) => {
    const client = await connect(url, who);
    try {
        const result = await client.callTool({ name, arguments: args });
        // biome-ignore lint/suspicious/noExplicitAny: structured content is asserted field by field below
        return { ...result, data: result.structuredContent as Record<string, any> };
    } finally {
        await client.close();
    }
};

const listed = async (url: URL) => {
    const client = await connect(url, 'both');
    try {
        return (await client.listTools()).tools;
    } finally {
        await client.close();
    }
};

const imported = async (url: URL, source: unknown = plan()) => {
    const made = await call(url, 'both', 'import_batch', { plan: source });
    expect(made.isError, JSON.stringify(made.data)).toBeFalsy();
    return made.data as { id: string; status: string; version: number };
};

const started = async (url: URL, source: unknown = plan()) => {
    const { id } = await imported(url, source);
    const begun = await call(url, 'both', 'start_batch', { batchId: id, version: 1 });
    expect(begun.isError, JSON.stringify(begun.data)).toBeFalsy();
    return id;
};

interface PlanSchema {
    required: string[];
    additionalProperties: boolean;
    properties: { stages: { maxItems: number } };
}

const READ_TOOLS = ['validate_batch', 'inspect_batch', 'list_batches', 'batch_report', 'wait_batch', 'get_batch_tasks'];
const WRITE_TOOLS = ['import_batch', 'update_batch', 'start_batch', 'retry_batch_task', 'accept_batch_task'];

describe('the batch tools with batches disabled', () => {
    const BATCH_NAMES = [...READ_TOOLS, ...WRITE_TOOLS, 'cancel_batch'];

    it('does not list a batch tool, and lists the rest', async () => {
        const { url } = await boot(undefined, false);
        const names = (await listed(url)).map((tool) => tool.name);
        for (const name of BATCH_NAMES) expect(names, name).not.toContain(name);
        expect(names).toContain('list_tasks');
    });

    it('refuses a batch tool call and touches no store', async () => {
        const { url, store } = await boot(undefined, false);
        const client = await connect(url, 'both');
        const result = await client
            .callTool({ name: 'list_batches', arguments: {} })
            .then((r) => ({ isError: r.isError === true }))
            .catch(() => ({ isError: true }));
        await client.close();
        expect(result.isError).toBe(true);
        expect(store.writes).toEqual([]);
    });
});

describe('the batch tools', () => {
    it('lists the batch tools with the annotations their route class implies, and the board plan schema as the plan input', async () => {
        const { url } = await boot();
        const byName = new Map((await listed(url)).map((tool) => [tool.name, tool]));
        for (const name of READ_TOOLS) {
            expect(byName.get(name)?.annotations, name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        }
        for (const name of WRITE_TOOLS) {
            expect(byName.get(name)?.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
        }
        expect(byName.get('cancel_batch')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        expect(byName.get('cancel_batch')?.description).toMatch(/confirm: true/);
        for (const name of ['import_batch', 'update_batch']) {
            const advertised = byName.get(name)?.inputSchema as unknown as { properties: Record<string, PlanSchema> };
            const planSchema = advertised.properties.plan!;
            expect(planSchema.required, name).toEqual(['planVersion', 'title', 'targets', 'stages']);
            expect(planSchema.properties.stages.maxItems, name).toBe(20);
            expect(planSchema.additionalProperties, name).toBe(false);
        }
        for (const name of ['import_batch', 'start_batch']) {
            expect(byName.get(name)?.description, name).toMatch(/idempotencyKey/);
            expect(byName.get(name)?.description, name).toMatch(/same key/i);
        }
    });

    it.each(WRITE_TOOLS)(
        '%s: a read-scope token is refused insufficient_scope and the store is untouched',
        async (name) => {
            const { url, store } = await boot();
            const refused = await call(url, 'reader', name, {
                plan: plan(),
                batchId: UNKNOWN_BATCH,
                version: 1,
                task: 'a',
            });
            expect(refused.isError).toBe(true);
            expect(refused.data).toMatchObject({ outcome: 'refused', code: 'insufficient_scope' });
            expect(store.writes).toEqual([]);
        }
    );

    it.each(READ_TOOLS)('%s: a write-only token is refused insufficient_scope', async (name) => {
        const { url } = await boot();
        const refused = await call(url, 'writer', name, { batchId: UNKNOWN_BATCH });
        expect(refused.isError).toBe(true);
        expect(refused.data).toMatchObject({ outcome: 'refused', code: 'insufficient_scope' });
    });

    it('imports a draft, validates it, starts it and inspects it, the board answering at every step', async () => {
        const { url, store } = await boot();
        const made = await imported(url);
        expect(made).toMatchObject({ status: 'draft', version: 1 });

        const checked = await call(url, 'both', 'validate_batch', { batchId: made.id });
        expect(checked.isError).toBeFalsy();
        expect(checked.data).toMatchObject({ valid: true, version: 1 });
        // The resolved plan: the default branch named, the task target filled in.
        expect(checked.data.plan.targets[0]).toMatchObject({ key: 'web', repo: WEB, branch: 'main' });
        expect(checked.data.plan.stages[0].tasks[0]).toMatchObject({ key: 'a', target: 'web' });
        expect(store.writes).toEqual(['create']);

        const draft = await call(url, 'both', 'inspect_batch', { batchId: made.id });
        expect(draft.data).toMatchObject({ id: made.id, status: 'draft', standing: { verdict: 'draft' } });

        const begun = await call(url, 'both', 'start_batch', { batchId: made.id, version: 1 });
        expect(begun.isError, JSON.stringify(begun.data)).toBeFalsy();
        expect(begun.data).toMatchObject({ id: made.id, status: 'running' });
        expect(begun.data.standing.verdict).not.toBe('draft');

        const inspected = await call(url, 'both', 'inspect_batch', { batchId: made.id });
        expect(inspected.data).toMatchObject({ id: made.id, status: 'running', version: 1 });
        expect(inspected.data.tasks.map((t: { key: string }) => t.key)).toEqual(['a', 'b', 'c']);
        expect(inspected.data.standing).toMatchObject({ verdict: 'running', attention: [], verificationFailures: [] });

        const listing = await call(url, 'both', 'list_batches');
        expect(listing.data.batches.map((b: { id: string }) => b.id)).toEqual([made.id]);
        expect(listing.data.batches[0]).toMatchObject({ title: 'Upgrade', status: 'running', taskCount: 3 });
    });

    it('refuses an invalid plan with the board code and its path-addressed issues, writing nothing', async () => {
        const { url, store } = await boot();
        const bad = plan({ stages: [{ key: 'one', tasks: [task('a', { dependsOn: ['b'] })] }], concurrency: 99 });
        const refused = await call(url, 'both', 'import_batch', { plan: bad });
        expect(refused.isError).toBe(true);
        expect(refused.data).toMatchObject({ outcome: 'refused', code: 'BAD_BATCH', status: 400 });
        const paths = refused.data.issues.map((issue: { path: string }) => issue.path);
        expect(paths).toEqual(expect.arrayContaining(['stages[0].tasks[0].dependsOn', 'concurrency']));
        const text = (refused.content as { text: string }[])[0]!.text;
        expect(text).toContain('stages[0].tasks[0].dependsOn');
        expect(store.writes).toEqual([]);
    });

    it('imports once per idempotency key: a retry after a lost answer returns the same draft', async () => {
        const { url, store } = await boot();
        const first = await call(url, 'both', 'import_batch', { plan: plan(), idempotencyKey: 'import-key-0001' });
        const again = await call(url, 'both', 'import_batch', { plan: plan(), idempotencyKey: 'import-key-0001' });
        expect(again.data.id).toBe(first.data.id);
        expect(store.writes).toEqual(['create']);
        const other = await call(url, 'both', 'import_batch', {
            plan: plan({ title: 'Other' }),
            idempotencyKey: 'import-key-0001',
        });
        expect(other.isError).toBe(true);
        expect(other.data).toMatchObject({ outcome: 'refused' });
        expect(store.writes).toEqual(['create']);
    });

    it('an import whose answer cannot be confirmed is inconclusive, never a created draft', async () => {
        const { url } = await boot((store) => ({
            ...store,
            create: async () => {
                throw new Error('connection reset');
            },
        }));
        const lost = await call(url, 'both', 'import_batch', { plan: plan(), idempotencyKey: 'import-key-0002' });
        expect(lost.isError).toBe(true);
        expect(lost.data).toMatchObject({ outcome: 'inconclusive' });
        expect(lost.data.id).toBeUndefined();
    });

    it('updates a draft at its version and bumps it', async () => {
        const { url, store } = await boot();
        const { id } = await imported(url);
        const next = await call(url, 'both', 'update_batch', {
            batchId: id,
            version: 1,
            plan: plan({ title: 'Renamed' }),
        });
        expect(next.isError, JSON.stringify(next.data)).toBeFalsy();
        expect(next.data).toMatchObject({ id, status: 'draft', version: 2 });
        expect(store.writes).toEqual(['create', 'replace']);
        const read = await call(url, 'both', 'inspect_batch', { batchId: id });
        expect(read.data).toMatchObject({ version: 2, plan: { title: 'Renamed' } });
    });

    it('refuses a stale-version update with the board code and writes nothing', async () => {
        const { url, store } = await boot();
        const { id } = await imported(url);
        await call(url, 'both', 'update_batch', { batchId: id, version: 1, plan: plan({ title: 'Second' }) });
        const stale = await call(url, 'both', 'update_batch', {
            batchId: id,
            version: 1,
            plan: plan({ title: 'Third' }),
        });
        expect(stale.isError).toBe(true);
        expect(stale.data).toMatchObject({ outcome: 'refused', code: 'BATCH_STALE', status: 409 });
        expect(stale.data.message).toContain('version 2');
        expect(store.writes).toEqual(['create', 'replace']);
        const read = await call(url, 'both', 'inspect_batch', { batchId: id });
        expect(read.data).toMatchObject({ version: 2, plan: { title: 'Second' } });
    });

    it('refuses to update or start a batch that already started: its plan is frozen', async () => {
        const { url, store } = await boot();
        const id = await started(url);
        const writes = [...store.writes];
        const update = await call(url, 'both', 'update_batch', {
            batchId: id,
            version: 1,
            plan: plan({ title: 'Late' }),
        });
        expect(update.data).toMatchObject({ outcome: 'refused', code: 'BATCH_STARTED' });
        const again = await call(url, 'both', 'start_batch', { batchId: id, version: 1 });
        expect(again.data).toMatchObject({ outcome: 'refused', code: 'BATCH_STARTED' });
        const validate = await call(url, 'both', 'validate_batch', { batchId: id });
        expect(validate.data).toMatchObject({ outcome: 'refused', code: 'BATCH_STARTED' });
        expect(store.writes).toEqual(writes);
    });

    it('refuses an automerge stage on a board that cannot merge, telling it apart by reason', async () => {
        const { url, store } = await boot();
        const { id } = await imported(url, plan({ stages: [{ key: 'one', policy: 'automerge', tasks: [task('a')] }] }));
        const writes = [...store.writes];
        for (const name of ['validate_batch', 'start_batch']) {
            const refused = await call(url, 'both', name, { batchId: id, version: 1 });
            expect(refused.isError, name).toBe(true);
            expect(refused.data, name).toMatchObject({
                outcome: 'refused',
                code: 'BATCH_UNSUPPORTED',
                reason: 'automerge',
                status: 409,
            });
        }
        expect(store.writes).toEqual(writes);
    });

    it('starts once per idempotency key: a retry returns the same batch and writes nothing twice', async () => {
        const { url, store } = await boot();
        const { id } = await imported(url);
        const first = await call(url, 'both', 'start_batch', {
            batchId: id,
            version: 1,
            idempotencyKey: 'start-key-0001',
        });
        expect(first.isError, JSON.stringify(first.data)).toBeFalsy();
        const writes = [...store.writes];
        const again = await call(url, 'both', 'start_batch', {
            batchId: id,
            version: 1,
            idempotencyKey: 'start-key-0001',
        });
        expect(again.isError, JSON.stringify(again.data)).toBeFalsy();
        expect(again.data.id).toBe(id);
        expect(store.writes).toEqual(writes);
        const other = await call(url, 'both', 'start_batch', {
            batchId: id,
            version: 2,
            idempotencyKey: 'start-key-0001',
        });
        expect(other.isError).toBe(true);
        expect(other.data).toMatchObject({ outcome: 'refused', code: 'IDEMPOTENCY_KEY_REUSED' });
        expect(store.writes).toEqual(writes);
    });

    it('refuses a start at a stale version and leaves the draft a draft', async () => {
        const { url, store } = await boot();
        const { id } = await imported(url);
        await call(url, 'both', 'update_batch', { batchId: id, version: 1, plan: plan({ title: 'Second' }) });
        const stale = await call(url, 'both', 'start_batch', { batchId: id, version: 1 });
        expect(stale.data).toMatchObject({ outcome: 'refused', code: 'BATCH_STALE' });
        expect(store.writes).toEqual(['create', 'replace']);
        const read = await call(url, 'both', 'inspect_batch', { batchId: id });
        expect(read.data.status).toBe('draft');
    });

    it('stores and validates a multi-target plan, and surfaces the board refusal to start it verbatim', async () => {
        const { url, store } = await boot();
        const { id } = await imported(url, twoRepoPlan());
        const refusedValidate = await call(url, 'both', 'validate_batch', { batchId: id });
        expect(refusedValidate.data).toMatchObject({
            outcome: 'refused',
            code: 'BATCH_UNSUPPORTED',
            reason: 'multi_target',
            status: 409,
        });
        const refused = await call(url, 'both', 'start_batch', { batchId: id, version: 1 });
        expect(refused.isError).toBe(true);
        expect(refused.data).toMatchObject({
            outcome: 'refused',
            code: 'BATCH_UNSUPPORTED',
            reason: 'multi_target',
            status: 409,
        });
        expect(refused.data.message).toBe(
            'A batch runs against one repository and branch for now; this plan uses more than one'
        );
        // Nothing launched and nothing degraded to one repository.
        expect(store.writes).toEqual(['create']);
        const read = await call(url, 'both', 'inspect_batch', { batchId: id });
        expect(read.data).toMatchObject({ status: 'draft', standing: { verdict: 'draft' } });
    });

    it('answers a batch of another organization as not found, on every tool, and writes nothing', async () => {
        const { url, store, otherStore } = await boot();
        const mine = await started(url);
        const writes = [...store.writes];
        const attempts: [string, Record<string, unknown>][] = [
            ['inspect_batch', { batchId: mine }],
            ['batch_report', { batchId: mine }],
            ['validate_batch', { batchId: mine }],
            ['update_batch', { batchId: mine, version: 1, plan: plan() }],
            ['start_batch', { batchId: mine, version: 1 }],
            ['wait_batch', { batchId: mine, budgetSeconds: 5 }],
            ['get_batch_tasks', { batchId: mine }],
            ['retry_batch_task', { batchId: mine, task: 'a' }],
            ['accept_batch_task', { batchId: mine, task: 'a' }],
            ['cancel_batch', { batchId: mine, confirm: true }],
        ];
        for (const [name, args] of attempts) {
            const foreign = await call(url, 'outsider', name, args);
            expect(foreign.isError, name).toBe(true);
            expect(foreign.data, name).toMatchObject({ outcome: 'refused', code: 'NOT_FOUND', status: 404 });
        }
        const theirs = await call(url, 'outsider', 'list_batches');
        expect(theirs.data.batches).toEqual([]);
        expect(store.writes).toEqual(writes);
        expect(otherStore.writes).toEqual([]);
    });

    it('answers an unknown or malformed batch id with the board 404', async () => {
        const { url } = await boot();
        for (const batchId of [UNKNOWN_BATCH, 'not-a-uuid']) {
            for (const name of ['inspect_batch', 'batch_report', 'validate_batch', 'wait_batch', 'get_batch_tasks']) {
                const missing = await call(url, 'both', name, { batchId, budgetSeconds: 5 });
                expect(missing.data, `${name} ${batchId}`).toMatchObject({ outcome: 'refused', code: 'NOT_FOUND' });
            }
        }
    });

    it('batch_report refuses a draft with the board code', async () => {
        const { url } = await boot();
        const { id } = await imported(url);
        const refused = await call(url, 'both', 'batch_report', { batchId: id });
        expect(refused.data).toMatchObject({ outcome: 'refused', code: 'BATCH_NOT_STARTED' });
    });

    it('batch_report carries the whole report beside the board standing', async () => {
        const { url } = await boot();
        const id = await started(url);
        const report = await call(url, 'both', 'batch_report', { batchId: id });
        expect(report.isError, JSON.stringify(report.data)).toBeFalsy();
        expect(report.data.report.tasks.map((t: { key: string }) => t.key)).toEqual(['a', 'b', 'c']);
        expect(report.data.report.tasks[0]).toMatchObject({ stage: 'one', next: { action: 'none' } });
        expect(report.data.standing.verdict).toBe('running');
        expect(report.data.stale).toBe(false);
    });

    it('a report that omits a task is inconclusive, not a verdict', async () => {
        const { url } = await boot((store) => ({
            ...store,
            report: async (id) => {
                const whole = await store.report(id);
                return whole && { ...whole, tasks: whole.tasks.slice(1) };
            },
        }));
        const id = await started(url);
        const partial = await call(url, 'both', 'batch_report', { batchId: id });
        expect(partial.isError).toBe(true);
        expect(partial.data).toMatchObject({ outcome: 'inconclusive' });
        expect(partial.data.reason).toMatch(/every task/);
        expect(partial.data.standing).toBeUndefined();
    });

    it('a report the board could not read is inconclusive when a read fails, and the lost half does not become success', async () => {
        const { url } = await boot((store) => ({
            ...store,
            report: async () => {
                throw new Error('report read failed');
            },
        }));
        const id = await started(url);
        const lost = await call(url, 'both', 'batch_report', { batchId: id });
        expect(lost.isError).toBe(true);
        expect(lost.data).toMatchObject({ outcome: 'inconclusive' });
    });

    it('a PR observation the board marks stale is passed on as stale, never refreshed', async () => {
        const { url } = await boot((store) => ({
            ...store,
            report: async (id) => {
                const whole = await store.report(id);
                if (!whole) return whole;
                const observation = {
                    outcome: 'open',
                    checks: 'passing',
                    mergeability: 'clean',
                    review: null,
                    headSha: 'abc',
                    targetSha: null,
                    stale: true,
                    observedAt: '2026-01-01T00:00:00.000Z',
                    error: null,
                };
                return { ...whole, tasks: whole.tasks.map((t, n) => (n === 0 ? { ...t, observation } : t)) };
            },
        }));
        const id = await started(url);
        const report = await call(url, 'both', 'batch_report', { batchId: id });
        expect(report.isError, JSON.stringify(report.data)).toBeFalsy();
        expect(report.data.stale).toBe(true);
        expect(report.data.report.tasks[0].observation.stale).toBe(true);
    });

    it('inspect_batch on a snapshot the board could not read carries the board verdict inconclusive, not a terminal one', async () => {
        const { url } = await boot((store) => ({
            ...store,
            snapshot: async () => {
                throw new Error('snapshot unreadable');
            },
        }));
        const id = await started(url);
        const inspected = await call(url, 'both', 'inspect_batch', { batchId: id });
        expect(inspected.isError).toBeFalsy();
        expect(inspected.data.standing.verdict).toBe('inconclusive');
        expect(inspected.data.report).toBeNull();
    });
});

const PR_URL = 'https://example.test/acme/web/pull/7';

const acceptedPlan = () =>
    plan({
        stages: [
            {
                key: 'one',
                tasks: [task('a', { completion: { kind: 'accepted', condition: 'reviewed' } }), task('b')],
            },
        ],
    });

type Marked = (id: string, key: string, state: Record<string, unknown>) => void;

describe('wait_batch through the real routes', () => {
    const markAll = (store: MemoryBatchStore, id: string, executions: Record<string, string>) => {
        for (const [key, execution] of Object.entries(executions)) {
            (store.mark as Marked)(id, key, { execution, gate: execution === 'succeeded' ? 'passed' : 'open' });
        }
    };

    it('answers needs_attention with the attention list when a task waits on a person', async () => {
        const { url, store } = await boot();
        const id = await started(url);
        store.mark(id, 'a', { execution: 'succeeded', pr: PR_URL, waitReason: 'waiting for a person to merge' });
        const out = await call(url, 'both', 'wait_batch', { batchId: id, budgetSeconds: 8 });
        expect(out.isError, JSON.stringify(out.data)).toBeFalsy();
        expect(out.data).toMatchObject({ result: 'needs_attention', verdict: 'needs_attention', batchId: id });
        expect(out.data.attention).toEqual([
            { key: 'a', stage: 'one', waitReason: 'waiting for a person to merge', pr: PR_URL },
        ]);
        expect(out.data.verificationFailures).toEqual([]);
    });

    it('carries a failed stage verification with the needs_attention answer', async () => {
        const { url, store } = await boot();
        const id = await started(url);
        store.plantVerification(id, [
            {
                stage: 'one',
                state: 'failed',
                detail: 'tests red',
                headSha: 'abc123',
                checkedAt: '2026-01-01T00:00:00.000Z',
            },
        ]);
        const out = await call(url, 'both', 'wait_batch', { batchId: id, budgetSeconds: 8 });
        expect(out.data).toMatchObject({ result: 'needs_attention' });
        expect(out.data.verificationFailures).toEqual([
            { stage: 'one', state: 'failed', detail: 'tests red', headSha: 'abc123' },
        ]);
    });

    it('answers succeeded and failed from the board standing of a settled batch', async () => {
        const good = await boot();
        const goodId = await started(good.url);
        markAll(good.store, goodId, { a: 'succeeded', b: 'succeeded', c: 'succeeded' });
        good.store.complete(goodId);
        const ok = await call(good.url, 'both', 'wait_batch', { batchId: goodId, budgetSeconds: 8 });
        expect(ok.data).toMatchObject({ result: 'succeeded', verdict: 'succeeded', status: 'completed' });

        const bad = await boot();
        const badId = await started(bad.url);
        markAll(bad.store, badId, { a: 'failed', b: 'succeeded', c: 'cancelled' });
        bad.store.complete(badId);
        const failed = await call(bad.url, 'both', 'wait_batch', { batchId: badId, budgetSeconds: 8 });
        expect(failed.data).toMatchObject({ result: 'failed', verdict: 'failed' });
    });

    it('answers cancelled with the fence after a cancel, and expired batches as cancelled naming the expiry', async () => {
        const { url, store } = await boot();
        const id = await started(url);
        const cancelled = await call(url, 'both', 'cancel_batch', { batchId: id, confirm: true });
        expect(cancelled.isError, JSON.stringify(cancelled.data)).toBeFalsy();
        const out = await call(url, 'both', 'wait_batch', { batchId: id, budgetSeconds: 8 });
        expect(out.data).toMatchObject({ result: 'cancelled', fence: 'cancelled' });

        const late = await started(url);
        store.expire(late);
        const expired = await call(url, 'both', 'wait_batch', { batchId: late, budgetSeconds: 8 });
        expect(expired.data).toMatchObject({ result: 'cancelled', fence: 'expired' });
    });

    it('ends in timeout when the batch is still moving when the budget runs out, and cancels nothing', async () => {
        const { url, store } = await boot();
        const id = await started(url);
        store.mark(id, 'a', { execution: 'running' });
        const writes = [...store.writes];
        const out = await call(url, 'both', 'wait_batch', { batchId: id, budgetSeconds: 4 });
        expect(out.isError).toBeFalsy();
        expect(out.data).toMatchObject({ result: 'timeout', batchId: id, verdict: 'running', budgetSeconds: 4 });
        expect(store.writes.filter((w) => w === 'cancel')).toEqual([]);
        expect(store.writes.slice(0, writes.length)).toEqual(writes);
    });

    it('is inconclusive when the board could not read the report, never a verdict', async () => {
        const { url } = await boot((store) => ({
            ...store,
            snapshot: async () => {
                throw new Error('snapshot unreadable');
            },
        }));
        const id = await started(url);
        const out = await call(url, 'both', 'wait_batch', { batchId: id, budgetSeconds: 8 });
        expect(out.isError).toBe(true);
        expect(out.data).toMatchObject({ outcome: 'inconclusive' });
        expect(out.data.result).toBeUndefined();
    });

    it('waits out the budget in timeout, paced, when the board parks a batch whose standing is still running', async () => {
        const { url } = await boot();
        const id = await started(url);
        // Nothing runs and nothing is marked: the board parks the poll at once, while the standing reads running. The
        // CLI keeps re-reading such a batch to its timeout (exit 3); so does the tool, without a busy loop and without
        // outlasting the budget.
        const begun = Date.now();
        const out = await call(url, 'both', 'wait_batch', { batchId: id, budgetSeconds: 5 });
        const spent = Date.now() - begun;
        expect(out.isError, JSON.stringify(out.data)).toBeFalsy();
        expect(out.data).toMatchObject({ result: 'timeout', verdict: 'running', batchId: id });
        expect(spent).toBeGreaterThanOrEqual(1500);
        expect(spent).toBeLessThan(5000);
    });

    it('refuses a draft with the board code', async () => {
        const { url } = await boot();
        const { id } = await imported(url);
        const out = await call(url, 'both', 'wait_batch', { batchId: id, budgetSeconds: 8 });
        expect(out.data).toMatchObject({ outcome: 'refused', code: 'BATCH_NOT_STARTED' });
    });
});

describe('retry_batch_task, accept_batch_task and cancel_batch', () => {
    it('retries a failed task and answers the batch with the board standing', async () => {
        const { url, store } = await boot();
        const id = await started(url);
        store.mark(id, 'a', { execution: 'failed' });
        const out = await call(url, 'both', 'retry_batch_task', { batchId: id, task: 'a' });
        expect(out.isError, JSON.stringify(out.data)).toBeFalsy();
        expect(out.data).toMatchObject({ id, status: 'running' });
        expect(out.data.tasks.find((t: { key: string }) => t.key === 'a')).toMatchObject({ execution: 'retry' });
        expect(store.writes).toContain('retry');
    });

    it('refuses to retry a task that is not retryable, an unknown task and a draft, writing nothing', async () => {
        const { url, store } = await boot();
        const id = await started(url);
        const writes = [...store.writes];
        const running = await call(url, 'both', 'retry_batch_task', { batchId: id, task: 'a' });
        expect(running.data).toMatchObject({ outcome: 'refused', code: 'BATCH_TASK_NOT_RETRYABLE' });
        const unknown = await call(url, 'both', 'retry_batch_task', { batchId: id, task: 'zzz' });
        expect(unknown.data).toMatchObject({ outcome: 'refused', code: 'NOT_FOUND' });
        const { id: draft } = await imported(url);
        const early = await call(url, 'both', 'retry_batch_task', { batchId: draft, task: 'a' });
        expect(early.data).toMatchObject({ outcome: 'refused', code: 'BATCH_NOT_STARTED' });
        expect(store.writes.filter((w) => w === 'retry')).toEqual([]);
        expect(store.writes.slice(0, writes.length)).toEqual(writes);
    });

    it('accepts a finished task whose plan completion is an acceptance, as the caller', async () => {
        const { url, store } = await boot();
        const id = await started(url, acceptedPlan());
        store.mark(id, 'a', { execution: 'succeeded' });
        const out = await call(url, 'both', 'accept_batch_task', { batchId: id, task: 'a' });
        expect(out.isError, JSON.stringify(out.data)).toBeFalsy();
        expect(out.data.tasks.find((t: { key: string }) => t.key === 'a')).toMatchObject({ gate: 'passed' });
        expect(store.writes.some((w) => w.startsWith('accept:'))).toBe(true);
    });

    it('refuses to accept a task still running or one that a merged PR completes, writing nothing', async () => {
        const { url, store } = await boot();
        const id = await started(url, acceptedPlan());
        const notReady = await call(url, 'both', 'accept_batch_task', { batchId: id, task: 'a' });
        expect(notReady.data).toMatchObject({ outcome: 'refused', code: 'BATCH_TASK_NOT_ACCEPTABLE' });
        store.mark(id, 'b', { execution: 'succeeded' });
        const byPr = await call(url, 'both', 'accept_batch_task', { batchId: id, task: 'b' });
        expect(byPr.data).toMatchObject({ outcome: 'refused', code: 'BATCH_TASK_NOT_ACCEPTABLE' });
        expect(store.writes.some((w) => w.startsWith('accept:'))).toBe(false);
    });

    it('cancel_batch without confirm: true is refused before anything is sent to the board', async () => {
        const { url, store } = await boot();
        const id = await started(url);
        const writes = [...store.writes];
        for (const args of [{ batchId: id }, { batchId: id, confirm: false }]) {
            const out = await call(url, 'both', 'cancel_batch', args);
            expect(out.isError).toBe(true);
            expect(out.data).toMatchObject({ outcome: 'refused', code: 'confirmation_required' });
        }
        expect(store.writes).toEqual(writes);
        const after = await call(url, 'both', 'inspect_batch', { batchId: id });
        expect(after.data.standing.fence).toBeNull();
    });

    it('cancel_batch with confirm: true fences the batch, and a repeat answers the same', async () => {
        const { url, store } = await boot();
        const id = await started(url);
        const out = await call(url, 'both', 'cancel_batch', { batchId: id, confirm: true });
        expect(out.isError, JSON.stringify(out.data)).toBeFalsy();
        expect(out.data).toMatchObject({ id, standing: { verdict: 'cancelled', fence: 'cancelled' } });
        const again = await call(url, 'both', 'cancel_batch', { batchId: id, confirm: true });
        expect(again.isError).toBeFalsy();
        expect(store.writes.filter((w) => w === 'cancel')).toHaveLength(1);
    });

    it('refuses to cancel a draft, and a finished batch, with the board codes', async () => {
        const { url, store } = await boot();
        const { id } = await imported(url);
        const early = await call(url, 'both', 'cancel_batch', { batchId: id, confirm: true });
        expect(early.data).toMatchObject({ outcome: 'refused', code: 'BATCH_NOT_STARTED' });
        const done = await started(url);
        store.complete(done);
        const finished = await call(url, 'both', 'cancel_batch', { batchId: done, confirm: true });
        expect(finished.data).toMatchObject({ outcome: 'refused', code: 'BATCH_FINISHED' });
    });

    it('a read-scope token cannot cancel, even with confirm: true', async () => {
        const { url, store } = await boot();
        const id = await started(url);
        const writes = [...store.writes];
        const out = await call(url, 'reader', 'cancel_batch', { batchId: id, confirm: true });
        expect(out.data).toMatchObject({ outcome: 'refused', code: 'insufficient_scope' });
        expect(store.writes).toEqual(writes);
    });
});

describe('get_batch_tasks', () => {
    // biome-ignore lint/suspicious/noExplicitAny: structured content is asserted field by field below
    const keysOf = (data: Record<string, any>) => data.tasks.map((t: { key: string }) => t.key);

    it('pages through a multi-stage plan in plan order with a cursor that does not move', async () => {
        const { url, store } = await boot();
        const id = await started(url);
        const writes = [...store.writes];
        const first = await call(url, 'reader', 'get_batch_tasks', { batchId: id, limit: 2 });
        expect(first.isError, JSON.stringify(first.data)).toBeFalsy();
        expect(keysOf(first.data)).toEqual(['a', 'b']);
        expect(first.data.cursor).toEqual(expect.any(String));
        expect(first.data.total).toBe(3);
        const second = await call(url, 'reader', 'get_batch_tasks', {
            batchId: id,
            limit: 2,
            cursor: first.data.cursor,
        });
        expect(keysOf(second.data)).toEqual(['c']);
        expect(second.data.cursor).toBeNull();
        // The same cursor gives the same page again.
        const replay = await call(url, 'reader', 'get_batch_tasks', {
            batchId: id,
            limit: 2,
            cursor: first.data.cursor,
        });
        expect(keysOf(replay.data)).toEqual(['c']);
        expect(store.writes).toEqual(writes);
    });

    it('keeps the plan key, stage, target, canonical repo@branch, PR and task id of every task', async () => {
        const { url, store } = await boot();
        const id = await started(url);
        store.mark(id, 'a', { execution: 'succeeded', pr: PR_URL, rootJobId: '33333333-3333-4333-8333-333333333333' });
        const out = await call(url, 'reader', 'get_batch_tasks', { batchId: id });
        expect(out.data.tasks[0]).toMatchObject({
            key: 'a',
            stage: 'one',
            target: 'web',
            repo: WEB,
            branch: 'main',
            ref: `${WEB}@main`,
            execution: 'succeeded',
            pr: PR_URL,
            taskId: '33333333-3333-4333-8333-333333333333',
            next: { action: 'none' },
        });
        expect(out.data.tasks[1]).toMatchObject({ key: 'b', pr: null, taskId: null });
        expect(out.data.standing).toMatchObject({ verdict: 'running' });
    });

    it('filters by stage, by state and by target', async () => {
        const { url, store } = await boot();
        const id = await started(url);
        store.mark(id, 'b', { execution: 'failed' });
        const byStage = await call(url, 'reader', 'get_batch_tasks', { batchId: id, stage: 'two' });
        expect(keysOf(byStage.data)).toEqual(['c']);
        const byState = await call(url, 'reader', 'get_batch_tasks', { batchId: id, state: 'failed' });
        expect(keysOf(byState.data)).toEqual(['b']);
        expect(byState.data.total).toBe(1);
        const none = await call(url, 'reader', 'get_batch_tasks', { batchId: id, stage: 'two', state: 'failed' });
        expect(none.data.tasks).toEqual([]);
        const { id: draft } = await imported(url, twoRepoPlan());
        const byTarget = await call(url, 'reader', 'get_batch_tasks', { batchId: draft, target: 'api' });
        expect(keysOf(byTarget.data)).toEqual(['b']);
        expect(byTarget.data.tasks[0]).toMatchObject({ target: 'api', repo: API });
        const web = await call(url, 'reader', 'get_batch_tasks', { batchId: draft, target: 'web' });
        expect(keysOf(web.data)).toEqual(['a']);
    });

    it('lists the tasks of a draft from the record, without a report', async () => {
        const { url } = await boot();
        const { id } = await imported(url);
        const out = await call(url, 'reader', 'get_batch_tasks', { batchId: id });
        expect(out.isError, JSON.stringify(out.data)).toBeFalsy();
        expect(keysOf(out.data)).toEqual(['a', 'b', 'c']);
        expect(out.data.tasks[0]).toMatchObject({ execution: 'pending', next: null });
        expect(out.data.standing.verdict).toBe('draft');
    });

    it('shows the stage verification evidence beside the tasks of that stage', async () => {
        const { url, store } = await boot();
        const id = await started(url);
        store.plantVerification(id, [
            {
                stage: 'one',
                state: 'failed',
                detail: 'tests red',
                headSha: 'abc123',
                checkedAt: '2026-01-01T00:00:00.000Z',
            },
        ]);
        const out = await call(url, 'reader', 'get_batch_tasks', { batchId: id });
        expect(out.data.tasks[0].verification).toEqual([
            { stage: 'one', state: 'failed', detail: 'tests red', headSha: 'abc123' },
        ]);
        expect(out.data.tasks[2].verification).toEqual([]);
    });

    it('passes on the PR observation and its source SHA as the board has them, stale when the board says so', async () => {
        const { url } = await boot((store) => ({
            ...store,
            report: async (batchId) => {
                const whole = await store.report(batchId);
                if (!whole) return whole;
                const observation = {
                    outcome: 'open',
                    checks: 'passing',
                    mergeability: 'clean',
                    review: null,
                    headSha: 'abc123',
                    targetSha: 'def456',
                    stale: true,
                    observedAt: '2026-01-01T00:00:00.000Z',
                    error: null,
                };
                return { ...whole, tasks: whole.tasks.map((t, n) => (n === 0 ? { ...t, observation } : t)) };
            },
        }));
        const id = await started(url);
        const out = await call(url, 'reader', 'get_batch_tasks', { batchId: id });
        expect(out.data.stale).toBe(true);
        expect(out.data.tasks[0]).toMatchObject({
            sourceSha: 'abc123',
            observation: { stale: true, checks: 'passing' },
        });
        expect(out.data.tasks[1].sourceSha).toBeNull();
    });

    it('is inconclusive, listing no task and claiming no verdict, when the report omits a task', async () => {
        const { url } = await boot((store) => ({
            ...store,
            report: async (batchId) => {
                const whole = await store.report(batchId);
                return whole && { ...whole, tasks: whole.tasks.slice(1) };
            },
        }));
        const id = await started(url);
        const out = await call(url, 'reader', 'get_batch_tasks', { batchId: id });
        expect(out.isError).toBe(true);
        expect(out.data).toMatchObject({ outcome: 'inconclusive' });
        expect(out.data.tasks).toBeUndefined();
    });

    it('is inconclusive when the report cannot be read at all', async () => {
        const { url } = await boot((store) => ({
            ...store,
            snapshot: async () => {
                throw new Error('snapshot unreadable');
            },
        }));
        const id = await started(url);
        const out = await call(url, 'reader', 'get_batch_tasks', { batchId: id });
        expect(out.isError).toBe(true);
        expect(out.data).toMatchObject({ outcome: 'inconclusive' });
    });

    it('refuses a cursor it did not issue, and one from another version of the draft', async () => {
        const { url } = await boot();
        const { id } = await imported(url);
        const page = await call(url, 'reader', 'get_batch_tasks', { batchId: id, limit: 1 });
        expect(page.data.cursor).toEqual(expect.any(String));
        const garbage = await call(url, 'reader', 'get_batch_tasks', { batchId: id, cursor: 'not-a-cursor' });
        expect(garbage.data).toMatchObject({ outcome: 'refused', code: 'bad_cursor' });
        const updated = await call(url, 'both', 'update_batch', {
            batchId: id,
            version: 1,
            plan: plan({ title: 'Other' }),
        });
        expect(updated.isError, JSON.stringify(updated.data)).toBeFalsy();
        const stale = await call(url, 'reader', 'get_batch_tasks', { batchId: id, cursor: page.data.cursor });
        expect(stale.data).toMatchObject({ outcome: 'refused', code: 'stale_cursor' });
    });

    it('refuses a cursor replayed on another batch, never reading that batch from the other one position', async () => {
        const { url } = await boot();
        const mine = await started(url);
        const other = await started(url);
        expect(other).not.toBe(mine);
        const page = await call(url, 'reader', 'get_batch_tasks', { batchId: mine, limit: 1 });
        expect(page.data.cursor).toEqual(expect.any(String));
        const replay = await call(url, 'reader', 'get_batch_tasks', { batchId: other, cursor: page.data.cursor });
        expect(replay.data).toMatchObject({ outcome: 'refused', code: 'bad_cursor' });
        const same = await call(url, 'reader', 'get_batch_tasks', {
            batchId: mine,
            limit: 1,
            cursor: page.data.cursor,
        });
        expect(same.isError, JSON.stringify(same.data)).toBeFalsy();
    });

    it.each([
        ['stage', { stage: 'one' }],
        ['state', { state: 'queued' }],
        ['target', { target: 'web' }],
    ])('refuses a cursor replayed under another filter set (%s)', async (_name, filters) => {
        const { url } = await boot();
        const id = await started(url);
        const page = await call(url, 'reader', 'get_batch_tasks', { batchId: id, limit: 1 });
        expect(page.data.cursor).toEqual(expect.any(String));
        const replay = await call(url, 'reader', 'get_batch_tasks', {
            batchId: id,
            cursor: page.data.cursor,
            ...filters,
        });
        expect(replay.data).toMatchObject({ outcome: 'refused', code: 'bad_cursor' });
    });

    it('takes a cursor back under the filters it was issued with, and refuses it once they differ', async () => {
        const { url } = await boot();
        const id = await started(url);
        const filters = { stage: 'one' };
        const first = await call(url, 'reader', 'get_batch_tasks', { batchId: id, limit: 1, ...filters });
        expect(keysOf(first.data)).toEqual(['a']);
        expect(first.data.cursor).toEqual(expect.any(String));
        const next = await call(url, 'reader', 'get_batch_tasks', {
            batchId: id,
            limit: 1,
            cursor: first.data.cursor,
            ...filters,
        });
        expect(next.isError, JSON.stringify(next.data)).toBeFalsy();
        expect(keysOf(next.data)).toEqual(['b']);
        const other = await call(url, 'reader', 'get_batch_tasks', {
            batchId: id,
            cursor: first.data.cursor,
            stage: 'two',
        });
        expect(other.data).toMatchObject({ outcome: 'refused', code: 'bad_cursor' });
    });

    it('answers a batch of another organization and an unknown batch with the board refusal', async () => {
        const { url } = await boot();
        const mine = await started(url);
        const foreign = await call(url, 'outsider', 'get_batch_tasks', { batchId: mine });
        expect(foreign.data).toMatchObject({ outcome: 'refused', code: 'NOT_FOUND', status: 404 });
        const unknown = await call(url, 'reader', 'get_batch_tasks', { batchId: UNKNOWN_BATCH });
        expect(unknown.data).toMatchObject({ outcome: 'refused', code: 'NOT_FOUND', status: 404 });
    });
});
