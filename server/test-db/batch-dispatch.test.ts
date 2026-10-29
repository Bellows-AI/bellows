import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { resolveBatchPlan, taskUsageOf, type BatchPlan, type TokenType } from '@factory-ai/core';
import { randomUUID } from 'node:crypto';
import { createBatchStore } from '../src/db/batches/batch-store.js';
import { readReport } from '../src/db/batches/batch-store-report.js';
import { readUsageFacts } from '../src/telemetry/usage-facts.js';
import { createWorld } from './usage-world.js';
import type { BatchStore } from '../src/db/batches/batch-store-types.js';
import { claimDue, commitObservation } from '../src/db/batches/batch-store-observation.js';
import { createPrLifecycleStore, type PrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { markExecutionsRemoved } from '../src/db/jobs/job-store-provenance.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { createOrgRegistry } from '../src/orgs.js';
import { testSecretStore } from './env-secrets-harness.js';
import { testConfig } from '../test/helpers-config.js';
import { useTestDb } from './harness.js';
import { expireLease, startRow, testOrg, testUser } from './fixtures.js';
import {
    batchPlan,
    headOf as sharedHeadOf,
    jobCount as sharedJobCount,
    BATCH_REPO,
    recordPr,
    rootOf,
    startBatch,
} from './batch-fixtures.js';

/**
 * Dispatch against a real database (docs/batches.md): the scheduler's transactions, the unique
 * decisions and the row lock are what these pin — the pure decisions are core/test/batch-schedule.test.ts.
 */

const enabled = Boolean(process.env.DATABASE_URL);

const ORG = testOrg();
/** Its own org, so its claims see no queued row another test left behind. */
const CLAIM_ORG = testOrg();
const ALICE_USER = testUser('alice');
const ALICE = ALICE_USER.id;
/** A well-formed uuid no batch carries. */
const ABSENT = randomUUID();

const db = useTestDb({ orgs: [ORG, CLAIM_ORG], users: [ALICE_USER], max: 10 });

let sql: Sql;
let jobs: JobStore;
let store: BatchStore;
let prs: PrLifecycleStore;

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    prs = createPrLifecycleStore({ sql, orgId: ORG });
    jobs = createJobStore({ sql, orgId: ORG, prs });
    store = createBatchStore({
        sql,
        orgId: ORG,
        stop: (id, by) => jobs.stop(id, by),
        close: (id, by) => jobs.markDone(id, by),
    });
});

const task = (key: string, extra: Record<string, unknown> = {}) => ({
    key,
    objective: `do ${key}`,
    acceptance: `${key} works`,
    verification: 'npm test',
    // A person's acceptance is the gate these dispatch tests drive; the PR gate has its own block.
    completion: { kind: 'accepted', condition: 'reviewed' },
    ...extra,
});

const plan = (stages: Record<string, unknown>[], concurrency = 2): BatchPlan =>
    batchPlan('Dispatch', stages, { concurrency });

const parallelThenJoin = (concurrency = 2) =>
    plan(
        [
            { key: 'build', tasks: [task('a'), task('b')] },
            { key: 'join', tasks: [task('j')] },
        ],
        concurrency
    );

const frozen = (source: BatchPlan, target: BatchStore = store) => startBatch(target, source, ALICE);

const stateOf = async (id: string) => {
    const record = (await store.get(id))!;
    return Object.fromEntries(record.tasks.map((t) => [t.key, t]));
};

const headOf = (root: string) => sharedHeadOf(sql, root);

const setStatus = async (root: string, status: 'running' | 'succeeded' | 'failed') => {
    const head = await headOf(root);
    if (status === 'running') {
        await sql`update job set status = 'running', claimed_by = 'w1', started_at = now() where id = ${head.id}`;
    } else {
        await startRow(sql, head.id);
        await sql`update job set status = ${status}, finished_at = now(), lease_token = null where id = ${head.id}`;
    }
};

const jobCount = () => sharedJobCount(sql);
const decisions = async (id: string) =>
    (await sql<{ key: string }[]>`select key from batch_decision where batch_id = ${id} order by key`).map(
        (r) => r.key
    );

describe.skipIf(!enabled)('batch dispatch', () => {
    it('start queues nothing; the first pass runs the two parallel tasks and holds the join stage', async () => {
        const id = await frozen(parallelThenJoin());
        expect(await jobCount()).toBe(0);

        await store.reconcile(id);
        const tasks = await stateOf(id);
        expect(tasks.a).toMatchObject({ execution: 'queued', attempt: 1 });
        expect(tasks.b).toMatchObject({ execution: 'queued', attempt: 1 });
        expect(tasks.j).toMatchObject({ execution: 'pending', rootJobId: null, attempt: 0 });
        expect(await jobCount()).toBe(2);
        expect((await store.get(id))!.activeStage).toBe('build');
    });

    it('creates ordinary roots from the frozen plan: repo, author, executor, instructions and the recorded branch', async () => {
        const id = await frozen(parallelThenJoin());
        await store.reconcile(id);
        const { a } = await stateOf(id);
        const [job] = await sql<
            { id: string; root_job_id: string; repo: string; executor: string; created_by: string; command: string }[]
        >`
            select id, root_job_id, repo, executor, created_by, command from job where id = ${a!.rootJobId}
        `;
        expect(job).toMatchObject({
            id: a!.rootJobId,
            root_job_id: a!.rootJobId,
            repo: 'acme/web',
            executor: 'claude',
            created_by: ALICE,
        });
        expect(job!.command).toBe('do a\n\nAcceptance:\na works\n\nVerification:\nnpm test');
        const [attempt] = await sql`select kind, job_id, repo, source_branch from batch_attempt where task_key = 'a'`;
        expect(attempt).toMatchObject({
            kind: 'launch',
            job_id: a!.rootJobId,
            repo: 'acme/web',
            source_branch: 'main',
        });
    });

    it('launches each task in its frozen executor scope, and a retry keeps it', async () => {
        const id = await frozen(plan([{ key: 'build', tasks: [task('a', { executorScope: 'org' }), task('b')] }]));
        await store.reconcile(id);
        const scopeOf = async (jobId: string) =>
            (await sql<{ executor_scope: string }[]>`select executor_scope from job where id = ${jobId}`)[0]!
                .executor_scope;
        const { a, b } = await stateOf(id);
        expect(await scopeOf(a!.rootJobId!)).toBe('org');
        expect(await scopeOf(b!.rootJobId!)).toBe('user');

        await setStatus(a!.rootJobId!, 'failed');
        await store.reconcile(id);
        expect(await store.retry(id, 'a')).toEqual({ result: 'ok' });
        await store.reconcile(id);
        const retried = await headOf(a!.rootJobId!);
        expect(retried.id).not.toBe(a!.rootJobId);
        expect(await scopeOf(retried.id)).toBe('org');
    });

    it('holds the concurrency limit, counting a moving task', async () => {
        const id = await frozen(parallelThenJoin(1));
        await store.reconcile(id);
        const tasks = await stateOf(id);
        expect([tasks.a!.execution, tasks.b!.execution].sort()).toEqual(['pending', 'queued']);
        expect(await jobCount()).toBe(1);
    });

    it('does not advance on a successful verdict alone; a recorded acceptance does, and the join stage then starts', async () => {
        const id = await frozen(parallelThenJoin());
        await store.reconcile(id);
        let tasks = await stateOf(id);
        await setStatus(tasks.a!.rootJobId!, 'succeeded');
        await setStatus(tasks.b!.rootJobId!, 'succeeded');

        await store.reconcile(id);
        tasks = await stateOf(id);
        expect(tasks.a).toMatchObject({ execution: 'succeeded', gate: 'open' });
        expect(tasks.j!.execution).toBe('pending');
        expect((await store.get(id))!.activeStage).toBe('build');

        expect(tasks.a!.waitReason).toBe('waiting for acceptance: reviewed');

        // A manual done is not an acceptance either: the batch's threads refuse it outright.
        expect(await jobs.markDone(tasks.a!.rootJobId!, ALICE)).toBe('batch');
        await store.reconcile(id);
        expect((await stateOf(id)).j!.execution).toBe('pending');

        await store.accept(id, 'a', ALICE);
        await store.accept(id, 'b', ALICE);
        tasks = await stateOf(id);
        expect(tasks.j).toMatchObject({ execution: 'queued', attempt: 1 });
        expect((await store.get(id))!.activeStage).toBe('join');
        expect(await decisions(id)).toContain('advance:build');
    });

    it('finishes the batch once the last stage is accepted', async () => {
        const id = await frozen(plan([{ key: 'only', tasks: [task('a')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        await setStatus(a!.rootJobId!, 'succeeded');
        await store.accept(id, 'a', ALICE);
        const record = (await store.get(id))!;
        expect(record.completedAt).not.toBeNull();
        expect(record.activeStage).toBeNull();
        expect(await decisions(id)).toEqual(['advance:only', 'complete', 'launch:a:1']);
    });

    it('continues a healthy sibling after a task fails, and retries the failed one in its own thread', async () => {
        const id = await frozen(parallelThenJoin());
        await store.reconcile(id);
        let tasks = await stateOf(id);
        const failedRoot = tasks.a!.rootJobId!;
        await setStatus(failedRoot, 'failed');
        await setStatus(tasks.b!.rootJobId!, 'succeeded');
        await store.accept(id, 'b', ALICE);
        tasks = await stateOf(id);
        expect(tasks.a!.execution).toBe('failed');
        expect(tasks.j!.execution).toBe('pending');

        expect(await store.retry(id, 'a')).toEqual({ result: 'ok' });
        tasks = await stateOf(id);
        expect(tasks.a).toMatchObject({ execution: 'queued', attempt: 2, rootJobId: failedRoot });
        const [retried] = await sql<
            { id: string }[]
        >`select id from job where root_job_id = ${failedRoot} order by created_at desc`;
        expect(retried!.id).not.toBe(failedRoot);
        expect(
            (await sql`select kind from batch_attempt where task_key = 'a' order by attempt`).map((r) => r.kind)
        ).toEqual(['launch', 'retry']);
    });

    it('queues a retry behind a full concurrency limit instead of exceeding it', async () => {
        const id = await frozen(plan([{ key: 'one', tasks: [task('a'), task('b')] }], 1));
        await store.reconcile(id);
        let tasks = await stateOf(id);
        const first = tasks.a!.execution === 'queued' ? 'a' : 'b';
        const second = first === 'a' ? 'b' : 'a';
        await setStatus(tasks[first]!.rootJobId!, 'failed');
        await store.reconcile(id);
        tasks = await stateOf(id);
        expect(tasks[second]!.execution).toBe('queued');

        expect(await store.retry(id, first)).toEqual({ result: 'ok' });
        tasks = await stateOf(id);
        expect(tasks[first]!.execution).toBe('retry');
        expect(await jobCount()).toBe(2);

        await setStatus(tasks[second]!.rootJobId!, 'succeeded');
        await store.reconcile(id);
        tasks = await stateOf(id);
        expect(tasks[first]).toMatchObject({ execution: 'queued', attempt: 2 });
    });

    it('refuses a retry of a healthy task, and a repeated retry request is one launch', async () => {
        const id = await frozen(parallelThenJoin());
        await store.reconcile(id);
        expect(await store.retry(id, 'a')).toEqual({ result: 'not_retryable' });
        expect(await store.retry(id, 'nope')).toEqual({ result: 'no_task' });
        const { a } = await stateOf(id);
        await setStatus(a!.rootJobId!, 'failed');
        await store.reconcile(id);
        await Promise.all([store.retry(id, 'a'), store.retry(id, 'a')]);
        expect((await stateOf(id)).a!.attempt).toBe(2);
    });

    it('keeps one logical launch under competing scheduler processes', async () => {
        const id = await frozen(parallelThenJoin());
        const processes = [store, createBatchStore({ sql, orgId: ORG }), createBatchStore({ sql, orgId: ORG })];
        await Promise.all(Array.from({ length: 12 }, (_, i) => processes[i % processes.length]!.reconcile(id)));
        expect(await jobCount()).toBe(2);
        expect(await decisions(id)).toEqual(['launch:a:1', 'launch:b:1']);
        expect((await sql`select * from batch_attempt where batch_id = ${id}`).length).toBe(2);
    });

    it('holds the limit of one under competing schedulers and repairs', async () => {
        const id = await frozen(plan([{ key: 'one', tasks: [task('a'), task('b'), task('c')] }], 1));
        await Promise.all(Array.from({ length: 9 }, () => store.reconcile(id)));
        expect(await jobCount()).toBe(1);
        const tasks = await stateOf(id);
        const live = Object.values(tasks).find((t) => t.execution === 'queued')!;
        await setStatus(live.rootJobId!, 'failed');
        await store.reconcile(id);
        // The failed one and its repair compete with the pending siblings for the single slot.
        await Promise.all([store.retry(id, live.key), store.reconcile(id), store.reconcile(id)]);
        const after = Object.values(await stateOf(id));
        expect(after.filter((t) => t.execution === 'queued' || t.execution === 'running')).toHaveLength(1);
    });

    it('survives a restart: a second store over the same rows launches nothing new', async () => {
        const id = await frozen(parallelThenJoin());
        await store.reconcile(id);
        const restarted = createBatchStore({ sql, orgId: ORG });
        await restarted.reconcileOpen();
        await restarted.reconcileOpen();
        expect(await jobCount()).toBe(2);
    });

    it('reconcileOpen dispatches a started batch whose start-time pass never ran', async () => {
        const id = await frozen(parallelThenJoin());
        await store.reconcileOpen();
        expect((await stateOf(id)).a!.execution).toBe('queued');
    });

    it('replays a duplicate acceptance and refuses one on a settled stage', async () => {
        const id = await frozen(
            plan([
                { key: 'one', tasks: [task('a')] },
                { key: 'two', tasks: [task('b')] },
            ])
        );
        await store.reconcile(id);
        const { a } = await stateOf(id);
        await setStatus(a!.rootJobId!, 'succeeded');
        expect(await store.accept(id, 'a', ALICE)).toEqual({ result: 'ok' });
        expect(await store.accept(id, 'a', ALICE)).toEqual({ result: 'ok' });
        expect(await decisions(id)).toEqual(['advance:one', 'launch:a:1', 'launch:b:1']);
        expect(await sql`select * from batch_acceptance where batch_id = ${id}`).toHaveLength(1);
        // After the stage advanced the task's outcome is history.
        const { b } = await stateOf(id);
        expect(b).toMatchObject({ execution: 'queued' });
        expect(await store.accept(id, 'a', ALICE)).toEqual({ result: 'ok' });
    });

    it('refuses to accept a PR-completion task, a missing task and a task of a settled stage', async () => {
        const id = await frozen(
            plan([
                { key: 'one', tasks: [task('a'), task('p', { completion: { kind: 'pr' } })] },
                { key: 'two', tasks: [task('b')] },
            ])
        );
        await store.reconcile(id);
        const { a, p } = await stateOf(id);
        await setStatus(p!.rootJobId!, 'succeeded');
        await setStatus(a!.rootJobId!, 'succeeded');
        expect(await store.accept(id, 'p', ALICE)).toEqual({ result: 'not_acceptable' });
        expect(await store.accept(id, 'nope', ALICE)).toEqual({ result: 'no_task' });
        expect(await store.accept(id, 'a', ALICE)).toEqual({ result: 'ok' });
        expect(await stateOf(id)).toMatchObject({ b: { execution: 'pending' } });
    });

    it('records who accepted, and two concurrent acceptances write one row', async () => {
        const id = await frozen(plan([{ key: 'one', tasks: [task('a')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        await setStatus(a!.rootJobId!, 'succeeded');
        await Promise.all([store.accept(id, 'a', ALICE), store.accept(id, 'a', ALICE)]);
        const rows = await sql`select kind, accepted_by, attempt from batch_acceptance where batch_id = ${id}`;
        expect(rows).toEqual([{ kind: 'accepted', accepted_by: ALICE, attempt: 1 }]);
    });

    it('refuses an acceptance that is not about a finished successful run, so a stale one cannot accept the next', async () => {
        const id = await frozen(plan([{ key: 'one', tasks: [task('a')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        // Still queued: nothing to accept yet.
        expect(await store.accept(id, 'a', ALICE)).toEqual({ result: 'not_ready' });

        await setStatus(a!.rootJobId!, 'succeeded');
        await store.reconcile(id);
        expect(await store.retry(id, 'a')).toEqual({ result: 'ok' });
        // A late acceptance of attempt 1 arrives while attempt 2 runs.
        expect(await store.accept(id, 'a', ALICE)).toEqual({ result: 'not_ready' });
        await setStatus(a!.rootJobId!, 'succeeded');
        await store.reconcile(id);
        const tasks = await stateOf(id);
        expect(tasks.a).toMatchObject({ execution: 'succeeded', gate: 'open' });
        expect((await store.get(id))!.completedAt).toBeNull();
    });

    it('lets an unaccepted succeeded task go back through retry', async () => {
        const id = await frozen(plan([{ key: 'one', tasks: [task('a')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        await setStatus(a!.rootJobId!, 'succeeded');
        await store.reconcile(id);
        expect(await store.retry(id, 'a')).toEqual({ result: 'ok' });
        expect(await stateOf(id)).toMatchObject({ a: { execution: 'queued', gate: 'open', attempt: 2 } });
    });
});

describe.skipIf(!enabled)('batch cancel', () => {
    it('fences scheduling: pending work is cancelled, moving work is stopped through the job store', async () => {
        const id = await frozen(parallelThenJoin(1));
        await store.reconcile(id);
        const before = await stateOf(id);
        const live = Object.values(before).find((t) => t.execution === 'queued')!;

        expect(await store.cancel(id, ALICE)).toEqual({ result: 'ok', replayed: false });
        const record = (await store.get(id))!;
        expect(record.cancelledAt).not.toBeNull();
        const tasks = Object.fromEntries(record.tasks.map((t) => [t.key, t]));
        expect(tasks[live.key]!.execution).toBe('stopped');
        expect((await headOf(live.rootJobId!)).status).toBe('stopped');
        for (const key of Object.keys(tasks).filter((k) => k !== live.key)) {
            expect(tasks[key]!.execution).toBe('cancelled');
        }
        const count = await jobCount();
        await store.reconcile(id);
        expect(await jobCount()).toBe(count);
    });

    it('is idempotent, and refuses a draft, a missing batch and later retries', async () => {
        const id = await frozen(parallelThenJoin());
        await store.reconcile(id);
        await store.cancel(id, ALICE);
        expect(await store.cancel(id, ALICE)).toEqual({ result: 'ok', replayed: true });
        expect(await store.retry(id, 'a')).toEqual({ result: 'cancelled' });

        const draft = (await store.create(parallelThenJoin(), ALICE)).id;
        expect(await store.cancel(draft, ALICE)).toEqual({ result: 'not_started' });
        expect(await store.cancel(ABSENT, ALICE)).toEqual({ result: 'missing' });
        expect(await decisions(id)).toContain('cancel');
    });

    it('never creates a root behind the fence when cancel races dispatch', async () => {
        for (let round = 0; round < 5; round += 1) {
            const id = await frozen(parallelThenJoin());
            await Promise.all([store.reconcile(id), store.cancel(id, ALICE), store.reconcile(id)]);
            await store.reconcile(id);
            const rows = await sql<{ id: string; status: string }[]>`
                select j.id, j.status from job j join batch_task t on t.root_job_id = j.root_job_id and t.batch_id = ${id}
            `;
            // Whatever launched before the fence was settled by it; nothing is left moving.
            expect(rows.every((row) => row.status === 'stopped')).toBe(true);
            const record = (await store.get(id))!;
            expect(record.tasks.every((t) => t.execution === 'stopped' || t.execution === 'cancelled')).toBe(true);
        }
    });

    it('refuses to cancel a finished batch', async () => {
        const id = await frozen(plan([{ key: 'only', tasks: [task('a')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        await setStatus(a!.rootJobId!, 'succeeded');
        await store.accept(id, 'a', ALICE);
        expect(await store.cancel(id, ALICE)).toEqual({ result: 'finished' });
    });
});

describe.skipIf(!enabled)('batch threads are batch history', () => {
    // Live or finished, a batch thread is history: remove and reopen both refuse. Each row's own
    // checks run between the succeeded verdict and the refusals (`before`) or after them (`after`).
    it.each<{ name: string; before: (id: string, root: string) => Promise<void>; after?: () => Promise<void> }>([
        {
            name: 'refuses to remove or reopen a thread that backs a batch task',
            before: async (_id, root) => {
                expect(await jobs.markDone(root, ALICE)).toBe('batch');
            },
            after: async () => {
                expect(await jobCount()).toBe(1);
            },
        },
        {
            name: 'still refuses to remove or reopen a finished batch’s thread',
            before: async (id, root) => {
                await store.accept(id, 'a', ALICE);
                expect(await doneAtOf(root)).not.toBeNull();
            },
        },
    ])('$name', async ({ before, after }) => {
        const id = await frozen(plan([{ key: 'only', tasks: [task('a')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        await setStatus(a!.rootJobId!, 'succeeded');
        await before(id, a!.rootJobId!);

        expect(await jobs.removeThread(a!.rootJobId!, ALICE)).toBe('batch');
        expect(await jobs.reopen(a!.rootJobId!)).toBe('batch');
        await after?.();
    });

    it('still removes an ordinary thread', async () => {
        const ref = await jobs.create('echo', ALICE, { repo: null, executor: null });
        if (typeof ref === 'string') throw new Error(ref);
        expect(await jobs.removeThread(ref.id, ALICE)).toMatchObject({ result: 'ok' });
    });
});

/** The done stamp of a thread's head: the run the task lists bucket by. */
const doneAtOf = async (root: string) =>
    (await sql<{ done_at: Date | null }[]>`select done_at from job where id = ${(await headOf(root)).id}`)[0]!.done_at;

const listed = async (state: 'review' | 'past') =>
    (await jobs.listTasks({ state, sort: 'newest', limit: 50 })).page.items.map((item) => item.id);

/** The head runs under a live lease, so a stop is only requested and the worker settles it later. */
const runUnderLease = async (root: string) => {
    const head = await headOf(root);
    await sql`
        update job set status = 'running', claimed_by = 'w1', started_at = now(), lease_token = ${randomUUID()},
            lease_expires_at = now() + interval '10 minutes'
        where id = ${head.id}
    `;
};

/** The worker honours a requested stop: the head parks `stopped`, as suspend does. */
const settleStopped = async (root: string) => {
    const head = await headOf(root);
    await sql`
        update job set status = 'stopped', finished_at = now(), lease_token = null, cancel_requested_at = null
        where id = ${head.id}
    `;
};

/** A store with no `close`: the board as it ran before batches closed their threads. */
const unclosingStore = () => createBatchStore({ sql, orgId: ORG, stop: (id, by) => jobs.stop(id, by) });

describe.skipIf(!enabled)('a finished batch closes its threads', () => {
    it('marks every thread done when the batch completes, so review drops them and past shows them', async () => {
        const id = await frozen(plan([{ key: 'only', tasks: [task('a'), task('b')] }]));
        await store.reconcile(id);
        const { a, b } = await stateOf(id);
        for (const root of [a!.rootJobId!, b!.rootJobId!]) await setStatus(root, 'succeeded');
        await store.accept(id, 'a', ALICE);
        expect(await doneAtOf(a!.rootJobId!)).toBeNull();
        await store.accept(id, 'b', ALICE);

        expect((await store.get(id))!.completedAt).not.toBeNull();
        for (const root of [a!.rootJobId!, b!.rootJobId!]) {
            expect(await doneAtOf(root)).not.toBeNull();
            expect(await listed('past')).toContain(root);
            expect(await listed('review')).not.toContain(root);
        }
    });

    it('closes a cancelled batch’s threads once their stopped heads settle', async () => {
        const id = await frozen(parallelThenJoin());
        await store.reconcile(id);
        const { a, b } = await stateOf(id);
        await setStatus(a!.rootJobId!, 'failed');
        await runUnderLease(b!.rootJobId!);

        await store.cancel(id, ALICE);
        expect(await doneAtOf(a!.rootJobId!)).not.toBeNull();
        // Still running under its lease: the stop is requested and the thread stays open until it lands.
        expect((await headOf(b!.rootJobId!)).status).toBe('running');
        expect(await doneAtOf(b!.rootJobId!)).toBeNull();

        await settleStopped(b!.rootJobId!);
        await store.reconcileOpen();
        expect(await doneAtOf(b!.rootJobId!)).not.toBeNull();
    });

    it('closes an expired batch’s threads', async () => {
        const { clock, store: timed } = clockedStore();
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a')] }], { timeLimitMinutes: 1 }), timed);
        await timed.reconcile(id);
        const { a } = await stateOf(id);
        await setStatus(a!.rootJobId!, 'succeeded');
        await timed.reconcile(id);
        expect(await doneAtOf(a!.rootJobId!)).toBeNull();

        clock.ms += 120_000;
        await timed.reconcile(id);
        expect(await doneAtOf(a!.rootJobId!)).not.toBeNull();
    });

    it('closes the threads of a batch that was already finished, on the boot reconcile', async () => {
        const before = unclosingStore();
        const id = await frozen(plan([{ key: 'only', tasks: [task('a')] }]), before);
        await before.reconcile(id);
        const { a } = await stateOf(id);
        await setStatus(a!.rootJobId!, 'succeeded');
        await before.accept(id, 'a', ALICE);
        expect((await store.get(id))!.completedAt).not.toBeNull();
        expect(await doneAtOf(a!.rootJobId!)).toBeNull();

        await store.reconcileOpen();
        expect(await doneAtOf(a!.rootJobId!)).not.toBeNull();
        // Once every thread is closed the batch says so, and later sweeps skip it.
        await store.reconcileOpen();
        const [batch] = await sql`select threads_closed_at from batch where id = ${id}`;
        expect(batch!.threads_closed_at).not.toBeNull();
    });

    it('takes a plain done on a finished batch’s thread, refuses it while the batch is live', async () => {
        const before = unclosingStore();
        const id = await frozen(plan([{ key: 'only', tasks: [task('a')] }]), before);
        await before.reconcile(id);
        const { a } = await stateOf(id);
        await setStatus(a!.rootJobId!, 'succeeded');
        expect(await jobs.markDone(a!.rootJobId!, ALICE)).toBe('batch');

        await before.accept(id, 'a', ALICE);
        expect(await jobs.markDone(a!.rootJobId!, ALICE)).toMatchObject({ status: 'succeeded' });
    });
});

describe.skipIf(!enabled)('force-closing a live batch’s thread', () => {
    const staged = () =>
        plan(
            [
                { key: 'one', tasks: [task('a'), task('o', { required: false })] },
                { key: 'two', tasks: [task('j')] },
            ],
            3
        );

    it('stops a required task, closes it, cancels it as that person’s and holds its stage', async () => {
        const id = await frozen(staged());
        await store.reconcile(id);
        const { a, o } = await stateOf(id);

        const closed = await store.closeTask(a!.rootJobId!, ALICE);
        expect(closed).toMatchObject({ batchId: id, task: 'a', pr: null, outcome: 'cancelled' });
        expect(closed!.doneAt).not.toBeNull();
        expect((await headOf(a!.rootJobId!)).status).toBe('stopped');
        expect(await doneAtOf(a!.rootJobId!)).not.toBeNull();

        let tasks = await stateOf(id);
        expect(tasks.a!.execution).toBe('cancelled');
        expect(tasks.a!.waitReason).toContain('cancel the batch');
        // Siblings keep running, and the batch itself is not cancelled.
        expect(tasks.o!.execution).toBe('queued');
        expect((await store.get(id))!.cancelledAt).toBeNull();

        await setStatus(o!.rootJobId!, 'succeeded');
        await store.accept(id, 'o', ALICE);
        tasks = await stateOf(id);
        expect(tasks.j!.execution).toBe('pending');
        expect(await decisions(id)).not.toContain('advance:one');

        // Never retried or repaired: no pass and no person's retry launches it again.
        expect(await store.retry(id, 'a')).toEqual({ result: 'not_retryable' });
        await store.reconcile(id);
        expect(await kindsOf('a', id)).toEqual(['launch']);

        const report = (await store.report(id))!;
        expect(report.tasks.find((t) => t.key === 'a')).toMatchObject({
            execution: 'cancelled',
            closedBy: ALICE,
            next: { action: 'cancel', path: `/api/batches/${id}/cancel` },
        });
        expect(report.tasks.find((t) => t.key === 'a')!.closedAt).not.toBeNull();
        expect(report.tasks.find((t) => t.key === 'o')).toMatchObject({ closedAt: null, closedBy: null });
    });

    it('lets an optional task’s stage go on without it', async () => {
        const id = await frozen(staged());
        await store.reconcile(id);
        const { a, o } = await stateOf(id);
        await setStatus(o!.rootJobId!, 'failed');
        await store.reconcile(id);

        const closed = await store.closeTask(o!.rootJobId!, ALICE);
        expect(closed!.doneAt).not.toBeNull();
        expect((await stateOf(id)).o).toMatchObject({ execution: 'cancelled', waitReason: null });

        await setStatus(a!.rootJobId!, 'succeeded');
        await store.accept(id, 'a', ALICE);
        expect((await stateOf(id)).j!.execution).toBe('queued');
        expect(await kindsOf('o', id)).toEqual(['launch']);
    });

    it('answers before a run under a live lease settles, and closes the thread once it does', async () => {
        const id = await frozen(staged());
        await store.reconcile(id);
        const { a } = await stateOf(id);
        await runUnderLease(a!.rootJobId!);

        const closed = await store.closeTask(a!.rootJobId!, ALICE);
        expect(closed).toMatchObject({ task: 'a', doneAt: null, outcome: 'cancelled' });
        // Still moving: it keeps its slot until the stop lands.
        expect((await stateOf(id)).a!.execution).toBe('running');
        const [head] = await sql`select cancel_requested_at from job where id = ${(await headOf(a!.rootJobId!)).id}`;
        expect(head!.cancel_requested_at).not.toBeNull();

        await settleStopped(a!.rootJobId!);
        await store.reconcileOpen();
        expect(await doneAtOf(a!.rootJobId!)).not.toBeNull();
        expect((await stateOf(id)).a!.execution).toBe('cancelled');
        expect(await kindsOf('a', id)).toEqual(['launch']);
    });

    it('keeps a force-closed task’s slot until its run settles, so a sibling waits under concurrency 1', async () => {
        const id = await frozen(plan([{ key: 'one', tasks: [task('a'), task('b', { required: false })] }], 1));
        await store.reconcile(id);
        const first = Object.values(await stateOf(id)).find((t) => t.execution === 'queued')!;
        const second = first.key === 'a' ? 'b' : 'a';
        await runUnderLease(first.rootJobId!);

        await store.closeTask(first.rootJobId!, ALICE);
        await store.reconcile(id);
        expect((await stateOf(id))[second]!.execution).toBe('pending');
        expect(await jobCount()).toBe(1);
        expect((await store.report(id))!.state).toBe('running');

        await settleStopped(first.rootJobId!);
        await store.reconcileOpen();
        expect((await stateOf(id))[second]!.execution).toBe('queued');
    });

    it('closes an accepted task’s thread and leaves its outcome alone', async () => {
        const id = await frozen(staged());
        await store.reconcile(id);
        const { a } = await stateOf(id);
        await setStatus(a!.rootJobId!, 'succeeded');
        await store.accept(id, 'a', ALICE);

        const closed = await store.closeTask(a!.rootJobId!, ALICE);
        expect(closed).toMatchObject({ outcome: 'kept' });
        expect(closed!.doneAt).not.toBeNull();
        expect((await stateOf(id)).a).toMatchObject({ execution: 'succeeded', gate: 'passed', waitReason: null });
    });

    it('keeps the outcome of a task whose batch ended before the force landed', async () => {
        const before = unclosingStore();
        const id = await frozen(plan([{ key: 'only', tasks: [task('a')] }]), before);
        await before.reconcile(id);
        const { a } = await stateOf(id);
        await setStatus(a!.rootJobId!, 'failed');
        await before.cancel(id, ALICE);

        const closed = await store.closeTask(a!.rootJobId!, ALICE);
        expect(closed).toMatchObject({ outcome: 'kept' });
        expect(closed!.doneAt).not.toBeNull();
        expect((await stateOf(id)).a!.execution).toBe('failed');
    });

    it('is wired to the job store’s Done on the board’s own org runtime', async () => {
        const config = testConfig();
        const registry = createOrgRegistry({
            sql,
            ready: Promise.resolve(),
            config,
            withStores: true,
            secrets: testSecretStore(sql),
            secretLog: () => {},
        });
        const runtime = (await registry.for(ORG))!;
        const board = runtime.batches!;
        const id = await frozen(plan([{ key: 'only', tasks: [task('a')] }]), board);
        await board.reconcile(id);
        const { a } = await stateOf(id);
        await setStatus(a!.rootJobId!, 'succeeded');
        await board.accept(id, 'a', ALICE);
        expect(await doneAtOf(a!.rootJobId!)).not.toBeNull();
    });

    it('names the task’s open PR and leaves it open', async () => {
        const id = await frozen(plan([{ key: 'one', tasks: [prTask('a')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        await setStatus(a!.rootJobId!, 'succeeded');
        const number = await publish(a!.rootJobId!);
        await store.reconcile(id);

        const closed = await store.closeTask(a!.rootJobId!, ALICE);
        expect(closed).toMatchObject({ task: 'a', pr: prUrlOf(REPO, number) });
        expect((await stateOf(id)).a!.execution).toBe('cancelled');
    });

    it('answers null for a thread no batch task backs', async () => {
        const ref = await jobs.create('echo', ALICE, { repo: null, executor: null });
        if (typeof ref === 'string') throw new Error(ref);
        expect(await store.closeTask(ref.id, ALICE)).toBeNull();
    });
});

const REPO = 'acme/web';
let nextPr = 1000;

const prTask = (key: string) => task(key, { completion: { kind: 'pr' } });
const prUrlOf = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;

/** Records the PR a task's thread published, as the verdict's publication does. */
async function publish(root: string, base = 'main', repo = REPO): Promise<number> {
    nextPr += 1;
    await recordPr(prs, root, nextPr, { repo, base });
    return nextPr;
}

const merge = (repo: string, number: number) => jobs.closeMergedPr(repo, number, randomUUID());

/** A two-stage batch whose first task has run and succeeded. */
async function succeededFirst() {
    const id = await frozen(
        plan([
            { key: 'one', tasks: [prTask('a')] },
            { key: 'two', tasks: [prTask('b')] },
        ])
    );
    await store.reconcile(id);
    const { a } = await stateOf(id);
    await setStatus(a!.rootJobId!, 'succeeded');
    return { id, root: a!.rootJobId! };
}

describe.skipIf(!enabled)('human PR gate', () => {
    // The gate stays open: no PR, the wrong PR, the wrong branch, or a stale merge is no evidence.
    it.each<{
        name: string;
        /** Publishes/merges what the case needs; answers the published PR number, if any. */
        arrange: (root: string) => Promise<number | undefined>;
        waitReason?: (number: number | undefined) => string;
        noAdvance: boolean;
        extra?: (id: string) => Promise<void>;
    }>([
        {
            name: 'does not accept a succeeded run that opened no PR',
            arrange: async () => undefined,
            waitReason: () => 'the run succeeded without opening a PR',
            noAdvance: true,
            extra: async (id) => {
                expect(await stateOf(id)).toMatchObject({
                    a: { execution: 'succeeded' },
                    b: { execution: 'pending' },
                });
            },
        },
        {
            name: 'does not take another repository or another PR number as evidence',
            arrange: async (root) => {
                const number = await publish(root);
                await merge('acme/other', number);
                await merge(REPO, number + 1);
                return number;
            },
            noAdvance: false,
        },
        {
            name: 'refuses a merged PR that targets another branch, with a reason',
            arrange: async (root) => {
                const number = await publish(root, 'release');
                await merge(REPO, number);
                return number;
            },
            waitReason: (number) => `PR ${prUrlOf(REPO, number!)} targets release, not main`,
            noAdvance: true,
        },
        {
            name: 'treats a merge older than the current attempt as stale',
            arrange: async (root) => {
                const number = await publish(root);
                await merge(REPO, number);
                await sql`update pr_merge set merged_at = now() - interval '1 hour' where repo = ${REPO} and pr_number = ${number}`;
                return number;
            },
            waitReason: (number) => `PR ${prUrlOf(REPO, number!)} was merged before attempt 1 started`,
            noAdvance: false,
        },
    ])('$name', async ({ arrange, waitReason, noAdvance, extra }) => {
        const { id, root } = await succeededFirst();
        const number = await arrange(root);
        await store.reconcile(id);

        expect((await stateOf(id)).a).toMatchObject({
            gate: 'open',
            ...(waitReason === undefined ? {} : { waitReason: waitReason(number) }),
        });
        if (noAdvance) expect(await decisions(id)).not.toContain('advance:one');
        await extra?.(id);
    });

    it('waits for a person to merge an open PR, and starts the next stage after the merge without a click', async () => {
        const { id, root } = await succeededFirst();
        const number = await publish(root);
        await store.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({
            gate: 'open',
            pr: prUrlOf(REPO, number),
            waitReason: `waiting for a person to merge ${prUrlOf(REPO, number)}`,
        });

        await merge(REPO, number);
        await store.reconcile(id);
        const tasks = await stateOf(id);
        expect(tasks.a).toMatchObject({ gate: 'passed', waitReason: null, pr: prUrlOf(REPO, number) });
        expect(tasks.b).toMatchObject({ execution: 'queued', attempt: 1 });
        expect(
            await sql`select kind, repo, pr_number, accepted_by from batch_acceptance where batch_id = ${id}`
        ).toEqual([{ kind: 'pr_merged', repo: REPO, pr_number: number, accepted_by: null }]);
        const [thread] = await sql`select done_at from job where id = ${root}`;
        expect(thread!.done_at).toBeNull();
    });

    it('holds a merge that arrives before the run finished until the run succeeds', async () => {
        const id = await frozen(plan([{ key: 'one', tasks: [prTask('a')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        const number = await publish(a!.rootJobId!);
        await setStatus(a!.rootJobId!, 'running');
        await merge(REPO, number);
        await store.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({ execution: 'running', gate: 'open' });

        await setStatus(a!.rootJobId!, 'succeeded');
        await store.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({ execution: 'succeeded', gate: 'passed' });
        expect((await store.get(id))!.completedAt).not.toBeNull();
    });

    it('advances once under duplicate deliveries, racing schedulers and a restart', async () => {
        const { id, root } = await succeededFirst();
        const number = await publish(root);
        const processes = [store, createBatchStore({ sql, orgId: ORG }), createBatchStore({ sql, orgId: ORG })];
        await Promise.all([
            merge(REPO, number),
            merge(REPO, number),
            ...processes.map((process) => process.reconcile(id)),
            ...processes.map((process) => process.reconcile(id)),
        ]);
        await createBatchStore({ sql, orgId: ORG }).reconcileOpen();
        expect(await decisions(id)).toEqual(['advance:one', 'launch:a:1', 'launch:b:1']);
        expect(await sql`select 1 from batch_acceptance where batch_id = ${id}`).toHaveLength(1);
    });

    it('lets a restarted store pick up a merge it never saw', async () => {
        const { id, root } = await succeededFirst();
        const number = await publish(root);
        await merge(REPO, number);
        await createBatchStore({ sql, orgId: ORG }).reconcileOpen();
        expect((await stateOf(id)).a).toMatchObject({ gate: 'passed' });
    });

    it('ignores a merge after the batch was cancelled', async () => {
        const { id, root } = await succeededFirst();
        const number = await publish(root);
        await store.cancel(id, ALICE);
        await merge(REPO, number);
        await store.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({ gate: 'open' });
        expect(await decisions(id)).not.toContain('advance:one');
    });
});

/** A store whose clock the test moves: the deadline and the retry backoff are read against it. */
function clockedStore() {
    const clock = { ms: Date.now() };
    return {
        clock,
        store: createBatchStore({
            sql,
            orgId: ORG,
            stop: (id, by) => jobs.stop(id, by),
            close: (id, by) => jobs.markDone(id, by),
            now: () => new Date(clock.ms),
        }),
    };
}

const planWith = (stages: Record<string, unknown>[], budgets: Record<string, number> = {}): BatchPlan =>
    batchPlan('Recovery', stages, budgets);

/** Ends the thread head's run as failed with a structured reason and its cause, as the verdict does. */
async function failWith(
    root: string,
    failureKind: string | null,
    status: 'failed' | 'dead' = 'failed',
    failureCause: string | null = null
) {
    const head = await headOf(root);
    await startRow(sql, head.id);
    await sql`
        update job set status = ${status}, failure_kind = ${failureKind}, failure_cause = ${failureCause},
            finished_at = now(), lease_token = null
        where id = ${head.id}
    `;
}

const kindsOf = async (taskKey: string, batchId: string) =>
    (
        await sql<{ kind: string }[]>`
            select kind from batch_attempt where batch_id = ${batchId} and task_key = ${taskKey} order by attempt
        `
    ).map((r) => r.kind);

describe.skipIf(!enabled)('bounded recovery', () => {
    it('retries an infrastructure failure after its backoff and unlocks the next stage exactly once', async () => {
        const { clock, store: timed } = clockedStore();
        const id = await frozen(
            planWith([
                { key: 'one', tasks: [task('a')] },
                { key: 'two', tasks: [task('b')] },
            ]),
            timed
        );
        await timed.reconcile(id);
        const { a } = await stateOf(id);
        await failWith(a!.rootJobId!, 'timeout');

        await timed.reconcile(id);
        // In backoff: queued for a retry, no wait reason (it is moving, not parked), no job yet.
        expect((await stateOf(id)).a).toMatchObject({ execution: 'retry', waitReason: null, attempt: 1 });
        expect(await jobCount()).toBe(1);
        expect(await timed.reconcile(id)).toMatchObject({ waiting: 1, active: 0 });

        clock.ms += 61_000;
        await timed.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({ execution: 'queued', attempt: 2, rootJobId: a!.rootJobId });
        expect(await kindsOf('a', id)).toEqual(['launch', 'infra_retry']);

        await setStatus(a!.rootJobId!, 'succeeded');
        await timed.accept(id, 'a', ALICE);
        await timed.reconcile(id);
        await timed.reconcile(id);
        expect((await stateOf(id)).b).toMatchObject({ execution: 'queued' });
        expect((await decisions(id)).filter((key) => key === 'advance:one')).toHaveLength(1);
    });

    it('keeps an org task’s executor scope on its infra retry and its repair', async () => {
        const scopeOfHead = async (root: string) =>
            (
                await sql<{ executor_scope: string }[]>`
                    select executor_scope from job where root_job_id = ${root} order by created_at desc, id desc limit 1
                `
            )[0]!.executor_scope;
        const { clock, store: timed } = clockedStore();
        const id = await frozen(
            planWith([{ key: 'one', tasks: [task('a', { completion: { kind: 'pr' }, executorScope: 'org' })] }]),
            timed
        );
        await timed.reconcile(id);
        const root = (await stateOf(id)).a!.rootJobId!;

        await failWith(root, 'timeout');
        await timed.reconcile(id);
        clock.ms += 61_000;
        await timed.reconcile(id);
        expect(await kindsOf('a', id)).toEqual(['launch', 'infra_retry']);
        expect(await scopeOfHead(root)).toBe('org');

        await failWith(root, 'gate', 'failed', 'verification');
        await timed.reconcile(id);
        expect(await kindsOf('a', id)).toEqual(['launch', 'infra_retry', 'repair']);
        expect(await scopeOfHead(root)).toBe('org');
    });

    it('repairs a failed check with a follow-up in the same thread, then judges the repaired run afresh', async () => {
        const id = await frozen(planWith([{ key: 'one', tasks: [prTask('a')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        const root = a!.rootJobId!;
        const failedHead = await headOf(root);
        await failWith(root, 'gate', 'failed', 'verification');

        await store.reconcile(id);
        const [repair] = await sql<{ parent_job_id: string; root_job_id: string; command: string }[]>`
            select parent_job_id, root_job_id, command from job
            where root_job_id = ${root} order by created_at desc, id desc limit 1
        `;
        expect(repair).toMatchObject({ parent_job_id: failedHead.id, root_job_id: root });
        expect(repair!.command).toContain('failed its checks');
        expect(repair!.command).toContain('run it again now');
        expect(await kindsOf('a', id)).toEqual(['launch', 'repair']);
        expect((await stateOf(id)).a).toMatchObject({ execution: 'queued', gate: 'open', attention: null });

        await setStatus(root, 'succeeded');
        const number = await publish(root);
        await store.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({ execution: 'succeeded', gate: 'open' });
        await merge(REPO, number);
        await store.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({ gate: 'passed' });
    });

    // A repair is a follow-up, and a follow-up refuses a thread with unfinished work in it (#698):
    // the repair is never queued behind it, and the task goes to a person instead.
    it('never dispatches a repair onto a busy thread', async () => {
        const id = await frozen(planWith([{ key: 'one', tasks: [prTask('a')] }]));
        await store.reconcile(id);
        const root = (await stateOf(id)).a!.rootJobId!;
        await failWith(root, 'gate', 'failed', 'verification');
        // An older member still queued under the failed head — no write path reaches it today.
        await sql`
            insert into job (org_id, command, created_by, repo, root_job_id, created_at)
            select org_id, 'busy', created_by, repo, root_job_id, created_at - interval '1 minute'
            from job where id = ${root}
        `;
        const before = await jobCount();

        await store.reconcile(id);

        expect(await jobCount()).toBe(before);
        expect(await kindsOf('a', id)).toEqual(['launch']);
        expect((await stateOf(id)).a).toMatchObject({ execution: 'failed', attention: 'refused' });
    });

    it('repairs a failed gate with its name, exit code and output tail in the follow-up (#687)', async () => {
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a')] }]));
        await store.reconcile(id);
        const root = (await stateOf(id)).a!.rootJobId!;
        const failedHead = await headOf(root);
        const gates = [
            { name: 'lint', status: 'passed', exitCode: 0, output: 'lint clean' },
            { name: 'test', status: 'failed', exitCode: 1, output: 'FAIL x.test.ts: expected 2, got 3' },
        ];
        await sql`update job set gates = ${sql.json(gates)} where id = ${failedHead.id}`;
        await failWith(root, 'gate', 'failed', 'verification');

        await store.reconcile(id);
        const head = await headOf(root);
        const [row] = await sql<{ command: string }[]>`select command from job where id = ${head.id}`;
        expect(head.id).not.toBe(failedHead.id);
        expect(row!.command).toContain('Gates that failed:\n- test: exit 1');
        expect(row!.command).toContain('expected 2, got 3');
        expect(row!.command).not.toContain('- lint:');
        expect(row!.command).not.toContain('lint clean');
    });

    it('sends a stale-branch publish failure to the agent as a rebase request', async () => {
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        await failWith(a!.rootJobId!, 'publish', 'failed', 'conflict');
        await store.reconcile(id);
        const head = await headOf(a!.rootJobId!);
        const [row] = await sql<{ command: string }[]>`select command from job where id = ${head.id}`;
        expect(row!.command).toContain('stale or conflicts');
    });

    it('needs attention once the budget is spent, while an independent sibling keeps running', async () => {
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a'), task('b')] }], { repairs: 1 }));
        await store.reconcile(id);
        let tasks = await stateOf(id);
        await failWith(tasks.a!.rootJobId!, 'gate', 'failed', 'verification');
        await store.reconcile(id);
        expect(await kindsOf('a', id)).toEqual(['launch', 'repair']);
        await failWith(tasks.a!.rootJobId!, 'gate', 'failed', 'verification');
        await store.reconcile(id);
        tasks = await stateOf(id);
        expect(tasks.a).toMatchObject({ execution: 'failed', attention: 'budget' });
        expect(tasks.a!.waitReason).toContain('recovery budget exhausted');
        expect(await kindsOf('a', id)).toEqual(['launch', 'repair']);
        expect(tasks.b).toMatchObject({ execution: 'queued', attention: null });
    });

    it('asks a person immediately when the budget is zero', async () => {
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a')] }], { infraRetries: 0 }));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        await failWith(a!.rootJobId!, null, 'dead');
        await store.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({ execution: 'failed', attention: 'budget' });
        expect(await kindsOf('a', id)).toEqual(['launch']);
    });

    it('classifies a configuration failure as needing attention and never retries it', async () => {
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        await failWith(a!.rootJobId!, 'config');
        await store.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({ execution: 'failed', attention: 'configuration' });
        expect(await kindsOf('a', id)).toEqual(['launch']);
        // A person's retry is the supported path, and it clears the attention.
        expect(await store.retry(id, 'a')).toEqual({ result: 'ok' });
        expect((await stateOf(id)).a).toMatchObject({ execution: 'queued', attention: null });
        expect(await kindsOf('a', id)).toEqual(['launch', 'retry']);
    });

    it('surfaces an unanswered question, clears it once answered, and never retries an expired one', async () => {
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a'), task('b')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        const root = a!.rootJobId!;
        await setStatus(root, 'running');
        const head = await headOf(root);
        const lease = randomUUID();
        await sql`update job set lease_token = ${lease}, attempts = 1, claim_seq = 1 where id = ${head.id}`;
        await sql`
            insert into job_question (org_id, job_id, question_id, attempt, claim_seq, lease_token, questions, state)
            values (${ORG}, ${head.id}, 'q1', 1, 1, ${lease}, ${sql.json([{ question: 'which db?' }])}, 'pending')
        `;
        await store.reconcile(id);
        let tasks = await stateOf(id);
        expect(tasks.a).toMatchObject({ execution: 'running', attention: 'question' });
        expect(tasks.a!.waitReason).toContain('question q1');
        expect(tasks.b).toMatchObject({ execution: 'queued' });
        // The answer route addresses the job that asked, which here is the thread's head.
        expect((await store.report(id))!.tasks.find((t) => t.key === 'a')!.next).toEqual({
            action: 'answer',
            method: 'POST',
            path: `/api/jobs/${head.id}/questions/q1/answer`,
        });

        await sql`update job_question set state = 'answered', answered_at = now() where job_id = ${head.id}`;
        await store.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({ attention: null, waitReason: null });

        await sql`update job_question set state = 'expired' where job_id = ${head.id}`;
        await failWith(root, 'timeout');
        await store.reconcile(id);
        tasks = await stateOf(id);
        expect(tasks.a).toMatchObject({ execution: 'failed', attention: 'question' });
        expect(await kindsOf('a', id)).toEqual(['launch']);
    });

    it('does not mistake a question closed by a reclaim for an open one, and clears attention when the run ends', async () => {
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        const root = a!.rootJobId!;
        await setStatus(root, 'running');
        const head = await headOf(root);
        const lease = randomUUID();
        await sql`update job set lease_token = ${lease}, attempts = 1, claim_seq = 1 where id = ${head.id}`;
        await sql`
            insert into job_question (org_id, job_id, question_id, attempt, claim_seq, lease_token, questions, state)
            values (${ORG}, ${head.id}, 'q1', 1, 1, ${lease}, ${sql.json([{ question: 'which db?' }])}, 'pending')
        `;
        await store.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({ attention: 'question' });
        // The run ends before the next pass: nothing may carry the question's attention forward.
        await setStatus(root, 'succeeded');
        await store.reconcile(id);
        expect((await stateOf(id)).a!.attention).toBeNull();

        // A reclaimed attempt holds a new lease under the next claim, in the same attempt when the
        // claim recovered a lost one: the old question is closed, so a gate failure is repaired.
        const reclaimed = await frozen(planWith([{ key: 'one', tasks: [task('a')] }]));
        await store.reconcile(reclaimed);
        const second = (await stateOf(reclaimed)).a!.rootJobId!;
        const asker = await headOf(second);
        await sql`update job set lease_token = ${randomUUID()}, attempts = 1, claim_seq = 2 where id = ${asker.id}`;
        await sql`
            insert into job_question (org_id, job_id, question_id, attempt, claim_seq, lease_token, questions, state)
            values (${ORG}, ${asker.id}, 'q1', 1, 1, ${randomUUID()}, ${sql.json([{ question: 'old?' }])}, 'pending')
        `;
        await failWith(second, 'gate', 'failed', 'verification');
        await store.reconcile(reclaimed);
        expect(await kindsOf('a', reclaimed)).toEqual(['launch', 'repair']);
    });

    it('repairs the takeover of an expired lease whose lost claim left its question unanswered', async () => {
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a')] }]));
        await store.reconcile(id);
        const root = (await stateOf(id)).a!.rootJobId!;
        const lost = (await jobs.claim('w1', 300)) as Claim;
        expect(lost.id).toBe(root);
        const ask = {
            questionId: 'q1',
            questions: [{ question: 'which db?', header: 'DB', multiSelect: false, options: [] }],
        };
        expect(await jobs.askQuestion(root, lost.leaseToken, ask)).toMatchObject({ result: 'created' });

        await expireLease(sql, root);
        const takeover = (await jobs.claim('w2', 300)) as Claim;
        expect(takeover).toMatchObject({ id: root, attempts: lost.attempts });
        await failWith(root, 'gate', 'failed', 'verification');
        await store.reconcile(id);

        const a = (await stateOf(id)).a!;
        expect({ kinds: await kindsOf('a', id), attention: a.attention }).toEqual({
            kinds: ['launch', 'repair'],
            attention: null,
        });
    });

    it('cannot reset a budget or repeat a repair across a restart', async () => {
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a')] }], { repairs: 1 }));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        await failWith(a!.rootJobId!, 'gate', 'failed', 'verification');
        const restarted = [createBatchStore({ sql, orgId: ORG }), createBatchStore({ sql, orgId: ORG })];
        await Promise.all([store, ...restarted].map((process) => process.reconcile(id)));
        await Promise.all(restarted.map((process) => process.reconcileOpen()));
        expect(await kindsOf('a', id)).toEqual(['launch', 'repair']);
        expect(await decisions(id)).toEqual(['launch:a:1', 'launch:a:2']);
        const jobsBefore = await jobCount();

        await failWith(a!.rootJobId!, 'gate', 'failed', 'verification');
        await restarted[0]!.reconcile(id);
        await restarted[1]!.reconcile(id);
        expect(await jobCount()).toBe(jobsBefore);
        expect((await stateOf(id)).a).toMatchObject({ execution: 'failed', attention: 'budget' });
    });

    // Issue #581: gate, publish and helper are coarse labels; the cause under them decides.
    it('sends a refused publish to a person without spending a repair', async () => {
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        const jobsBefore = await jobCount();
        await failWith(a!.rootJobId!, 'publish', 'failed', 'denied');
        await store.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({ execution: 'failed', attention: 'configuration' });
        expect(await kindsOf('a', id)).toEqual(['launch']);
        expect(await jobCount()).toBe(jobsBefore);
    });

    it('retries a publish lost to transport as infrastructure, after its backoff', async () => {
        const { clock, store: timed } = clockedStore();
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a')] }]), timed);
        await timed.reconcile(id);
        const { a } = await stateOf(id);
        await failWith(a!.rootJobId!, 'publish', 'failed', 'transport');
        await timed.reconcile(id);
        const [row] = await sql<{ recovery: string; not_before: Date | null }[]>`
            select recovery, not_before from batch_task where batch_id = ${id} and key = 'a'
        `;
        expect(row).toMatchObject({ recovery: 'infra_retry' });
        expect(row!.not_before!.getTime()).toBe(clock.ms + 60_000);
        clock.ms += 61_000;
        await timed.reconcile(id);
        expect(await kindsOf('a', id)).toEqual(['launch', 'infra_retry']);
    });

    it.each([
        ['publish', 'conflict', 'stale or conflicts'],
        ['gate', 'verification', 'failed its checks'],
    ])('repairs a %s failure caused by %s with a follow-up on the same root', async (kind, cause, wording) => {
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        const root = a!.rootJobId!;
        const failedHead = await headOf(root);
        await failWith(root, kind, 'failed', cause);
        await store.reconcile(id);
        const head = await headOf(root);
        const [row] = await sql<{ command: string; parent_job_id: string; root_job_id: string }[]>`
            select command, parent_job_id, root_job_id from job where id = ${head.id}
        `;
        expect(row).toMatchObject({ parent_job_id: failedHead.id, root_job_id: root });
        expect(row!.command).toContain(wording);
        expect(await kindsOf('a', id)).toEqual(['launch', 'repair']);
    });

    it('names the kind of a helper failure it cannot classify, and spends nothing on it', async () => {
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        await failWith(a!.rootJobId!, 'helper', 'failed', 'unknown');
        await store.reconcile(id);
        const { a: after } = await stateOf(id);
        expect(after).toMatchObject({ execution: 'failed', attention: 'unclassified' });
        expect(after!.waitReason).toContain('helper');
        expect(await kindsOf('a', id)).toEqual(['launch']);
    });

    it('lets cancellation win over a retry waiting out its backoff', async () => {
        const { clock, store: timed } = clockedStore();
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a'), task('b')] }]), timed);
        await timed.reconcile(id);
        const tasks = await stateOf(id);
        await failWith(tasks.a!.rootJobId!, 'timeout');
        await timed.reconcile(id);
        expect((await stateOf(id)).a!.execution).toBe('retry');
        const jobsBefore = await jobCount();

        await timed.cancel(id, ALICE);
        clock.ms += 3_600_000;
        await timed.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({ execution: 'cancelled' });
        expect(await jobCount()).toBe(jobsBefore);
        expect(await kindsOf('a', id)).toEqual(['launch']);
    });
});

describe.skipIf(!enabled)('the time limit', () => {
    const limited = () =>
        planWith(
            [
                { key: 'one', tasks: [prTask('a'), task('s')] },
                { key: 'two', tasks: [task('b')] },
            ],
            { timeLimitMinutes: 1 }
        );

    it('freezes the budgets and the deadline at start', async () => {
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a')] }], { infraRetries: 3, repairs: 4 }));
        const record = (await store.get(id))!;
        expect(record.plan).toMatchObject({ infraRetries: 3, repairs: 4, timeLimitMinutes: 720 });
        expect(Date.parse(record.deadlineAt!) - Date.parse(record.startedAt!)).toBe(720 * 60_000);
        for (const change of [
            () => sql`update batch set infra_retries = 0 where id = ${id}`,
            () => sql`update batch set repairs = 0 where id = ${id}`,
            () => sql`update batch set time_limit_minutes = 1000 where id = ${id}`,
            () => sql`update batch set deadline_at = now() where id = ${id}`,
        ]) {
            await expect(change()).rejects.toMatchObject({ code: '23514' });
        }
    });

    it('stops dispatch and recovery at the limit, cancels unrun work and still records a merge that landed', async () => {
        const { clock, store: timed } = clockedStore();
        const id = await frozen(limited(), timed);
        await timed.reconcile(id);
        let tasks = await stateOf(id);
        await setStatus(tasks.a!.rootJobId!, 'succeeded');
        const number = await publish(tasks.a!.rootJobId!);
        await failWith(tasks.s!.rootJobId!, 'timeout');
        await timed.reconcile(id);
        expect((await stateOf(id)).s!.execution).toBe('retry');

        clock.ms += 120_000;
        expect(await timed.reconcile(id)).toMatchObject({ expired: true, active: 0 });
        tasks = await stateOf(id);
        expect(tasks.s).toMatchObject({ execution: 'cancelled' });
        expect(tasks.s!.waitReason).toContain('time limit');
        expect(tasks.b).toMatchObject({ execution: 'cancelled' });
        expect(await decisions(id)).toContain('expire');
        expect((await timed.get(id))!.expiredAt).not.toBeNull();

        await merge(REPO, number);
        await timed.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({ gate: 'passed' });
        expect(await decisions(id)).not.toContain('advance:one');
        expect(await kindsOf('b', id)).toEqual([]);
        expect(await timed.retry(id, 's')).toEqual({ result: 'expired' });
        // Expiring is a decision made once.
        await timed.reconcile(id);
        expect((await decisions(id)).filter((key) => key === 'expire')).toHaveLength(1);
        expect((await timed.report(id))!).toMatchObject({
            state: 'expired',
            prs: { merged: [{ task: 'a', url: prUrlOf(REPO, number) }] },
        });
    });

    it('stops work that is still moving when the limit passes', async () => {
        const { clock, store: timed } = clockedStore();
        const id = await frozen(limited(), timed);
        await timed.reconcile(id);
        const { s } = await stateOf(id);
        await setStatus(s!.rootJobId!, 'running');
        clock.ms += 120_000;
        await timed.reconcile(id);
        expect((await headOf(s!.rootJobId!)).status).toBe('stopped');
        expect((await stateOf(id)).s!.execution).toBe('stopped');
    });
});

describe.skipIf(!enabled)('the morning report', () => {
    it('lists merged and open PRs, recovery spent, usage, exact waiting reasons and the next supported step', async () => {
        const id = await frozen(
            // Three slots: the report reads all three first-stage tasks as having run.
            planWith(
                [
                    { key: 'one', tasks: [prTask('a'), prTask('b'), task('c')] },
                    { key: 'two', tasks: [task('d')] },
                ],
                { concurrency: 3 }
            )
        );
        await store.reconcile(id);
        const tasks = await stateOf(id);
        await sql`update job set wall_clock_ms = 5000, agent_turns = 7 where root_job_id = ${tasks.a!.rootJobId!}`;
        await setStatus(tasks.a!.rootJobId!, 'succeeded');
        const merged = await publish(tasks.a!.rootJobId!);
        await setStatus(tasks.b!.rootJobId!, 'succeeded');
        const open = await publish(tasks.b!.rootJobId!);
        await failWith(tasks.c!.rootJobId!, 'config');
        await merge(REPO, merged);
        await store.reconcile(id);

        const report = (await store.report(id))!;
        expect(report).toMatchObject({
            state: 'parked',
            budgets: { infraRetries: 2, repairs: 2, timeLimitMinutes: 720 },
            prs: {
                merged: [{ task: 'a', url: prUrlOf(REPO, merged) }],
                open: [{ task: 'b', url: prUrlOf(REPO, open) }],
            },
            totals: { accepted: 1, failed: 1, needsAttention: 2, wallClockMs: 5000, agentTurns: 7 },
        });
        const byKey = Object.fromEntries(report.tasks.map((t) => [t.key, t]));
        expect(byKey.a).toMatchObject({
            gate: 'passed',
            job: `/api/jobs/${tasks.a!.rootJobId}`,
            next: { action: 'none' },
        });
        expect(byKey.b).toMatchObject({
            waitReason: `waiting for a person to merge ${prUrlOf(REPO, open)}`,
            next: { action: 'merge', url: prUrlOf(REPO, open) },
        });
        expect(byKey.c).toMatchObject({
            attention: 'configuration',
            next: { action: 'retry', method: 'POST', path: `/api/batches/${id}/tasks/c/retry` },
        });
        expect(byKey.d).toMatchObject({ execution: 'pending', next: { action: 'wait' } });
        expect(await store.report(ABSENT)).toBeNull();
    });

    it('states remaining budgets, manual retries apart from automatic ones, observation freshness and unmeasured usage', async () => {
        const { clock, store: timed } = clockedStore();
        const id = await frozen(planWith([{ key: 'one', tasks: [task('a'), prTask('b')] }]), timed);
        await timed.reconcile(id);
        const { a, b } = await stateOf(id);
        await failWith(a!.rootJobId!, 'timeout');
        await timed.reconcile(id);
        clock.ms += 61_000;
        await timed.reconcile(id);
        await failWith(a!.rootJobId!, 'timeout');
        await timed.reconcile(id);
        expect(await timed.retry(id, 'a')).toEqual({ result: 'ok' });
        expect(await kindsOf('a', id)).toEqual(['launch', 'infra_retry', 'retry']);

        const number = await publish(b!.rootJobId!);
        await setStatus(b!.rootJobId!, 'succeeded');
        await timed.reconcile(id);
        const deps = { sql, orgId: ORG, now: () => new Date(clock.ms) };
        const [claim] = await claimDue(deps, 5);
        await commitObservation(deps, claim!, {
            kind: 'facts',
            facts: {
                repo: REPO,
                number,
                url: prUrlOf(REPO, number),
                state: 'open',
                merged: false,
                mergedAt: null,
                mergeCommitSha: null,
                updatedAt: null,
                baseBranch: 'main',
                headSha: 'h1',
                targetSha: 't1',
                mergeable: true,
                requiredContexts: ['build'],
                requiredApprovals: 0,
                approvals: 0,
                checks: [{ name: 'build', state: 'pending', url: null, detail: null }],
            },
        });

        const report = (await timed.report(id))!;
        const observedAt = new Date(clock.ms).toISOString();
        expect(report).toMatchObject({ latestObservationAt: observedAt });
        expect(report).not.toHaveProperty('unavailable');
        const byKey = Object.fromEntries(report.tasks.map((t) => [t.key, t]));
        expect(byKey.a).toMatchObject({
            infraRetries: 1,
            repairs: 0,
            manualRetries: 1,
            remaining: { infraRetries: 1, repairs: 2 },
            usage: { tokenUsage: { state: 'unmeasured' }, tokenUsageUnavailable: null },
            observation: null,
        });
        expect(byKey.b).toMatchObject({
            manualRetries: 0,
            remaining: { infraRetries: 2, repairs: 2 },
            observation: {
                outcome: 'checks_pending',
                checks: 'pending',
                mergeability: 'clean',
                headSha: 'h1',
                targetSha: 't1',
                stale: false,
                observedAt,
                error: null,
            },
        });
        expect(Object.keys(byKey.a!.usage).sort()).toEqual([
            'agentTurns',
            'tokenUsage',
            'tokenUsageUnavailable',
            'wallClockMs',
        ]);
    });

    it('is not available for a draft', async () => {
        const { id } = await store.create(planWith([{ key: 'one', tasks: [task('a')] }]), ALICE);
        expect(await store.report(id)).toBeNull();
    });
});

describe.skipIf(!enabled)('batch lifecycle status', () => {
    /** The record and the list must answer the same status, the list carrying `expiredAt`. */
    const statusOf = async (id: string, target: BatchStore = store) => {
        const record = (await target.get(id))!;
        const summary = (await target.list()).find((batch) => batch.id === id)!;
        expect(summary.status).toBe(record.status);
        expect(summary.expiredAt).toBe(record.expiredAt);
        return record.status;
    };
    const oneTask = (budgets: Record<string, number> = {}) => planWith([{ key: 'one', tasks: [task('a')] }], budgets);

    it('reads draft before start and running once started', async () => {
        const source = oneTask();
        const { id } = await store.create(source, ALICE);
        expect(await statusOf(id)).toBe('draft');
        const plan = resolveBatchPlan(source, { 'acme/web': 'main' });
        expect(await store.start({ id, version: 1, plan, startedBy: ALICE })).toMatchObject({ result: 'ok' });
        expect(await statusOf(id)).toBe('running');
    });

    it('reads completed once the last task is accepted', async () => {
        const id = await frozen(oneTask());
        await store.reconcile(id);
        await setStatus((await stateOf(id)).a!.rootJobId!, 'succeeded');
        await store.accept(id, 'a', ALICE);
        expect(await statusOf(id)).toBe('completed');
    });

    it('reads cancelled after a cancel', async () => {
        const id = await frozen(oneTask());
        await store.reconcile(id);
        await store.cancel(id, ALICE);
        expect(await statusOf(id)).toBe('cancelled');
    });

    it('reads expired once the deadline passes, and cancelled when cancelled after expiry', async () => {
        const { clock, store: timed } = clockedStore();
        const id = await frozen(oneTask({ timeLimitMinutes: 1 }), timed);
        await timed.reconcile(id);
        clock.ms += 120_000;
        await timed.reconcile(id);
        expect(await statusOf(id, timed)).toBe('expired');

        expect(await timed.cancel(id, ALICE)).toMatchObject({ result: 'ok' });
        expect(await statusOf(id, timed)).toBe('cancelled');
        expect((await timed.get(id))!.expiredAt).not.toBeNull();
        expect((await timed.report(id))!.state).toBe('cancelled');
    });
});

describe.skipIf(!enabled)('the claim carries the batch target branch', () => {
    it('on a task, its retry and its follow-up; never on a job outside a batch', async () => {
        const claimJobs = createJobStore({ sql, orgId: CLAIM_ORG });
        const claimBatches = createBatchStore({
            sql,
            orgId: CLAIM_ORG,
            stop: (id, by) => claimJobs.stop(id, by),
            close: (id, by) => claimJobs.markDone(id, by),
        });
        const sandbox = batchPlan('Sandbox', [{ key: 'one', tasks: [task('a')] }], {
            targets: [{ key: 'web', repo: BATCH_REPO, branch: 'batch-sandbox' }],
        });
        const id = await startBatch(claimBatches, sandbox, ALICE);
        await claimBatches.reconcile(id);
        const root = (await claimBatches.get(id))!.tasks[0]!.rootJobId!;

        const first = await claimJobs.claim('w1', 300);
        expect(first).toMatchObject({ id: root, baseBranch: 'batch-sandbox' });

        await sql`update job set status = 'failed', finished_at = now() where id = ${root}`;
        const retry = (await claimJobs.createRetry(root, ALICE)) as { id: string };
        expect(await claimJobs.claim('w1', 300)).toMatchObject({ id: retry.id, baseBranch: 'batch-sandbox' });

        await sql`update job set status = 'succeeded', finished_at = now() where id = ${retry.id}`;
        const followUp = (await claimJobs.createFollowUp(retry.id, 'adjust', ALICE)) as { id: string };
        expect(await claimJobs.claim('w1', 300)).toMatchObject({ id: followUp.id, baseBranch: 'batch-sandbox' });

        const loose = (await claimJobs.create('echo hi', ALICE, { repo: BATCH_REPO, executor: null })) as {
            id: string;
        };
        const looseClaim = await claimJobs.claim('w1', 300);
        expect(looseClaim).toMatchObject({ id: loose.id });
        expect(looseClaim).not.toHaveProperty('baseBranch');
    });
});

describe.skipIf(!enabled)('batch report usage', () => {
    const TYPES = ['input', 'output', 'cacheRead', 'cacheCreation'] as const satisfies readonly TokenType[];
    const at = (hhmm: string): string => `2026-09-10T${hhmm}:00Z`;

    /** One batch of three tasks: a (follow-up, retry, recovery, review), b (partial), c (no evidence). */
    async function build() {
        const w = createWorld(sql);
        const id = await frozen(plan([{ key: 'build', tasks: [task('a'), task('b'), task('c')] }], 3));
        await store.reconcile(id);
        const root = {
            a: await rootOf(store, id, 'a'),
            b: await rootOf(store, id, 'b'),
            c: await rootOf(store, id, 'c'),
        };
        const sessions = { a: w.marker('sa'), retry: w.marker('sr'), review: w.marker('sv'), b: w.marker('sb') };
        const point = (session: string, type: TokenType) => (value: number, time: string) =>
            w.point({ session, field: `tokens_${type}`, value, time, attrs: { model: 'm1' } });
        const run = (
            job: string,
            o: { root: string; session: string; start: string; end: string } & Record<string, unknown>
        ) => {
            const { root: rootId, session, start, end, ...extra } = o;
            return w.execution({
                org: ORG,
                job,
                root: rootId,
                start: at(start),
                end: at(end),
                sessions: [{ id: session }],
                ...extra,
            });
        };

        // a: the first run, a shared-session follow-up, a fresh retry, a same-row recovery claim, a named review.
        await run(root.a, { root: root.a, session: sessions.a, start: '10:00', end: '10:30' });
        await point(sessions.a, 'input')(100, at('10:10'));
        await point(sessions.a, 'output')(10, at('10:10'));
        await point(sessions.a, 'cacheRead')(1000, at('10:10'));
        await point(sessions.a, 'cacheCreation')(5, at('10:10'));
        const followUp = await w.job({ org: ORG, root: root.a, parent: root.a, author: ALICE });
        await run(followUp, { root: root.a, session: sessions.a, start: '11:00', end: '11:30' });
        await point(sessions.a, 'input')(40, at('11:10'));
        const retry = await w.job({ org: ORG, root: root.a, parent: root.a, author: ALICE });
        await run(retry, { root: root.a, session: sessions.retry, start: '12:00', end: '12:30' });
        await point(sessions.retry, 'input')(7, at('12:10'));
        await run(root.a, {
            root: root.a,
            session: sessions.a,
            start: '10:30',
            end: '10:50',
            claim: 2,
            launch: 'adopted',
            adopts: 1,
        });
        await point(sessions.a, 'input')(3, at('10:40'));
        const review = await w.job({ org: ORG, reviewOf: followUp, author: ALICE });
        await run(review, {
            root: review,
            session: sessions.review,
            start: '13:00',
            end: '13:20',
            requestingJob: root.a,
            requestingRoot: root.a,
        });
        await point(sessions.review, 'output')(9, at('13:10'));
        // b: partially measured: input and output only.
        await run(root.b, { root: root.b, session: sessions.b, start: '10:00', end: '10:30' });
        await point(sessions.b, 'input')(8, at('10:10'));
        await point(sessions.b, 'output')(20, at('10:10'));
        return { w, id, root, sessions, run, point };
    }

    const report = async (id: string, deps = {}) => (await readReport(sql, { orgId: ORG, id }, deps))!;

    it('equals the canonical task contributions per type; an unstarted-evidence task is unmeasured, not zero', async () => {
        const { id, root } = await build();
        const r = await report(id);
        const byKey = Object.fromEntries(r.tasks.map((t) => [t.key, t.usage.tokenUsage]));
        expect(r.tasks.find((t) => t.key === 'a')!.usage.tokenUsageUnavailable).toBeNull();
        // The independent sum of the points inserted for a: run + follow-up + retry + recovery + review.
        expect(byKey.a!.tokens).toEqual({ input: 150, output: 19, cacheRead: 1000, cacheCreation: 5 });
        expect(byKey.b!.tokens).toEqual({ input: 8, output: 20, cacheRead: null, cacheCreation: null });
        expect(byKey.c).toMatchObject({ state: 'unmeasured', tokens: { input: null, output: null } });
        expect(r.totals.tokenUsage.tokens).toEqual({ input: 158, output: 39, cacheRead: 1000, cacheCreation: 5 });
        expect(r.totals.tokenUsage.coverage.cacheRead).toEqual({ measured: 1, contributors: 4 });
        expect(r.totals.tokenUsage.coverage.input.measured).toBe(3);
        expect(r.totals.tokenUsage.rows.length).toBeGreaterThan(0);
        expect(r.totals.usageUnavailableTasks).toBe(0);
        // The same reducer, the same snapshot: each task block is the task's own usage.
        const facts = await sql.begin('isolation level repeatable read, read only', (tx) =>
            readUsageFacts(tx, ORG, { taskIds: [root.a, root.b] })
        );
        for (const key of ['a', 'b'] as const) {
            const own = taskUsageOf(facts, root[key], new Date(r.usageSnapshotAt))!.usage;
            expect({ ...byKey[key], provisional: false }).toEqual({ ...own, provisional: false });
        }
        // The batch is still moving, so the figures are provisional.
        expect(r.totals.tokenUsage.provisional).toBe(true);
        expect(byKey.a!.provisional).toBe(true);
        for (const type of TYPES) expect(r.totals.tokenUsage.tokens[type]).not.toBe(0);
    });

    it('is unchanged by an adoption row or a dimension row', async () => {
        const { id, root, w, sessions, run } = await build();
        const before = await report(id);
        await run(root.a, {
            root: root.a,
            session: sessions.a,
            start: '10:50',
            end: '10:55',
            claim: 3,
            launch: 'adopted',
            adopts: 2,
        });
        // A dimension row: the same session, type and time again under another model and source.
        await w.point({
            session: sessions.a,
            field: 'tokens_input',
            value: 100,
            time: at('10:10'),
            source: 'transcript',
            attrs: { model: 'm2' },
        });
        // A batch_attempt row for a (a retry onto an existing run) is one attempt more and no token at all.
        await sql`
            insert into batch_attempt (org_id, batch_id, task_key, attempt, kind, job_id, repo, source_branch)
            select ${ORG}, ${id}, 'a', max(attempt) + 1, 'retry', ${root.a}, min(repo), min(source_branch)
            from batch_attempt where org_id = ${ORG} and batch_id = ${id} and task_key = 'a'
        `;
        const after = await report(id);
        expect(after.totals.tokenUsage.tokens).toEqual(before.totals.tokenUsage.tokens);
        expect(after.totals.tokenUsage.counts).toEqual(before.totals.tokenUsage.counts);
        expect(after.tasks.map((t) => t.usage.tokenUsage.tokens)).toEqual(
            before.tasks.map((t) => t.usage.tokenUsage.tokens)
        );
        expect(after.tasks.map((t) => [t.key, t.attempts])).toEqual(
            before.tasks.map((t) => [t.key, t.key === 'a' ? t.attempts + 1 : t.attempts])
        );
    });

    it('does not report a reducer failure as unavailable telemetry', async () => {
        const { id } = await build();
        await expect(report(id, { readFacts: async () => null as never })).rejects.toThrow();
    });

    it('reads membership and usage in one snapshot: a change committed between them is not mixed in', async () => {
        const { id, root, w, sessions, run, point } = await build();
        const before = await report(id);
        const during = await report(id, {
            beforeUsage: async () => {
                // Another connection commits a new execution of a, and removes b's task root.
                const extra = await w.job({ org: ORG, root: root.a, parent: root.a, author: ALICE });
                await run(extra, { root: root.a, session: sessions.a, start: '14:00', end: '14:30' });
                await point(sessions.a, 'input')(1000, at('14:10'));
                // removeThread refuses a batch-backed thread, so this is its write path without the guard.
                await sql.begin(async (tx) => {
                    await markExecutionsRemoved(tx, ORG, [root.b]);
                    await tx`delete from job where org_id = ${ORG} and id = ${root.b}`;
                });
            },
        });
        expect(during.totals.tokenUsage.tokens).toEqual(before.totals.tokenUsage.tokens);
        expect(during.tasks.map((t) => t.usage.tokenUsageUnavailable)).toEqual([null, null, null]);
        // The next snapshot sees both: a gained the amount, and b is a removed member, never guessed.
        const next = await report(id);
        const b = next.tasks.find((t) => t.key === 'b')!;
        expect(b.usage).toMatchObject({ tokenUsageUnavailable: 'task-removed', tokenUsage: { state: 'unavailable' } });
        expect(next.totals.usageUnavailableTasks).toBe(1);
        expect(next.tasks.find((t) => t.key === 'a')!.usage.tokenUsage.tokens.input).toBe(1150);
        expect(next.totals.tokenUsage.tokens.input).toBe(1150);
        expect(next.tasks.map((t) => t.key)).toEqual(['a', 'b', 'c']);
    });

    it('reports usage unavailable, not zero, and still explains scheduling, when telemetry cannot be read', async () => {
        const { id } = await build();
        const healthy = await report(id);
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const failing = await report(id, {
            readFacts: async () => {
                throw new Error('telemetry down');
            },
        });
        const calls = logged.mock.calls.map((call) => String(call[0]));
        logged.mockRestore();
        expect(calls.some((line) => line.includes('telemetry down'))).toBe(true);
        expect(failing.totals.tokenUsage.state).toBe('unavailable');
        expect(failing.tasks.every((t) => t.usage.tokenUsageUnavailable === 'telemetry')).toBe(true);
        expect(failing.tasks.map((t) => [t.key, t.execution, t.next])).toEqual(
            healthy.tasks.map((t) => [t.key, t.execution, t.next])
        );
        for (const source of ['fixture', 'off'] as const) {
            const off = await report(id, { telemetrySource: source });
            expect(off.totals.tokenUsage.state).toBe('unavailable');
            expect(off.tasks[0]!.usage.wallClockMs).toBe(healthy.tasks[0]!.usage.wallClockMs);
        }
    });
});
