import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { resolveBatchPlan, validateBatchPlan, type BatchPlan } from '@factory-ai/core';
import { randomUUID } from 'node:crypto';
import { createBatchStore, type BatchStore } from '../src/db/batch-store.js';
import { createPrLifecycleStore, type PrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';

/**
 * Dispatch against a real database (docs/batches.md): the scheduler's transactions, the unique
 * decisions and the row lock are what these pin — the pure decisions are core/test/batch-schedule.test.ts.
 */

const enabled = Boolean(process.env.DATABASE_URL);

const ORG = 'test-org';
const ALICE = '00000000-0000-4000-8000-00000000ba70';

const db = useTestDb({ orgs: [ORG], users: [{ id: ALICE, githubUserId: 90078, login: 'alice' }], max: 10 });

let sql: Sql;
let jobs: JobStore;
let store: BatchStore;
let prs: PrLifecycleStore;

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    prs = createPrLifecycleStore({ sql, orgId: ORG });
    jobs = createJobStore({ sql, orgId: ORG, prs });
    store = createBatchStore({ sql, orgId: ORG, stop: (id, by) => jobs.stop(id, by) });
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

function plan(stages: Record<string, unknown>[], concurrency = 2): BatchPlan {
    const result = validateBatchPlan({
        planVersion: 1,
        title: 'Dispatch',
        targets: [{ key: 'web', repo: 'acme/web' }],
        defaultTarget: 'web',
        executor: 'claude',
        concurrency,
        stages,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.plan;
}

const parallelThenJoin = (concurrency = 2) =>
    plan(
        [
            { key: 'build', tasks: [task('a'), task('b')] },
            { key: 'join', tasks: [task('j')] },
        ],
        concurrency
    );

/** A frozen batch, not yet dispatched: start queues nothing, reconcile is dispatch. */
async function frozen(source: BatchPlan, target: BatchStore = store): Promise<string> {
    const { id } = await target.create(source, ALICE);
    const started = await target.start({
        id,
        version: 1,
        plan: resolveBatchPlan(source, { 'acme/web': 'main' }),
        startedBy: ALICE,
    });
    expect(started).toMatchObject({ result: 'ok' });
    return id;
}

const stateOf = async (id: string) => {
    const record = (await store.get(id))!;
    return Object.fromEntries(record.tasks.map((t) => [t.key, t]));
};

/** The thread's newest job, whatever a retry has added. */
async function headOf(root: string) {
    const [row] = await sql<{ id: string; status: string }[]>`
        select id, status from job where root_job_id = ${root} order by created_at desc, id desc limit 1
    `;
    return row!;
}

const setStatus = async (root: string, status: 'running' | 'succeeded' | 'failed') => {
    const head = await headOf(root);
    if (status === 'running') {
        await sql`update job set status = 'running', claimed_by = 'w1', started_at = now() where id = ${head.id}`;
    } else {
        await sql`update job set status = ${status}, finished_at = now(), lease_token = null where id = ${head.id}`;
    }
};

const jobCount = async () => Number((await sql`select count(*) from job`)[0]!.count);
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
        expect(await store.cancel('00000000-0000-4000-8000-000000000000', ALICE)).toEqual({ result: 'missing' });
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
    it('refuses to remove or reopen a thread that backs a batch task', async () => {
        const id = await frozen(plan([{ key: 'only', tasks: [task('a')] }]));
        await store.reconcile(id);
        const { a } = await stateOf(id);
        await setStatus(a!.rootJobId!, 'succeeded');

        expect(await jobs.markDone(a!.rootJobId!, ALICE)).toBe('batch');
        expect(await jobs.removeThread(a!.rootJobId!, ALICE)).toBe('batch');
        expect(await jobs.reopen(a!.rootJobId!)).toBe('batch');
        expect(await jobCount()).toBe(1);
    });

    it('still removes an ordinary thread', async () => {
        const ref = await jobs.create('echo', ALICE, { repo: null, executor: null });
        if (typeof ref === 'string') throw new Error(ref);
        expect(await jobs.removeThread(ref.id, ALICE)).toMatchObject({ result: 'ok' });
    });
});

const REPO = 'acme/web';
let nextPr = 1000;

const prTask = (key: string) => task(key, { completion: { kind: 'pr' } });
const prUrlOf = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;

/** Records the PR a task's thread published, as the verdict's publication does. */
async function publish(root: string, base = 'main', repo = REPO): Promise<number> {
    nextPr += 1;
    await prs.recordPublication({
        root,
        repo,
        prNumber: nextPr,
        prUrl: prUrlOf(repo, nextPr),
        headBranch: `factory/${root}`,
        baseBranch: base,
    });
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
    it('does not accept a succeeded run that opened no PR', async () => {
        const { id } = await succeededFirst();
        await store.reconcile(id);
        expect(await stateOf(id)).toMatchObject({
            a: { execution: 'succeeded', gate: 'open', waitReason: 'the run succeeded without opening a PR' },
            b: { execution: 'pending' },
        });
        expect(await decisions(id)).not.toContain('advance:one');
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

    it('does not take another repository or another PR number as evidence', async () => {
        const { id, root } = await succeededFirst();
        const number = await publish(root);
        await merge('acme/other', number);
        await merge(REPO, number + 1);
        await store.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({ gate: 'open' });
    });

    it('refuses a merged PR that targets another branch, with a reason', async () => {
        const { id, root } = await succeededFirst();
        const number = await publish(root, 'release');
        await merge(REPO, number);
        await store.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({
            gate: 'open',
            waitReason: `PR ${prUrlOf(REPO, number)} targets release, not main`,
        });
        expect(await decisions(id)).not.toContain('advance:one');
    });

    it('treats a merge older than the current attempt as stale', async () => {
        const { id, root } = await succeededFirst();
        const number = await publish(root);
        await merge(REPO, number);
        await sql`update pr_merge set merged_at = now() - interval '1 hour' where repo = ${REPO} and pr_number = ${number}`;
        await store.reconcile(id);
        expect((await stateOf(id)).a).toMatchObject({
            gate: 'open',
            waitReason: `PR ${prUrlOf(REPO, number)} was merged before attempt 1 started`,
        });
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
