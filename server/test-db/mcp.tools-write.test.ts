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
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { OrgRegistry } from '../src/orgs.js';
import {
    githubAuth,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
} from '../test/helpers.js';
import { BATCH_REPO, batchPlan, headOf, prTask, rootOf, startBatch } from './batch-fixtures.js';
import { oauthConnection, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import { buildWorld } from './oauth-rig.js';

/**
 * The task write tools over real stores for members of two organizations: the board's own answers, verbatim.
 * `server/test/mcp.tools-write.test.ts` holds the in-memory fakes.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const LOCALHOST = '127.0.0.1';
const MODERN = '2026-07-28';
const LEASE_SECONDS = 300;
const COMMAND_LIMIT = 16_384;
const ORG = testOrg();
const OTHER_ORG = testOrg();
const db = useTestDb({ orgs: [ORG, OTHER_ORG] });

let sql: Sql;
let jobs: JobStore;
let otherJobs: JobStore;
let batches: BatchStore;
beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    const prs = createPrLifecycleStore({ sql, orgId: ORG });
    jobs = createJobStore({ sql, orgId: ORG, prs });
    otherJobs = createJobStore({ sql, orgId: OTHER_ORG });
    batches = createBatchStore({
        sql,
        orgId: ORG,
        stop: (id, by) => jobs.stop(id, by),
        close: (id, by) => jobs.markDone(id, by),
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

type Who = 'alice' | 'carol' | 'reader' | 'bob';
const SCOPES: Record<Who, McpCaller['scopes']> = {
    alice: ['factory:read', 'factory:write'],
    carol: ['factory:read', 'factory:write'],
    reader: ['factory:read'],
    bob: ['factory:read', 'factory:write'],
};
const tokenOf = (who: Who) => `mat_dbwrite-${who}-token-0123456789`;

async function boot() {
    const port = await freePort();
    const publicUrl = `http://${LOCALHOST}:${port}`;
    const resource = `${publicUrl}/api/mcp`;
    const people = {
        alice: (await buildWorld(sql, ORG)).caller,
        carol: (await buildWorld(sql, ORG)).caller,
        reader: (await buildWorld(sql, ORG)).caller,
        bob: (await buildWorld(sql, OTHER_ORG)).caller,
    };
    const tokens = new Map<string, McpCaller>(
        (Object.keys(people) as Who[]).map((who) => [
            hashToken(tokenOf(who)).toString('hex'),
            { ...people[who], scopes: SCOPES[who], clientId: 'c', resource, familyId: `f-${who}` } as McpCaller,
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
    const repos = staticRepoSource([{ owner: 'acme', name: 'web' }]);
    const orgA = staticRegistry({ config, telemetry: stubTelemetryClient(), repos, jobs, batches });
    const orgB = staticRegistry({ config, telemetry: stubTelemetryClient(), repos, jobs: otherJobs });
    const orgs: OrgRegistry = { ...orgA, for: (id) => (id === OTHER_ORG ? orgB.for(id) : orgA.for(id)) };
    const auth = createAuthStore({ sql });
    const app = await buildApp({
        config,
        orgs,
        store: telemetryStoreStub(),
        auth,
        oauth: oauth as OAuthStore,
    });
    closers.push(() => app.close());
    await app.listen({ port, host: LOCALHOST });
    return {
        url: new URL(resource),
        userOf: (who: Who) => people[who].user.id,
        /** The board's own HTTP route as the member's signed-in session: what the web app calls. */
        bind: async (who: Who, id: string, body: Record<string, unknown>) => {
            const response = await app.inject({
                method: 'POST',
                url: `/api/jobs/${id}/connections`,
                headers: { cookie: await signedIn(auth, people[who]), 'content-type': 'application/json' },
                payload: JSON.stringify(body),
            });
            return { status: response.statusCode, body: response.json() as Record<string, unknown> };
        },
    };
}

const call = async (url: URL, who: Who, name: string, args: Record<string, unknown> = {}) => {
    const client = new Client({ name: 'dbwrite', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
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

const REPO = 'acme/web';
const created = async (url: URL, who: Who, args: Record<string, unknown> = {}) => {
    const made = await call(url, who, 'create_task', { command: `task ${randomUUID()}`, repo: REPO, ...args });
    expect(made.isError, JSON.stringify(made.data)).toBeFalsy();
    return made.data.id as string;
};

/** Claims queued rows (any another test of this file left behind first) until the named one is running. */
async function claimed(id: string): Promise<Claim> {
    for (let attempt = 0; attempt < 50; attempt++) {
        const claim = await jobs.claim(`w-${randomUUID()}`, LEASE_SECONDS);
        if (claim && claim.id === id) return claim;
        if (!claim) break;
    }
    throw new Error(`could not claim ${id}`);
}

const settle = (id: string, status: 'succeeded' | 'failed') =>
    sql`update job set status = ${status}, finished_at = now(), lease_token = null, exit_code = 0 where id = ${id}`;

const commandOf = async (id: string) =>
    (await sql<{ command: string }[]>`select command from job where org_id = ${ORG} and id = ${id}`)[0]?.command;

const countJobs = async () =>
    Number((await sql<{ n: string }[]>`select count(*) as n from job where org_id = ${ORG}`)[0]!.n);

const WRITE_TOOLS: readonly (readonly [string, (id: string) => Record<string, unknown>])[] = [
    ['create_task', () => ({ command: 'nope', repo: REPO })],
    ['follow_up_task', (id) => ({ jobId: id, command: 'nope' })],
    ['retry_task', (id) => ({ jobId: id })],
    ['edit_task', (id) => ({ jobId: id, command: 'nope' })],
    ['answer_question', (id) => ({ jobId: id, questionId: 'toolu_x', answers: ['a'] })],
    ['stop_task', (id) => ({ jobId: id, confirm: true })],
    ['mark_task_done', (id) => ({ jobId: id })],
    ['force_close_task', (id) => ({ jobId: id, confirm: true })],
    ['reopen_task', (id) => ({ jobId: id })],
    ['remove_task', (id) => ({ jobId: id, confirm: true })],
];

describe.skipIf(!enabled)('the task write tools — database', () => {
    it('keeps command text exactly, and refuses empty and over-long text with nothing created', async () => {
        const { url, userOf } = await boot();
        const text = `line one\r\n\ttabbed — ünïcødé 日本語 🚀 ${'é'.repeat(50)}\n\ntrailing newline\n`;
        const id = await created(url, 'alice', { command: text });
        expect(await commandOf(id)).toBe(text);
        const [row] = await sql<{ created_by: string }[]>`select created_by from job where id = ${id}`;
        expect(row?.created_by).toBe(userOf('alice'));

        const before = await countJobs();
        for (const command of ['', ' \n\t ', 'x'.repeat(COMMAND_LIMIT + 1)]) {
            const refused = await call(url, 'alice', 'create_task', { command, repo: REPO });
            expect(refused.isError).toBe(true);
            expect(refused.data).toMatchObject({ outcome: 'refused', code: 'BAD_COMMAND', status: 400 });
        }
        expect(await countJobs()).toBe(before);
        const atLimit = await created(url, 'alice', { command: 'y'.repeat(COMMAND_LIMIT) });
        expect(await commandOf(atLimit)).toHaveLength(COMMAND_LIMIT);
    });

    it('edits a queued task, then surfaces the board refusals verbatim: after the claim and by another member', async () => {
        const { url } = await boot();
        const id = await created(url, 'alice');
        const edited = await call(url, 'alice', 'edit_task', { jobId: id, command: 'edited\nbefore claim' });
        expect(edited.data).toMatchObject({ id, status: 'queued', command: 'edited\nbefore claim' });
        expect(await commandOf(id)).toBe('edited\nbefore claim');

        const other = await created(url, 'alice');
        const foreign = await call(url, 'carol', 'edit_task', { jobId: other, command: 'mine now' });
        expect(foreign.isError).toBe(true);
        expect(foreign.data).toMatchObject({ outcome: 'refused', code: 'FORBIDDEN', status: 403 });

        await claimed(id);
        const late = await call(url, 'alice', 'edit_task', { jobId: id, command: 'too late' });
        expect(late.isError).toBe(true);
        expect(late.data).toMatchObject({ outcome: 'refused', code: 'NOT_QUEUED', status: 409 });
        expect(late.data.message).toMatch(/only a queued task's command can be edited/);
        expect(await commandOf(id)).toBe('edited\nbefore claim');
    });

    it('runs the finish path: done, a replayed done, reopen, a second reopen refused, follow-up and retry', async () => {
        const { url } = await boot();
        const id = await created(url, 'alice');
        await claimed(id);
        const early = await call(url, 'alice', 'mark_task_done', { jobId: id });
        expect(early.data).toMatchObject({ outcome: 'refused', code: 'NOT_FINISHED', status: 409 });
        await settle(id, 'succeeded');

        const done = await call(url, 'alice', 'mark_task_done', { jobId: id });
        expect(done.isError).toBeFalsy();
        expect(done.data).toMatchObject({ id, status: 'succeeded' });
        expect(done.data.doneAt).toEqual(expect.any(String));
        const again = await call(url, 'alice', 'mark_task_done', { jobId: id });
        expect(again.data.doneAt).toBe(done.data.doneAt);

        expect((await call(url, 'alice', 'reopen_task', { jobId: id })).data).toEqual({ id, reopened: true });
        const second = await call(url, 'alice', 'reopen_task', { jobId: id });
        expect(second.data).toMatchObject({ outcome: 'refused', code: 'TASK_NOT_DONE', status: 409 });

        const followed = await call(url, 'alice', 'follow_up_task', { jobId: id, command: 'now also\nthis' });
        expect(followed.isError, JSON.stringify(followed.data)).toBeFalsy();
        expect(followed.data.status).toBe('queued');
        expect(followed.data.id).not.toBe(id);
        expect(await commandOf(followed.data.id)).toBe('now also\nthis');

        const failing = await created(url, 'alice');
        await claimed(failing);
        await settle(failing, 'failed');
        const retried = await call(url, 'alice', 'retry_task', { jobId: failing });
        expect(retried.isError, JSON.stringify(retried.data)).toBeFalsy();
        expect(retried.data.status).toBe('queued');
        expect(retried.data.id).not.toBe(failing);
    });

    it('stops a queued task and removes a stopped one, only with confirm:true', async () => {
        const { url } = await boot();
        const queued = await created(url, 'alice');
        const unconfirmed = await call(url, 'alice', 'stop_task', { jobId: queued });
        expect(unconfirmed.data).toMatchObject({ outcome: 'refused', code: 'confirmation_required' });
        expect((await sql`select status from job where id = ${queued}`)[0]?.status).toBe('queued');
        const stopped = await call(url, 'alice', 'stop_task', { jobId: queued, confirm: true });
        expect(stopped.data).toMatchObject({ id: queued, status: 'stopped' });
        const again = await call(url, 'alice', 'stop_task', { jobId: queued, confirm: true });
        expect(again.data).toMatchObject({ outcome: 'refused', code: 'NOT_STOPPABLE', status: 409 });

        const running = await created(url, 'alice');
        await claimed(running);
        const busy = await call(url, 'alice', 'remove_task', { jobId: running, confirm: true });
        expect(busy.data).toMatchObject({ outcome: 'refused', code: 'TASK_RUNNING', status: 409 });

        for (const args of [{ jobId: queued }, { jobId: queued, confirm: false }]) {
            const refused = await call(url, 'alice', 'remove_task', args);
            expect(refused.data).toMatchObject({ outcome: 'refused', code: 'confirmation_required' });
        }
        expect(await commandOf(queued)).toBeDefined();
        expect((await call(url, 'alice', 'remove_task', { jobId: queued, confirm: true })).data).toEqual({
            id: queued,
            removed: true,
        });
        expect(await commandOf(queued)).toBeUndefined();
    });

    it('replays a keyed write as the same task, and refuses a different request under the same key', async () => {
        const { url } = await boot();
        const key = `key-${randomUUID()}`;
        const command = `keyed ${randomUUID()}`;
        const first = await call(url, 'alice', 'create_task', { command, repo: REPO, idempotencyKey: key });
        const replay = await call(url, 'alice', 'create_task', { command, repo: REPO, idempotencyKey: key });
        expect(replay.isError).toBeFalsy();
        expect(replay.data.id).toBe(first.data.id);
        const [row] = await sql<{ n: string }[]>`select count(*) as n from job where command = ${command}`;
        expect(Number(row?.n)).toBe(1);
        const changed = await call(url, 'alice', 'create_task', {
            command: `${command} changed`,
            repo: REPO,
            idempotencyKey: key,
        });
        expect(changed.isError).toBe(true);
        expect(changed.data).toMatchObject({ outcome: 'refused', code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });

        const id = await created(url, 'alice');
        await claimed(id);
        await settle(id, 'succeeded');
        const followKey = `follow-${randomUUID()}`;
        const one = await call(url, 'alice', 'follow_up_task', {
            jobId: id,
            command: 'again',
            idempotencyKey: followKey,
        });
        const two = await call(url, 'alice', 'follow_up_task', {
            jobId: id,
            command: 'again',
            idempotencyKey: followKey,
        });
        expect(two.data.id).toBe(one.data.id);
        const third = await call(url, 'alice', 'follow_up_task', {
            jobId: id,
            command: 'other',
            idempotencyKey: followKey,
        });
        expect(third.data).toMatchObject({ outcome: 'refused', code: 'IDEMPOTENCY_KEY_REUSED' });
    });

    describe('attachments', () => {
        const seed = async (uploader: string) => {
            const id = randomUUID();
            await sql`
                insert into input_attachment (org_id, id, uploader_id, name, media_type, size_bytes, sha256, object_key, state)
                values (${ORG}, ${id}, ${uploader}, 'spec.md', 'text/markdown', 12, ${'ab'.repeat(32)}, ${`k/${id}`}, 'ready')
            `;
            return id;
        };
        const stateOf = async (id: string) =>
            (await sql<{ state: string }[]>`select state from input_attachment where org_id = ${ORG} and id = ${id}`)[0]
                ?.state;

        it('binds the caller’s own completed attachment, replays the same ids and conflicts on changed ones', async () => {
            const { url, userOf } = await boot();
            const mine = await seed(userOf('alice'));
            const other = await seed(userOf('alice'));
            const key = `att-${randomUUID()}`;
            const command = `with files ${randomUUID()}`;
            const first = await call(url, 'alice', 'create_task', {
                command,
                repo: REPO,
                attachmentIds: [mine],
                idempotencyKey: key,
            });
            expect(first.isError, JSON.stringify(first.data)).toBeFalsy();
            expect(await stateOf(mine)).not.toBe('ready');
            const replay = await call(url, 'alice', 'create_task', {
                command,
                repo: REPO,
                attachmentIds: [mine],
                idempotencyKey: key,
            });
            expect(replay.data.id).toBe(first.data.id);
            const changed = await call(url, 'alice', 'create_task', {
                command,
                repo: REPO,
                attachmentIds: [other],
                idempotencyKey: key,
            });
            expect(changed.data).toMatchObject({ outcome: 'refused', code: 'IDEMPOTENCY_KEY_REUSED' });
            expect(await stateOf(other)).toBe('ready');
        });

        it('refuses another member’s attachment, an unknown one, and a request with one bad id among good ones, creating nothing', async () => {
            const { url, userOf } = await boot();
            const aliceFile = await seed(userOf('alice'));
            const before = await countJobs();

            const stolen = await call(url, 'carol', 'create_task', {
                command: 'borrow',
                repo: REPO,
                attachmentIds: [aliceFile],
            });
            expect(stolen.isError).toBe(true);
            expect(stolen.data).toMatchObject({ outcome: 'refused', code: 'ATTACHMENT_NOT_AUTHORIZED', status: 403 });

            const mixed = await call(url, 'alice', 'create_task', {
                command: 'mixed',
                repo: REPO,
                attachmentIds: [aliceFile, randomUUID()],
            });
            expect(mixed.data).toMatchObject({ outcome: 'refused', code: 'ATTACHMENT_NOT_AUTHORIZED' });
            const duplicate = await call(url, 'alice', 'create_task', {
                command: 'twice',
                repo: REPO,
                attachmentIds: [aliceFile, aliceFile],
            });
            expect(duplicate.data).toMatchObject({ outcome: 'refused', code: 'BAD_ATTACHMENT' });
            const notAnId = await call(url, 'alice', 'create_task', {
                command: 'junk',
                repo: REPO,
                attachmentIds: ['../etc/passwd'],
            });
            expect(notAnId.data).toMatchObject({ outcome: 'refused', code: 'BAD_ATTACHMENT' });

            expect(await countJobs()).toBe(before);
            expect(await stateOf(aliceFile)).toBe('ready');
            expect(JSON.stringify([stolen.data, mixed.data])).not.toContain('spec.md');
        });

        it('binds attachments to a follow-up the same way', async () => {
            const { url, userOf } = await boot();
            const id = await created(url, 'alice');
            await claimed(id);
            await settle(id, 'succeeded');
            const file = await seed(userOf('alice'));
            const refused = await call(url, 'carol', 'follow_up_task', {
                jobId: id,
                command: 'with file',
                attachmentIds: [file],
            });
            expect(refused.data).toMatchObject({ outcome: 'refused' });
            expect(await stateOf(file)).toBe('ready');
            const bound = await call(url, 'alice', 'follow_up_task', {
                jobId: id,
                command: 'with file',
                attachmentIds: [file],
            });
            expect(bound.isError, JSON.stringify(bound.data)).toBeFalsy();
            expect(await stateOf(file)).not.toBe('ready');
        });
    });

    it('answers a question once and surfaces the loss of a race verbatim', async () => {
        const { url } = await boot();
        const id = await created(url, 'alice');
        const claim = await claimed(id);
        await jobs.askQuestion(id, claim.leaseToken, {
            questionId: 'toolu_w1',
            questions: [
                { question: 'Which db?', header: 'Pick', multiSelect: false, options: [{ label: 'pg' }] },
                { question: 'Which port?', header: 'Port', multiSelect: false, options: [{ label: '80' }] },
            ],
        });
        const short = await call(url, 'alice', 'answer_question', {
            jobId: id,
            questionId: 'toolu_w1',
            answers: ['pg'],
        });
        expect(short.data).toMatchObject({ outcome: 'refused', code: 'answers_mismatch' });
        const answered = await call(url, 'alice', 'answer_question', {
            jobId: id,
            questionId: 'toolu_w1',
            answers: ['pg', '80'],
        });
        expect(answered.isError, JSON.stringify(answered.data)).toBeFalsy();
        expect(answered.data).toMatchObject({
            id: 'toolu_w1',
            status: 'answered',
            answers: { 'Which db?': 'pg', 'Which port?': '80' },
        });
        const lost = await call(url, 'carol', 'answer_question', {
            jobId: id,
            questionId: 'toolu_w1',
            answers: ['pg', '80'],
        });
        expect(lost.isError).toBe(true);
        expect(lost.data).toMatchObject({ outcome: 'refused', code: 'QUESTION_ANSWERED', status: 409 });
        const missing = await call(url, 'alice', 'answer_question', { jobId: id, questionId: 'nope', answers: ['a'] });
        expect(missing.data).toMatchObject({ outcome: 'refused', code: 'question_not_found' });
    });

    it('refuses a plain done on a live batch thread and closes it only through force_close_task with confirm:true', async () => {
        const { url, userOf } = await boot();
        const batchId = await startBatch(
            batches,
            batchPlan('Writes', [{ key: 'one', tasks: [prTask('a')] }]),
            userOf('alice')
        );
        await batches.reconcile(batchId);
        const root = await rootOf(batches, batchId, 'a');
        expect(BATCH_REPO).toBe(REPO);

        const plain = await call(url, 'alice', 'mark_task_done', { jobId: root });
        expect(plain.isError).toBe(true);
        expect(plain.data).toMatchObject({ outcome: 'refused', code: 'BATCH_TASK_THREAD', status: 409 });
        expect(plain.data.message).toMatch(/live batch/);

        const unconfirmed = await call(url, 'alice', 'force_close_task', { jobId: root });
        expect(unconfirmed.data).toMatchObject({ outcome: 'refused', code: 'confirmation_required' });
        expect((await headOf(sql, root)).status).not.toBe('stopped');

        const forced = await call(url, 'alice', 'force_close_task', { jobId: root, confirm: true });
        expect(forced.isError, JSON.stringify(forced.data)).toBeFalsy();
        expect(forced.data).toMatchObject({ id: root, batch: batchId, task: 'a', outcome: 'cancelled' });
        expect((await headOf(sql, root)).status).toBe('stopped');
        const [task] = (await batches.get(batchId))!.tasks.filter((t) => t.key === 'a');
        expect(task?.execution).toBe('cancelled');
    });

    it('refuses a read-scope token on every write tool and an outsider as not found, changing nothing', async () => {
        const { url } = await boot();
        const id = await created(url, 'alice');
        const before = await countJobs();
        for (const [name, args] of WRITE_TOOLS) {
            const refused = await call(url, 'reader', name, args(id));
            expect(refused.isError, name).toBe(true);
            expect(refused.data, name).toMatchObject({ outcome: 'refused', code: 'insufficient_scope' });
        }
        expect(await countJobs()).toBe(before);
        expect(await commandOf(id)).toBeDefined();

        for (const [name, args] of WRITE_TOOLS.filter(([tool]) => tool !== 'create_task')) {
            const outsider = await call(url, 'bob', name, args(id));
            expect(outsider.isError, name).toBe(true);
            expect(outsider.data, name).toMatchObject({ outcome: 'refused', status: 404 });
        }
        expect(await commandOf(id)).toBeDefined();
    });

    it('a task created with a missing integration parks on a requirement; the same user connecting resumes that task, no new one', async () => {
        const { url, userOf, bind } = await boot();
        const id = await created(url, 'alice', { skills: ['jira'] });
        const before = await countJobs();
        const requirement = () =>
            sql<{ source: string; satisfied_at: Date | null }[]>`
                select source, satisfied_at from job_integration_requirement where root_job_id = ${id}`;
        expect(await requirement()).toMatchObject([{ source: 'create', satisfied_at: null }]);
        // Held: the claim loop never hands the parked task to a worker.
        for (let attempt = 0; attempt < 50; attempt++) {
            const claim = await jobs.claim(`w-${randomUUID()}`, LEASE_SECONDS);
            if (!claim) break;
            expect(claim.id).not.toBe(id);
        }

        const connection = await oauthConnection(sql, ORG, userOf('alice'));
        const [row] = await sql<{ rev: number }[]>`select binding_revision as rev from job where id = ${id}`;
        const body = { connectionId: connection.id, bindingRevision: row!.rev };
        const stillParked = async () => {
            expect((await requirement())[0]?.satisfied_at).toBeNull();
            for (let attempt = 0; attempt < 50; attempt++) {
                const claim = await jobs.claim(`w-${randomUUID()}`, LEASE_SECONDS);
                if (!claim) break;
                expect(claim.id).not.toBe(id);
            }
        };

        // Another member of the org, and a member of another org, cannot bind alice's connection to her task.
        const carol = await bind('carol', id, body);
        expect(carol.status).toBeGreaterThanOrEqual(400);
        const bob = await bind('bob', id, body);
        expect(bob.status).toBe(404);
        await stillParked();

        const bound = await bind('alice', id, body);
        expect(bound.status, JSON.stringify(bound.body)).toBe(200);

        expect(await requirement()).toMatchObject([{ source: 'create' }]);
        expect((await requirement())[0]?.satisfied_at).not.toBeNull();
        expect((await claimed(id)).id).toBe(id);
        expect(await countJobs()).toBe(before);
    });
});
