import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Sql } from 'postgres';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { McpCaller, OAuthStore } from '../src/auth/oauth-store.js';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore } from '../src/auth/store.js';
import { createArtifactStore, type ArtifactStore } from '../src/artifacts/artifact-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { OrgRegistry } from '../src/orgs.js';
import { BACKENDS } from '../test/artifacts-backends.js';
import { githubAuth, staticRegistry, stubTelemetryClient, telemetryStoreStub, testConfig } from '../test/helpers.js';
import { oauthConnection, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import { buildWorld } from './oauth-rig.js';

/**
 * The task, job, log and question tools over real stores for members of two organizations.
 * `server/test/mcp.tools-jobs.test.ts` holds the fault cases with in-memory fakes.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const LOCALHOST = '127.0.0.1';
const MODERN = '2026-07-28';
const LEASE_SECONDS = 300;
const ORG = testOrg();
const OTHER_ORG = testOrg();
const db = useTestDb({ orgs: [ORG, OTHER_ORG] });
const filesystem = BACKENDS.find((backend) => backend.name === 'filesystem')!;

let sql: Sql;
let jobs: JobStore;
let otherJobs: JobStore;
let artifacts: ArtifactStore;
let otherArtifacts: ArtifactStore;
beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    jobs = createJobStore({ sql, orgId: ORG });
    otherJobs = createJobStore({ sql, orgId: OTHER_ORG });
    const storeOf = async (orgId: string) =>
        createArtifactStore({
            sql,
            orgId,
            ready: Promise.resolve(),
            objects: await filesystem.make(),
            prefix: filesystem.prefix,
        });
    artifacts = await storeOf(ORG);
    otherArtifacts = await storeOf(OTHER_ORG);
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

async function boot() {
    const port = await freePort();
    const publicUrl = `http://${LOCALHOST}:${port}`;
    const resource = `${publicUrl}/api/mcp`;
    const people = {
        alice: (await buildWorld(sql, ORG)).caller,
        carol: (await buildWorld(sql, ORG)).caller,
        bob: (await buildWorld(sql, OTHER_ORG)).caller,
    };
    const tokens = new Map<string, McpCaller>(
        Object.entries(people).map(([who, caller]) => [
            hashToken(`mat_dbjobs-${who}-token-0123456789`).toString('hex'),
            { ...caller, scopes: ['factory:read'], clientId: 'c', resource, familyId: `f-${who}` } as McpCaller,
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
    const registryFor = (store: JobStore, objects: ArtifactStore) =>
        staticRegistry({
            config,
            telemetry: stubTelemetryClient(),
            repos: staticRepoSource([]),
            jobs: store,
            artifacts: objects,
        });
    const orgA = registryFor(jobs, artifacts);
    const orgB = registryFor(otherJobs, otherArtifacts);
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
    return new URL(resource);
}

const call = async (url: URL, who: 'alice' | 'bob' | 'carol', name: string, args: Record<string, unknown> = {}) => {
    const client = new Client({ name: 'dbjobs', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(
        new StreamableHTTPClientTransport(url, {
            requestInit: { headers: { authorization: `Bearer mat_dbjobs-${who}-token-0123456789` } },
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

/** A running job under a live lease, in a repository of its own so a test can find it among the org's tasks. */
async function running(store: JobStore = jobs): Promise<{ id: string; claim: Claim; repo: string }> {
    const repo = `acme/r${randomUUID().slice(0, 8)}`;
    const ref = await store.create('read me', null, { repo, executor: null });
    if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
    const claim = (await store.claim(`w-${ref.id}`, LEASE_SECONDS)) as Claim;
    expect(claim.id).toBe(ref.id);
    return { id: ref.id, claim, repo };
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe.skipIf(!enabled)('the task, job, log and question tools — database', () => {
    it('shows a task with an open question as needs_attention, to its own org only', async () => {
        const url = await boot();
        const { id, claim, repo } = await running();
        await jobs.askQuestion(id, claim.leaseToken, {
            questionId: 'toolu_1',
            questions: [{ question: 'Which db?', header: 'Pick', multiSelect: false, options: [{ label: 'pg' }] }],
        });

        const tasks = await call(url, 'alice', 'list_tasks', { state: 'running', repo });
        expect(tasks.data.tasks).toMatchObject([{ id, state: 'needs_attention', needsAnswer: true, repo }]);
        expect((await call(url, 'bob', 'list_tasks', { state: 'running', repo })).data.tasks).toEqual([]);

        const listed = await call(url, 'alice', 'list_jobs', { repo });
        expect(listed.data.jobs).toMatchObject([{ id, status: 'running', state: 'running' }]);

        const investigated = await call(url, 'alice', 'investigate_job', { jobId: id });
        expect(investigated.data.job).toMatchObject({ id, state: 'needs_attention', openQuestions: 1 });
        const questions = await call(url, 'alice', 'list_questions', { jobId: id });
        expect(questions.data.questions).toMatchObject([
            { jobId: id, id: 'toolu_1', status: 'pending', answerable: true, prompts: [{ question: 'Which db?' }] },
        ]);
        for (const tool of ['investigate_job', 'list_questions', 'list_job_streams', 'read_job_log', 'job_activity']) {
            const refused = await call(url, 'bob', tool, { jobId: id });
            expect(refused.isError, tool).toBe(true);
            expect(refused.data, tool).toMatchObject({ outcome: 'refused', status: 404 });
        }
    });

    it('waits on the real settle long-poll: a live task times out, a stopped one is cancelled, another org gets not-found', async () => {
        const url = await boot();
        const { id } = await running();
        const live = await call(url, 'alice', 'wait_task', { taskId: id, budgetSeconds: 5 });
        expect(live.isError).toBeFalsy();
        expect(live.data).toMatchObject({ result: 'timeout', taskId: id, runId: id, status: 'running' });

        const ref = await jobs.create('never claimed', null, {
            repo: `acme/r${randomUUID().slice(0, 8)}`,
            executor: null,
        });
        if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
        await jobs.stop(ref.id, null);
        const stopped = await call(url, 'alice', 'wait_task', { taskId: ref.id, budgetSeconds: 5 });
        expect(stopped.data).toMatchObject({ result: 'cancelled', state: 'cancelled', runId: ref.id });

        const foreign = await call(url, 'bob', 'wait_task', { taskId: id, budgetSeconds: 5 });
        expect(foreign.isError).toBe(true);
        expect(foreign.data).toMatchObject({ outcome: 'refused', status: 404 });
    });

    it('reports a task and its verified outcome from the real stores, to its own org only', async () => {
        const url = await boot();
        const { id, claim, repo } = await running();
        const asked = await call(url, 'alice', 'get_task_result', { taskId: id });
        expect(asked.data).toMatchObject({ taskId: id, runId: id, status: 'running', state: 'running' });
        await jobs.askQuestion(id, claim.leaseToken, {
            questionId: 'toolu_r',
            questions: [{ question: 'Which db?', header: 'Pick', multiSelect: false, options: [{ label: 'pg' }] }],
        });
        const waiting = await call(url, 'alice', 'get_task_result', { taskId: id });
        expect(waiting.data).toMatchObject({ state: 'needs_attention', attention: { openQuestions: 1 } });

        const detail = await call(url, 'alice', 'get_task', { taskId: id });
        expect(detail.data).toMatchObject({
            taskId: id,
            headRunId: id,
            repo,
            state: 'needs_attention',
            markedDone: false,
        });
        expect(detail.data.attachments).toEqual([]);

        for (const tool of ['get_task', 'get_task_result']) {
            const refused = await call(url, 'bob', tool, { taskId: id });
            expect(refused.isError, tool).toBe(true);
            expect(refused.data, tool).toMatchObject({ outcome: 'refused', status: 404 });
        }
    });

    it('reads a task carrying a real attachment and a personal connection, to a second member of the org without either member-bound field', async () => {
        const url = await boot();
        const owner = (
            await sql<{ id: string }[]>`select user_id as id from org_membership where org_id = ${ORG} limit 1`
        )[0]!.id;
        const connection = await oauthConnection(sql, ORG, owner);
        const attachmentId = randomUUID();
        await sql`
            insert into input_attachment (org_id, id, uploader_id, name, media_type, size_bytes, sha256, object_key, state)
            values (${ORG}, ${attachmentId}, ${owner}, 'spec.md', 'text/markdown', 12, ${'ab'.repeat(32)},
                    ${`k/${attachmentId}`}, 'ready')
        `;
        const repo = `acme/r${randomUUID().slice(0, 8)}`;
        const ref = await jobs.create('use my jira', owner, {
            repo,
            executor: null,
            connectionIds: [connection.id],
            attachmentIds: [attachmentId],
        });
        if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);

        for (const who of ['alice', 'carol'] as const) {
            for (const tool of ['get_task', 'get_task_result']) {
                const { isError, data } = await call(url, who, tool, { taskId: ref.id });
                expect(isError, `${who} ${tool}`).toBeFalsy();
                expect(data.taskId).toBe(ref.id);
                const text = JSON.stringify(data);
                for (const field of ['connections', 'executionUser', 'actingFor', 'connectionId', 'bindingRevision']) {
                    expect(text, `${who} ${tool} ${field}`).not.toContain(field);
                }
                expect(text, `${who} ${tool}`).not.toContain(connection.id);
            }
        }
        const detail = await call(url, 'carol', 'get_task', { taskId: ref.id });
        expect(detail.data.attachments).toEqual([
            {
                id: attachmentId,
                runId: ref.id,
                name: 'spec.md',
                mediaType: 'text/markdown',
                size: 12,
                sha256: 'ab'.repeat(32),
                state: 'bound',
            },
        ]);
    });

    it('reports a finished task as succeeded with the summary the board recorded', async () => {
        const url = await boot();
        const { id, claim } = await running();
        await jobs.complete(id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const { data } = await call(url, 'alice', 'get_task_result', { taskId: id });
        expect(data).toMatchObject({ taskId: id, status: 'succeeded', state: 'succeeded', outcome: 'final' });
        expect(data).not.toHaveProperty('pullRequest');
        expect(data).not.toHaveProperty('error');
    });

    it('reads the log of a run in capped pages, with the stream state, to the last byte', async () => {
        const url = await boot();
        const { id } = await running();
        const scope = (await jobs.artifactScope(id))!;
        const ref = {
            member: scope.member ?? 'unattributed',
            root: scope.root,
            job: id,
            claimSeq: scope.claimSeq,
            executor: 'claude-code',
            session: randomUUID(),
            stream: 'log',
        };
        const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ${'é'.repeat(30)}\n`);
        let offset = 0;
        for (const line of lines) {
            await artifacts.putChunk(ref, offset, bytes(line));
            offset += bytes(line).length;
        }

        const streams = await call(url, 'alice', 'list_job_streams', { jobId: id });
        expect(streams.data.streams).toMatchObject([
            { stream: 'log', state: 'partial', terminalCause: 'not_finalized', chunks: 40 },
        ]);

        let text = '';
        let pages = 0;
        let cursor: string | undefined;
        let complete = true;
        for (let guard = 0; guard < 100; guard += 1) {
            const { data } = await call(url, 'alice', 'read_job_log', {
                jobId: id,
                limitBytes: 256,
                ...(cursor ? { cursor } : {}),
            });
            text += data.segments.map((s: { text: string }) => s.text).join('');
            complete = complete && data.complete;
            pages += 1;
            if (data.cursor === null) break;
            cursor = data.cursor;
        }
        expect(text).toBe(lines.join(''));
        expect(pages).toBeGreaterThan(5);
        expect(complete).toBe(false);

        await artifacts.finalize(ref, {
            producer: 'exporter',
            schemaVersion: 1,
            startedAt: new Date('2026-01-01T00:00:00Z'),
            finishedAt: new Date('2026-01-01T00:05:00Z'),
            state: 'complete',
            terminalCause: null,
        });
        const done = await call(url, 'alice', 'read_job_log', { jobId: id, limitBytes: 262144 });
        expect(done.data).toMatchObject({ cursor: null, complete: true });
    });

    it('cuts a chunk larger than the cap on a character boundary and reaches its last byte', async () => {
        const url = await boot();
        const { id } = await running();
        const scope = (await jobs.artifactScope(id))!;
        const ref = {
            member: scope.member ?? 'unattributed',
            root: scope.root,
            job: id,
            claimSeq: scope.claimSeq,
            executor: 'claude-code',
            session: randomUUID(),
            stream: 'log',
        };
        const big = `${'€'.repeat(300)}END`;
        await artifacts.putChunk(ref, 0, bytes(big));

        let text = '';
        let cuts = 0;
        let cursor: string | undefined;
        for (let guard = 0; guard < 20; guard += 1) {
            const { data } = await call(url, 'alice', 'read_job_log', {
                jobId: id,
                limitBytes: 256,
                ...(cursor ? { cursor } : {}),
            });
            const got = data.segments.map((s: { text: string }) => s.text).join('');
            expect(got).not.toContain('\uFFFD');
            expect(Buffer.byteLength(got)).toBeLessThanOrEqual(256);
            if (data.truncated) cuts += 1;
            text += got;
            if (data.cursor === null) break;
            cursor = data.cursor;
        }
        expect(cuts).toBeGreaterThan(1);
        expect(text).toBe(big);
    });

    it('reads the activity of a run without inventing a measurement', async () => {
        const url = await boot();
        const { id } = await running();
        const { data } = await call(url, 'alice', 'job_activity', { jobId: id });
        expect(data.jobId).toBe(id);
        expect(['unmeasured', 'unavailable']).toContain(data.usage.state);
    });
});
