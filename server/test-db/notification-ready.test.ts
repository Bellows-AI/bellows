import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { BatchPlan, PrFacts } from '@factory-ai/core';
import { createBatchPrObserver, type BatchPrObserver, type PrReader } from '../src/batch-pr-observer.js';
import { createBatchStore } from '../src/db/batches/batch-store.js';
import type { BatchStore } from '../src/db/batches/batch-store-types.js';
import { claimDue, commitObservation, requestRefresh } from '../src/db/batches/batch-store-observation.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { createPrLifecycleStore, type PrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { GitHubReadError } from '../src/github/pr-read.js';
import { useTestDb } from './harness.js';
import { testOrg, testUser } from './fixtures.js';
import {
    BATCH_REPO,
    batchPlan,
    checks,
    facts,
    headOf as sharedHeadOf,
    prTask,
    recordPr,
    rootOf as sharedRootOf,
    setSucceeded,
    startBatch,
} from './batch-fixtures.js';

/**
 * A batch task whose run published a PR is ready only once the board has nothing left to
 * do on it by itself — its PR reads as waiting on a person — never at each run's settle, so an
 * automatic repair does not notify again. One task.ready per head run.
 */
const enabled = Boolean(process.env.DATABASE_URL);

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const ALICE = ALICE_USER.id;

const db = useTestDb({ orgs: [ORG], users: [ALICE_USER], max: 10 });

let sql: Sql;
let jobs: JobStore;
let prs: PrLifecycleStore;
let store: BatchStore;
let observer: BatchPrObserver;
const clock = { ms: Date.now() };
const now = () => new Date(clock.ms);

const replies = new Map<number, PrFacts>();
const reader: PrReader = {
    async readPullRequest(_repo, number) {
        const reply = replies.get(number);
        if (reply === undefined) throw new GitHubReadError('not found', 'not_found');
        return reply;
    },
};

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    prs = createPrLifecycleStore({ sql, orgId: ORG });
    jobs = createJobStore({ sql, orgId: ORG, prs });
    store = createBatchStore({ sql, orgId: ORG, stop: (id, by) => jobs.stop(id, by) });
});

beforeEach(() => {
    replies.clear();
    clock.ms = Date.now();
    if (!enabled) return;
    observer = createBatchPrObserver({
        sql,
        orgId: ORG,
        reader,
        recordMerge: (repo, number, deliveryId, mergedAt) => jobs.closeMergedPr(repo, number, deliveryId, mergedAt),
        reconcile: (id) => store.reconcile(id),
        now,
    });
});

const stage = (policy: 'human' | 'automerge', task: Record<string, unknown> = prTask('a')) => ({
    key: 'one',
    policy,
    tasks: [task],
});
const planOf = (policy: 'human' | 'automerge' = 'human', task?: Record<string, unknown>): BatchPlan =>
    batchPlan('Ready', [stage(policy, task)]);

let nextPr = 3000;

/** A one-task batch whose first run succeeded; `publish` records the PR the run opened first. */
async function settled(source: BatchPlan, { publish = true } = {}) {
    const id = await startBatch(store, source, ALICE);
    await store.reconcile(id);
    const root = await sharedRootOf(store, id, 'a');
    nextPr += 1;
    const number = nextPr;
    if (publish) await recordPr(prs, root, number);
    await setSucceeded(sql, root);
    await store.reconcile(id);
    return { id, root, number };
}

/** The observer's next pass, the fake GitHub answering `extra` for the PR. */
async function observe(number: number, extra: Partial<PrFacts> = {}) {
    replies.set(number, facts(number, extra));
    clock.ms += 61_000;
    await observer.observeDue();
}

const readyOf = (root: string) =>
    sql<{ id: string; job_id: string; pr_url: string | null }[]>`
        select id::text, job_id::text, pr_url from notification_event
        where org_id = ${ORG} and root_job_id = ${root} and kind = 'task.ready'
        order by occurred_at, id
    `;

const readyIdOf = async (jobId: string) =>
    (await sql<{ id: string }[]>`select md5(${jobId} || '/task.ready')::uuid::text as id`)[0]!.id;

const prUrl = (number: number) => `https://github.com/${BATCH_REPO}/pull/${number}`;

describe.skipIf(!enabled)('task.ready for a batch task with a published PR', () => {
    it('a batch PR task emits no task.ready when its run settles', async () => {
        const { root } = await settled(planOf());
        expect(await readyOf(root)).toEqual([]);
    });

    it.each([
        ['ready', {}],
        ['review_required', { requiredApprovals: 1, approvals: 0 }],
    ] as const)('a repaired batch PR task emits one task.ready, after the final %s observation', async (_o, extra) => {
        const { id, root, number } = await settled(planOf());
        await observe(number, { checks: checks('failing') });
        await store.reconcile(id);
        const repair = await sharedHeadOf(sql, root);
        expect(repair.id).not.toBe(root);
        await setSucceeded(sql, root);
        await store.reconcile(id);
        expect(await readyOf(root)).toEqual([]);

        await observe(number, extra);

        const rows = await readyOf(root);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ job_id: repair.id, id: await readyIdOf(repair.id), pr_url: prUrl(number) });
    });

    it('checks_missing on a human stage emits one task.ready', async () => {
        const { root, number } = await settled(planOf());
        expect(await readyOf(root)).toEqual([]);
        await observe(number, { checks: [] });
        expect((await readyOf(root)).map((r) => r.job_id)).toEqual([root]);
    });

    it.each([
        ['pending', { checks: checks('pending') }],
        ['failing', { checks: checks('failing') }],
        ['unknown', { mergeable: null }],
        ['conflicting', { targetSha: 't2', mergeable: false }],
    ] as const)('a %s observation emits nothing', async (_o, extra) => {
        const { root, number } = await settled(planOf());
        await observe(number, extra);
        expect(await readyOf(root)).toEqual([]);
    });

    it('repeated idle observations of one head emit once', async () => {
        const { root, number } = await settled(planOf());
        expect(await readyOf(root)).toEqual([]);
        await observe(number);
        await observe(number);
        await observe(number, { requiredApprovals: 1, approvals: 0 });
        await observe(number);
        expect((await readyOf(root)).map((r) => r.job_id)).toEqual([root]);
    });

    it("an automerge stage's ready PR emits nothing", async () => {
        const { root, number } = await settled(planOf('automerge'));
        await observe(number);
        expect(await readyOf(root)).toEqual([]);
    });

    it.each([
        ['review_required', { requiredApprovals: 1, approvals: 0 }],
        ['checks_missing', { checks: [] }],
    ] as const)("an automerge stage's %s PR emits one task.ready", async (_o, extra) => {
        const { root, number } = await settled(planOf('automerge'));
        expect(await readyOf(root)).toEqual([]);
        await observe(number, extra);
        expect((await readyOf(root)).map((r) => r.job_id)).toEqual([root]);
    });

    it('a stale observation emits nothing until a fresh read', async () => {
        const { root, number } = await settled(planOf());
        const deps = { sql, orgId: ORG, now };
        const [claim] = await claimDue(deps, 5);
        expect(claim).toBeDefined();
        await requestRefresh(deps, { repo: BATCH_REPO, numbers: [number] });
        await commitObservation(deps, claim!, { kind: 'facts', facts: facts(number) });
        expect(await readyOf(root)).toEqual([]);

        await observe(number);
        expect((await readyOf(root)).map((r) => r.job_id)).toEqual([root]);
    });

    it('an observation of an earlier attempt emits nothing', async () => {
        const { id, root, number } = await settled(planOf());
        await observe(number, { checks: checks('failing') });
        await store.reconcile(id);
        await setSucceeded(sql, root);
        await store.reconcile(id);
        await claimDue({ sql, orgId: ORG, now }, 5);
        await sql`
            update batch_pr_observation set attempt = 1, outcome = 'ready', stale = false
            where org_id = ${ORG} and batch_id = ${id} and task_key = 'a'
        `;
        expect(await readyOf(root)).toEqual([]);
    });

    it('a ready read while the task is not succeeded emits nothing, and the next read after it is does', async () => {
        const { id, root, number } = await settled(planOf());
        await sql`
            update batch_task set execution = 'retry', recovery = 'repair'
            where org_id = ${ORG} and batch_id = ${id} and key = 'a'
        `;
        await observe(number);
        expect(await readyOf(root)).toEqual([]);

        await sql`
            update batch_task set execution = 'succeeded', recovery = null
            where org_id = ${ORG} and batch_id = ${id} and key = 'a'
        `;
        await observe(number);
        expect((await readyOf(root)).map((r) => r.job_id)).toEqual([root]);
    });

    it('a task with attention set emits nothing', async () => {
        const { id, root, number } = await settled(planOf());
        await sql`
            update batch_task set attention = 'budget'
            where org_id = ${ORG} and batch_id = ${id} and key = 'a'
        `;
        await observe(number, { requiredApprovals: 1, approvals: 0 });
        expect(await readyOf(root)).toEqual([]);
    });

    it('a cancelled batch, still read for a merge, emits nothing', async () => {
        const { id, root, number } = await settled(planOf());
        expect(await store.cancel(id, ALICE)).toMatchObject({ result: 'ok' });
        await observe(number, { requiredApprovals: 1, approvals: 0 });
        expect(await readyOf(root)).toEqual([]);
    });
});

describe.skipIf(!enabled)('task.ready at settle for a batch task without a published PR', () => {
    it('an accepted-completion batch task keeps task.ready at settle', async () => {
        const accepted = { ...prTask('a'), completion: { kind: 'accepted', condition: 'reviewed' } };
        const { root } = await settled(planOf('human', accepted), { publish: false });
        expect((await readyOf(root)).map((r) => r.job_id)).toEqual([root]);
    });

    it('a PR task whose run published no PR keeps task.ready at settle', async () => {
        const { root } = await settled(planOf(), { publish: false });
        expect((await readyOf(root)).map((r) => r.job_id)).toEqual([root]);
    });
});
