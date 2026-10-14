import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { BatchPlan, PrFacts } from '@factory-ai/core';
import { createBatchPrObserver, type BatchPrObserver, type PrReader } from '../src/batch-pr-observer.js';
import { createBatchStore, type BatchStore } from '../src/db/batch-store.js';
import {
    claimDue,
    commitObservation,
    OBSERVATION_LEASE_MS,
    requestRefresh,
} from '../src/db/batch-store-observation.js';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { createPrLifecycleStore, type PrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { GitHubReadError } from '../src/github/pr-read.js';
import { useTestDb } from './harness.js';
import {
    batchPlan,
    checks,
    facts,
    jobCount as sharedJobCount,
    prTask,
    recordPr,
    rootOf as sharedRootOf,
    setSucceeded,
    startBatch,
} from './batch-fixtures.js';

/**
 * PR observation against a real database (docs/batches.md): leases, supersession, invalidation by
 * a new attempt, org scoping and the merge hand-off are SQL, so they are pinned here. GitHub is a
 * fake reader — it cannot prove how hosted protection or a merge queue behaves, only that the
 * board reads, records and refuses correctly given what a reader reports.
 */

const enabled = Boolean(process.env.DATABASE_URL);

const ORG = 'test-org';
const OTHER = 'other-org';
const ALICE = '00000000-0000-4000-8000-00000000ba70';
const REPO = 'acme/web';

const db = useTestDb({ orgs: [ORG, OTHER], users: [{ id: ALICE, githubUserId: 90078, login: 'alice' }], max: 10 });

let sql: Sql;
let jobs: JobStore;
let prs: PrLifecycleStore;
let store: BatchStore;
let observer: BatchPrObserver;
const clock = { ms: Date.now() };
const now = () => new Date(clock.ms);

/** The fake GitHub: what each PR number answers, and which numbers were actually read. */
const github = {
    replies: new Map<number, PrFacts | Error>(),
    reads: [] as number[],
};
const reader: PrReader = {
    async readPullRequest(_repo, number) {
        github.reads.push(number);
        const reply = github.replies.get(number);
        if (reply === undefined) throw new GitHubReadError('not found', 'not_found');
        if (reply instanceof Error) throw reply;
        return reply;
    },
};

const observerFor = (orgId: string, jobStore: JobStore, batchStore: BatchStore) =>
    createBatchPrObserver({
        sql,
        orgId,
        reader,
        recordMerge: (repo, number, deliveryId, mergedAt) => jobStore.closeMergedPr(repo, number, deliveryId, mergedAt),
        reconcile: (id) => batchStore.reconcile(id),
        now,
    });

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    prs = createPrLifecycleStore({ sql, orgId: ORG });
    jobs = createJobStore({ sql, orgId: ORG, prs });
    store = createBatchStore({ sql, orgId: ORG, stop: (id, by) => jobs.stop(id, by) });
});

beforeEach(() => {
    github.replies.clear();
    github.reads.length = 0;
    clock.ms = Date.now();
    // An observer holds the installation's rate-limit pause in memory; a test's clock starts over,
    // so a pause one test earned must not outlive it.
    if (enabled) observer = observerFor(ORG, jobs, store);
});

const plan = (stages: Record<string, unknown>[], extra: Record<string, number> = {}): BatchPlan =>
    batchPlan('Observe', stages, extra);

const frozen = (source: BatchPlan, target: BatchStore = store) => startBatch(target, source, ALICE);

const rootOf = (id: string, key: string, target: BatchStore = store) => sharedRootOf(target, id, key);

let nextPr = 2000;
async function publish(root: string, store: PrLifecycleStore = prs, repo = REPO): Promise<number> {
    nextPr += 1;
    await recordPr(store, root, nextPr, { repo });
    return nextPr;
}

const jobCount = () => sharedJobCount(sql);

/** A one-task batch whose run succeeded and whose PR is published: the state observation exists for. */
async function succeededWithPr() {
    const id = await frozen(plan([{ key: 'one', tasks: [prTask('a')] }]));
    await store.reconcile(id);
    const root = await rootOf(id, 'a');
    const number = await publish(root);
    await setSucceeded(sql, root);
    await store.reconcile(id);
    return { id, root, number };
}

const only = async (id: string, observed: BatchPrObserver = observer) => {
    const rows = await observed.list(id);
    expect(rows).toHaveLength(1);
    return rows[0]!;
};

describe.skipIf(!enabled)('PR observation', () => {
    it('records a repairable finding against the current head when a PR check fails after a successful run', async () => {
        const { id, number } = await succeededWithPr();
        github.replies.set(number, facts(number, { checks: checks('failing') }));
        const jobsBefore = await jobCount();

        expect(await observer.observeDue()).toBe(1);

        expect(await only(id)).toMatchObject({
            taskKey: 'a',
            repo: REPO,
            prNumber: number,
            outcome: 'checks_failing',
            repairable: true,
            headSha: 'h1',
            targetSha: 't1',
            checks: 'failing',
            stale: false,
            error: null,
            revision: 1,
            evidence: [{ name: 'build', state: 'failing', url: 'https://ci/1' }],
        });
        // Observation supplies facts: no agent run, no attempt, no gate change.
        expect(await jobCount()).toBe(jobsBefore);
        expect((await store.get(id))!.tasks[0]).toMatchObject({ execution: 'succeeded', gate: 'open' });
    });

    it('polls on the 60 second cadence and a replay of the same observation bumps no revision', async () => {
        const { id, number } = await succeededWithPr();
        github.replies.set(number, facts(number, { checks: checks('failing') }));
        await observer.observeDue();
        const first = await only(id);

        clock.ms += 30_000;
        expect(await observer.observeDue()).toBe(0);
        clock.ms += 31_000;
        expect(await observer.observeDue()).toBe(1);

        const again = await only(id);
        expect(github.reads).toEqual([number, number]);
        expect(again.revision).toBe(first.revision);
        expect(again.fingerprint).toBe(first.fingerprint);
        expect(Date.parse(again.observedAt!)).toBeGreaterThan(Date.parse(first.observedAt!));
    });

    it('records the new head/target pair when the target moves and a clean PR conflicts', async () => {
        const { id, number } = await succeededWithPr();
        github.replies.set(number, facts(number));
        await observer.observeDue();
        expect(await only(id)).toMatchObject({ outcome: 'ready', repairable: false, targetSha: 't1', revision: 1 });

        github.replies.set(number, facts(number, { targetSha: 't2', mergeable: false }));
        clock.ms += 61_000;
        await observer.observeDue();

        expect(await only(id)).toMatchObject({
            outcome: 'conflicting',
            repairable: true,
            headSha: 'h1',
            targetSha: 't2',
            revision: 2,
        });
    });

    it.each([
        ['pending checks', { checks: checks('pending') }, 'checks_pending'],
        ['missing checks', { checks: [] }, 'checks_missing'],
        ['unknown mergeability', { mergeable: null }, 'unknown'],
        ['a pending review', { requiredApprovals: 1, approvals: 0 }, 'review_required'],
        ['a closed unmerged PR', { state: 'closed' as const }, 'closed_unmerged'],
    ] as const)('distinguishes %s and never calls it repairable', async (_what, extra, outcome) => {
        const { id, number } = await succeededWithPr();
        github.replies.set(number, facts(number, extra));

        await observer.observeDue();

        expect(await only(id)).toMatchObject({ outcome, repairable: false });
    });

    it('withdraws the assessment on a permission error and records an explicit error, never a pass', async () => {
        const { id, number } = await succeededWithPr();
        github.replies.set(number, facts(number));
        await observer.observeDue();
        github.replies.set(number, new GitHubReadError('Resource not accessible', 'forbidden'));
        clock.ms += 61_000;
        await observer.observeDue();

        expect(await only(id)).toMatchObject({
            outcome: null,
            repairable: false,
            headSha: null,
            error: { code: 'forbidden' },
            revision: 2,
        });
    });

    it('reports an inaccessible PR as not_found, with no assessment', async () => {
        const { id } = await succeededWithPr();

        await observer.observeDue();

        expect(await only(id)).toMatchObject({ outcome: null, repairable: false, error: { code: 'not_found' } });
    });

    it('backs off on a rate limit, honors Retry-After, pauses the installation and keeps the last assessment', async () => {
        const { id, number } = await succeededWithPr();
        github.replies.set(number, facts(number, { checks: checks('failing') }));
        await observer.observeDue();
        const good = await only(id);

        github.replies.set(number, new GitHubReadError('slow down', 'rate_limited', 300_000));
        clock.ms += 61_000;
        await observer.observeDue();
        const limited = await only(id);
        expect(limited).toMatchObject({ outcome: 'checks_failing', repairable: true, error: { code: 'rate_limited' } });
        expect(limited.revision).toBe(good.revision);
        expect(Date.parse(limited.nextRefreshAt) - clock.ms).toBe(300_000);

        // Inside the Retry-After window nothing is read, event or no event.
        const reads = github.reads.length;
        clock.ms += 120_000;
        await requestRefresh({ sql, orgId: ORG, now }, { repo: REPO, numbers: [number] });
        await observer.observeDue();
        expect(github.reads).toHaveLength(reads);

        github.replies.set(number, facts(number, { checks: checks('failing') }));
        clock.ms += 181_000;
        await observer.observeDue();
        const recovered = await only(id);
        expect(recovered).toMatchObject({ error: null, revision: good.revision, repairable: true });
    });

    it('does not spend the task execution budget on a polling failure', async () => {
        const { id, number } = await succeededWithPr();
        github.replies.set(number, new GitHubReadError('boom', 'transport'));
        const attempts = async () =>
            Number((await sql`select count(*) from batch_attempt where batch_id = ${id}`)[0]!.count);
        const before = await attempts();

        for (let i = 0; i < 3; i += 1) {
            clock.ms += 1_000_000;
            await observer.observeDue();
        }

        expect(await attempts()).toBe(before);
        expect(await only(id)).toMatchObject({ error: { code: 'transport' } });
    });

    it('refuses a PR recorded in a repository the task does not target, without reading it', async () => {
        const id = await frozen(plan([{ key: 'one', tasks: [prTask('a')] }]));
        await store.reconcile(id);
        const root = await rootOf(id, 'a');
        const number = await publish(root, prs, 'evil/web');
        await setSucceeded(sql, root);
        await store.reconcile(id);
        github.replies.set(number, facts(number, { repo: 'evil/web' }));

        await observer.observeDue();

        expect(github.reads).toEqual([]);
        expect(await only(id)).toMatchObject({ outcome: null, error: { code: 'binding' } });
    });

    it('coalesces two replicas and a duplicate pass into one read', async () => {
        const { number } = await succeededWithPr();
        github.replies.set(number, facts(number));
        const replica = observerFor(ORG, jobs, store);

        await Promise.all([observer.observeDue(), replica.observeDue(), observer.observeDue()]);

        expect(github.reads).toEqual([number]);
    });

    it('invalidates what was observed when a new attempt starts, and awaits fresh checks', async () => {
        const { id, number } = await succeededWithPr();
        github.replies.set(number, facts(number, { checks: checks('failing') }));
        await observer.observeDue();
        expect(await observer.list(id)).toHaveLength(1);

        expect(await store.retry(id, 'a')).toMatchObject({ result: 'ok' });

        expect(await observer.list(id)).toEqual([]);
        // The new attempt is running: a PR is not read until its run has succeeded again.
        clock.ms += 61_000;
        await observer.observeDue();
        expect(await observer.list(id)).toEqual([]);
    });

    it('drops a result whose claim was superseded by a new attempt while it was being read', async () => {
        const { id, number } = await succeededWithPr();
        const deps = { sql, orgId: ORG, now };
        const [claim] = await claimDue(deps, 5);
        expect(claim).toMatchObject({ taskKey: 'a', prNumber: number });

        await store.retry(id, 'a');
        const result = await commitObservation(deps, claim!, {
            kind: 'facts',
            facts: facts(number, { checks: checks('failing') }),
        });

        expect(result).toEqual({ status: 'superseded' });
        expect(await observer.list(id)).toEqual([]);
    });

    it('drops a result committed after its lease was taken over, and a late result for an older head', async () => {
        const { id, number } = await succeededWithPr();
        const deps = { sql, orgId: ORG, now };
        const [slow] = await claimDue(deps, 5);

        // The lease holds: nobody else may read this row.
        expect(await claimDue(deps, 5)).toEqual([]);
        clock.ms += OBSERVATION_LEASE_MS + 1;
        const [fast] = await claimDue(deps, 5);
        expect(fast!.token).not.toBe(slow!.token);

        expect(
            await commitObservation(deps, fast!, { kind: 'facts', facts: facts(number, { headSha: 'h2' }) })
        ).toMatchObject({ status: 'committed' });
        const late = await commitObservation(deps, slow!, {
            kind: 'facts',
            facts: facts(number, { headSha: 'h1', checks: checks('failing') }),
        });

        expect(late).toEqual({ status: 'superseded' });
        expect(await only(id)).toMatchObject({ headSha: 'h2', outcome: 'ready', repairable: false });
    });

    it('a rebound PR starts a fresh observation', async () => {
        const { id, root, number } = await succeededWithPr();
        github.replies.set(number, facts(number, { checks: checks('failing') }));
        await observer.observeDue();

        const replacement = await publish(root);
        github.replies.set(replacement, facts(replacement));
        clock.ms += 61_000;
        await observer.observeDue();

        expect(await only(id)).toMatchObject({ prNumber: replacement, outcome: 'ready', revision: 1 });
    });

    it('a hint marks the row stale and due, and a hint that lands during a read keeps it stale', async () => {
        const { id, number } = await succeededWithPr();
        const deps = { sql, orgId: ORG, now };
        github.replies.set(number, facts(number));
        await observer.observeDue();

        expect(await requestRefresh(deps, { repo: REPO.toUpperCase(), numbers: [number] })).toBe(1);
        expect(await only(id)).toMatchObject({ stale: true });
        const [claim] = await claimDue(deps, 5);
        expect(claim).toBeDefined();

        await requestRefresh(deps, { repo: REPO, headSha: 'h1' });
        await commitObservation(deps, claim!, { kind: 'facts', facts: facts(number) });
        expect(await only(id)).toMatchObject({ stale: true });

        await observer.observeDue();
        expect(await only(id)).toMatchObject({ stale: false });
    });

    it('a hint for a PR no batch task owns changes nothing', async () => {
        await succeededWithPr();
        expect(await requestRefresh({ sql, orgId: ORG, now }, { repo: 'acme/other', numbers: [1] })).toBe(0);
        expect(await requestRefresh({ sql, orgId: ORG, now }, { repo: REPO })).toBe(0);
    });
});

describe.skipIf(!enabled)('merge observation', () => {
    it('records an external merge though its webhook was lost, and the gate passes on it', async () => {
        const id = await frozen(
            plan([
                { key: 'one', tasks: [prTask('a')] },
                { key: 'two', tasks: [prTask('b')] },
            ])
        );
        await store.reconcile(id);
        const root = await rootOf(id, 'a');
        const number = await publish(root);
        await setSucceeded(sql, root);
        await store.reconcile(id);
        const mergedAt = new Date(Date.now() + 5_000).toISOString();
        github.replies.set(number, facts(number, { state: 'closed', merged: true, mergedAt, mergeCommitSha: 'mc1' }));

        await observer.observeDue();

        const [merged] = await sql<{ delivery_id: string; merged_at: Date }[]>`
            select delivery_id, merged_at from pr_merge where repo = ${REPO} and pr_number = ${number}
        `;
        expect(merged!.delivery_id).toBe('observed:mc1');
        expect(merged!.merged_at.toISOString()).toBe(mergedAt);
        const record = (await store.get(id))!;
        expect(record.tasks.find((t) => t.key === 'a')).toMatchObject({ gate: 'passed' });
        expect(record.tasks.find((t) => t.key === 'b')).toMatchObject({ execution: 'queued' });
        expect(await only(id)).toMatchObject({ outcome: 'merged', prState: 'merged' });

        // Recorded once: nothing reads a merged PR again.
        const reads = github.reads.length;
        clock.ms += 61_000;
        await observer.observeDue();
        expect(github.reads).toHaveLength(reads);
    });

    it('is idempotent with the webhook path: a merge delivered first is not recorded twice', async () => {
        const { number } = await succeededWithPr();
        await jobs.closeMergedPr(REPO, number, randomUUID());
        github.replies.set(number, facts(number, { state: 'closed', merged: true, mergeCommitSha: 'mc2' }));

        await observer.observeDue();

        expect(github.reads).toEqual([]);
        expect(await sql`select 1 from pr_merge where pr_number = ${number}`).toHaveLength(1);
    });

    it('keeps recording a merge after the batch was cancelled, without dispatching work or reviving it', async () => {
        const { id, number } = await succeededWithPr();
        expect(await store.cancel(id, ALICE)).toMatchObject({ result: 'ok' });
        const jobsBefore = await jobCount();
        github.replies.set(number, facts(number, { state: 'closed', merged: true, mergeCommitSha: 'mc3' }));

        await observer.observeDue();

        expect(await sql`select 1 from pr_merge where pr_number = ${number}`).toHaveLength(1);
        expect(await jobCount()).toBe(jobsBefore);
        const record = (await store.get(id))!;
        expect(record.cancelledAt).not.toBeNull();
        expect(record.completedAt).toBeNull();
        expect(record.tasks[0]).toMatchObject({ gate: 'open' });
    });

    it('stops reading a cancelled batch whose PR was closed unmerged', async () => {
        const { id, number } = await succeededWithPr();
        await store.cancel(id, ALICE);
        github.replies.set(number, facts(number, { state: 'closed' }));
        await observer.observeDue();
        expect(await only(id)).toMatchObject({ outcome: 'closed_unmerged' });

        const reads = github.reads.length;
        clock.ms += 61_000;
        await observer.observeDue();
        expect(github.reads).toHaveLength(reads);
    });
});

describe.skipIf(!enabled)('organization scope', () => {
    it('never reads or lists another organization’s PRs', async () => {
        const prsOther = createPrLifecycleStore({ sql, orgId: OTHER });
        const jobsOther = createJobStore({ sql, orgId: OTHER, prs: prsOther });
        const storeOther = createBatchStore({ sql, orgId: OTHER, stop: (id, by) => jobsOther.stop(id, by) });
        const observerOther = observerFor(OTHER, jobsOther, storeOther);

        const idOther = await frozen(plan([{ key: 'one', tasks: [prTask('a')] }]), storeOther);
        await storeOther.reconcile(idOther);
        const rootOther = await rootOf(idOther, 'a', storeOther);
        const numberOther = await publish(rootOther, prsOther);
        await setSucceeded(sql, rootOther);
        await storeOther.reconcile(idOther);
        github.replies.set(numberOther, facts(numberOther, { checks: checks('failing') }));

        await observer.observeDue();
        expect(github.reads).toEqual([]);
        expect(await observer.list(idOther)).toEqual([]);
        expect(await requestRefresh({ sql, orgId: ORG, now }, { repo: REPO, numbers: [numberOther] })).toBe(0);

        await observerOther.observeDue();
        expect(github.reads).toEqual([numberOther]);
        expect(await observerOther.list(idOther)).toHaveLength(1);
    });
});

describe.skipIf(!enabled)('observed recovery (#581)', () => {
    const repairsOf = async (id: string, key = 'a') =>
        sql<{ attempt: number; job_id: string }[]>`
            select attempt, job_id from batch_attempt
            where batch_id = ${id} and task_key = ${key} and kind = 'repair' order by attempt
        `;
    const repairDecisions = async (id: string) =>
        Number((await sql`select count(*) from batch_decision where batch_id = ${id} and kind = 'repair'`)[0]!.count);
    const jobRow = async (jobId: string) =>
        (
            await sql<{ root_job_id: string; parent_job_id: string | null; command: string }[]>`
                select root_job_id, parent_job_id, command from job where id = ${jobId}
            `
        )[0]!;
    const taskOf = async (id: string, key = 'a') => (await store.get(id))!.tasks.find((t) => t.key === key)!;

    /** A succeeded task whose PR the observer has just read as `extra` says. */
    async function observedAs(extra: Partial<PrFacts>) {
        const run = await succeededWithPr();
        github.replies.set(run.number, facts(run.number, extra));
        await observer.observeDue();
        return run;
    }

    it('repairs a PR that fails its checks after a successful run, once, as a follow-up of the same thread', async () => {
        const { id, root, number } = await observedAs({ checks: checks('failing') });

        await store.reconcile(id);

        const repairs = await repairsOf(id);
        expect(repairs).toHaveLength(1);
        expect(repairs[0]!.attempt).toBe(2);
        const job = await jobRow(repairs[0]!.job_id);
        expect(job.root_job_id).toBe(root);
        expect(job.parent_job_id).not.toBeNull();
        expect(job.command).toContain('failing its checks');
        expect(job.command).toContain('- build: failing (https://ci/1)');
        expect(job.command).toContain('a works');
        expect(await observer.list(id)).toEqual([]);
        expect(await taskOf(id)).toMatchObject({ execution: 'queued', gate: 'open', attention: null });
        expect((await store.get(id))!.tasks[0]!.rootJobId).toBe(root);
        expect(github.reads).toEqual([number]);
    });

    it('repairs a PR that conflicts after its target moved', async () => {
        const { id, number } = await observedAs({});
        github.replies.set(number, facts(number, { targetSha: 't2', mergeable: false }));
        clock.ms += 61_000;
        await observer.observeDue();

        await store.reconcile(id);

        const repairs = await repairsOf(id);
        expect(repairs).toHaveLength(1);
        expect((await jobRow(repairs[0]!.job_id)).command).toContain('conflicts with its target branch');
    });

    it('decides once for one fingerprint, however many passes race over it', async () => {
        const { id, number } = await observedAs({ checks: checks('failing') });

        await Promise.all([store.reconcile(id), store.reconcile(id), store.reconcile(id)]);
        await store.reconcile(id);

        expect(await repairsOf(id)).toHaveLength(1);
        expect(await repairDecisions(id)).toBe(1);
        expect(github.reads).toEqual([number]);
    });

    it.each([
        ['pending checks', { checks: checks('pending') }],
        ['missing checks', { checks: [] }],
        ['unknown mergeability', { mergeable: null }],
        ['a pending review', { requiredApprovals: 1, approvals: 0 }],
    ] as const)('waits on %s without a repair or a budget charge', async (_what, extra) => {
        const { id } = await observedAs(extra);

        await store.reconcile(id);

        expect(await repairsOf(id)).toEqual([]);
        expect(await repairDecisions(id)).toBe(0);
        expect(await taskOf(id)).toMatchObject({ execution: 'succeeded', gate: 'open', attention: null });
    });

    it('a target that moved under a clean PR re-reads it and repairs nothing', async () => {
        const { id, number } = await observedAs({});
        github.replies.set(number, facts(number, { targetSha: 't2' }));
        clock.ms += 61_000;
        await observer.observeDue();

        await store.reconcile(id);

        expect(await only(id)).toMatchObject({ targetSha: 't2', outcome: 'ready', revision: 2 });
        expect(await repairsOf(id)).toEqual([]);
        expect(await repairDecisions(id)).toBe(0);
    });

    it('never acts on a row a hint marked stale', async () => {
        const { id, number } = await observedAs({ checks: checks('failing') });
        await requestRefresh({ sql, orgId: ORG, now }, { repo: REPO, numbers: [number] });

        await store.reconcile(id);

        expect(await repairsOf(id)).toEqual([]);
        expect(await repairDecisions(id)).toBe(0);
    });

    it('parks the task for a person when its repairs are spent, and its sibling still launches', async () => {
        const id = await frozen(
            plan([{ key: 'one', tasks: [prTask('a'), prTask('b')] }], { concurrency: 1, repairs: 0 })
        );
        await store.reconcile(id);
        const root = await rootOf(id, 'a');
        const number = await publish(root);
        await setSucceeded(sql, root);
        await store.reconcile(id);
        github.replies.set(number, facts(number, { checks: checks('failing') }));
        await observer.observeDue();

        await store.reconcile(id);

        expect(await repairsOf(id)).toEqual([]);
        const a = await taskOf(id);
        expect(a).toMatchObject({ execution: 'succeeded', gate: 'open', attention: 'budget' });
        expect(a.waitReason).toContain('recovery budget exhausted');
        expect(await taskOf(id, 'b')).toMatchObject({ execution: 'queued', attempt: 1 });

        // The gate's own wait reason does not overwrite the person's reason on a later pass.
        await store.reconcile(id);
        expect((await taskOf(id)).waitReason).toBe(a.waitReason);
    });

    it('counts a spent repair from the attempt rows: a second failing PR after one repair needs a person', async () => {
        const id = await frozen(plan([{ key: 'one', tasks: [prTask('a')] }], { repairs: 1 }));
        await store.reconcile(id);
        const root = await rootOf(id, 'a');
        const number = await publish(root);
        await setSucceeded(sql, root);
        await store.reconcile(id);
        github.replies.set(number, facts(number, { checks: checks('failing') }));
        await observer.observeDue();
        await store.reconcile(id);
        expect(await repairsOf(id)).toHaveLength(1);

        await setSucceeded(sql, root);
        await store.reconcile(id);
        github.replies.set(number, facts(number, { headSha: 'h2', checks: checks('failing') }));
        clock.ms += 61_000;
        await observer.observeDue();
        await store.reconcile(id);

        expect(await repairsOf(id)).toHaveLength(1);
        expect(await taskOf(id)).toMatchObject({ execution: 'succeeded', attention: 'budget' });
    });

    it('repairs nothing in a cancelled batch', async () => {
        const { id, number } = await succeededWithPr();
        await store.cancel(id, ALICE);
        github.replies.set(number, facts(number, { checks: checks('failing') }));
        await observer.observeDue();
        const jobsBefore = await jobCount();

        await store.reconcile(id);

        expect(await repairsOf(id)).toEqual([]);
        expect(await repairDecisions(id)).toBe(0);
        expect(await jobCount()).toBe(jobsBefore);
    });

    it('repairs nothing once the time limit expired', async () => {
        const timed = createBatchStore({ sql, orgId: ORG, stop: (id, by) => jobs.stop(id, by), now });
        const timedObserver = observerFor(ORG, jobs, timed);
        const id = await frozen(plan([{ key: 'one', tasks: [prTask('a')] }], { timeLimitMinutes: 1 }), timed);
        await timed.reconcile(id);
        const root = await rootOf(id, 'a', timed);
        const number = await publish(root);
        await setSucceeded(sql, root);
        await timed.reconcile(id);
        github.replies.set(number, facts(number, { checks: checks('failing') }));
        await timedObserver.observeDue();

        clock.ms += 120_000;
        await timed.reconcile(id);

        expect((await timed.get(id))!.expiredAt).not.toBeNull();
        expect(await repairsOf(id)).toEqual([]);
        expect(await repairDecisions(id)).toBe(0);
    });

    it('awaits the repaired head’s own observation, and an earlier merge does not pass its gate', async () => {
        const { id, root, number } = await observedAs({ checks: checks('failing') });
        await store.reconcile(id);
        expect(await repairsOf(id)).toHaveLength(1);

        // The repair is running: its PR is not read, and the old failure is gone.
        clock.ms += 61_000;
        await observer.observeDue();
        expect(await observer.list(id)).toEqual([]);

        await setSucceeded(sql, root);
        await store.reconcile(id);
        expect(await repairsOf(id)).toHaveLength(1);
        expect(await taskOf(id)).toMatchObject({ execution: 'succeeded', gate: 'open', attention: null });

        // A merge stamped before the repair began is about the old head.
        await jobs.closeMergedPr(REPO, number, randomUUID(), new Date(Date.now() - 3_600_000));
        await store.reconcile(id);
        expect(await taskOf(id)).toMatchObject({ gate: 'open' });
        expect(await repairsOf(id)).toHaveLength(1);
    });

    /** Task a's repair is decided but b holds the only slot; then a hint makes a's evidence stale and b finishes. */
    async function repairWithdrawnOnStaleEvidence() {
        const id = await frozen(plan([{ key: 'one', tasks: [prTask('a'), prTask('b')] }], { concurrency: 1 }));
        await store.reconcile(id);
        const root = await rootOf(id, 'a');
        const number = await publish(root);
        await setSucceeded(sql, root);
        await store.reconcile(id);
        github.replies.set(number, facts(number, { checks: checks('failing') }));
        await observer.observeDue();
        await store.reconcile(id);
        expect(await taskOf(id)).toMatchObject({ execution: 'retry' });
        expect(await repairsOf(id)).toEqual([]);

        await requestRefresh({ sql, orgId: ORG, now }, { repo: REPO, numbers: [number] });
        await setSucceeded(sql, await rootOf(id, 'b'));
        await store.reconcile(id);
        return { id, number };
    }

    it('withdraws an undispatched repair whose evidence went stale, charging nothing', async () => {
        const { id } = await repairWithdrawnOnStaleEvidence();

        expect(await repairsOf(id)).toEqual([]);
        expect(await repairDecisions(id)).toBe(0);
        expect(await taskOf(id)).toMatchObject({ execution: 'succeeded', gate: 'open', attention: null });
        const launches = await sql`select 1 from batch_decision where batch_id = ${id} and key like 'launch:a:%'`;
        expect(launches).toHaveLength(1);
    });

    it.each([
        ['confirms the same failure', { checks: checks('failing') }, 1],
        ['finds the checks passing', { headSha: 'h2' }, 0],
    ] as const)('after a withdrawal, a refresh that %s decides afresh', async (_what, extra, repairs) => {
        const { id, number } = await repairWithdrawnOnStaleEvidence();
        github.replies.set(number, facts(number, extra));

        await observer.observeDue();
        await store.reconcile(id);

        expect(await repairsOf(id)).toHaveLength(repairs);
    });

    /** Task a's repair is decided but b holds the only slot. */
    async function repairWaitingForSlot() {
        const id = await frozen(plan([{ key: 'one', tasks: [prTask('a'), prTask('b')] }], { concurrency: 1 }));
        await store.reconcile(id);
        const number = await publish(await rootOf(id, 'a'));
        await setSucceeded(sql, await rootOf(id, 'a'));
        await store.reconcile(id);
        github.replies.set(number, facts(number, { checks: checks('failing') }));
        await observer.observeDue();
        await store.reconcile(id);
        expect(await taskOf(id)).toMatchObject({ execution: 'retry' });
        return { id, number };
    }

    it('keeps reading the PR of a waiting repair: a merge with no hint withdraws it and passes the gate', async () => {
        const { id, number } = await repairWaitingForSlot();
        github.replies.set(number, facts(number, { state: 'closed', merged: true, mergeCommitSha: 'mc7' }));
        clock.ms += 61_000;
        await observer.observeDue();
        expect(await sql`select 1 from pr_merge where pr_number = ${number}`).toHaveLength(1);

        await setSucceeded(sql, await rootOf(id, 'b'));
        await store.reconcile(id);

        expect(await repairsOf(id)).toEqual([]);
        expect(await taskOf(id)).toMatchObject({ execution: 'succeeded', gate: 'passed', attention: null });
    });

    it('withdraws a waiting repair whose PR a delivered merge closed before the row was re-read', async () => {
        const { id, number } = await repairWaitingForSlot();
        await jobs.closeMergedPr(REPO, number, randomUUID());

        await setSucceeded(sql, await rootOf(id, 'b'));
        await store.reconcile(id);

        expect(await repairsOf(id)).toEqual([]);
        expect(await taskOf(id)).toMatchObject({ execution: 'succeeded', gate: 'passed' });
    });

    it('clears a spent-budget attention once the checks pass again, and the report agrees with the gate', async () => {
        const id = await frozen(plan([{ key: 'one', tasks: [prTask('a')] }], { repairs: 0 }));
        await store.reconcile(id);
        const root = await rootOf(id, 'a');
        const number = await publish(root);
        await setSucceeded(sql, root);
        await store.reconcile(id);
        github.replies.set(number, facts(number, { checks: checks('failing') }));
        await observer.observeDue();
        await store.reconcile(id);
        expect(await taskOf(id)).toMatchObject({ attention: 'budget' });

        github.replies.set(number, facts(number));
        clock.ms += 61_000;
        await observer.observeDue();
        await store.reconcile(id);

        const url = `https://github.com/${REPO}/pull/${number}`;
        expect(await taskOf(id)).toMatchObject({ attention: null, waitReason: `waiting for a person to merge ${url}` });
        const reported = (await store.report(id))!.tasks[0]!;
        expect(reported).toMatchObject({
            attention: null,
            waitReason: `waiting for a person to merge ${url}`,
            next: { action: 'merge', url },
        });
    });

    it('parks a PR closed without merging, names it, and clears once it is reopened and merged', async () => {
        const { id, number } = await observedAs({ state: 'closed' });

        await store.reconcile(id);
        const parked = await taskOf(id);
        expect(parked).toMatchObject({ execution: 'succeeded', gate: 'open', attention: 'closed' });
        expect(parked.waitReason).toContain(`https://github.com/${REPO}/pull/${number}`);
        expect(parked.waitReason).toContain('closed without merging');
        expect(await repairsOf(id)).toEqual([]);

        await store.reconcile(id);
        expect(await taskOf(id)).toMatchObject({ attention: 'closed', waitReason: parked.waitReason });

        github.replies.set(number, facts(number, { state: 'closed', merged: true, mergeCommitSha: 'mc9' }));
        clock.ms += 61_000;
        await observer.observeDue();
        await store.reconcile(id);
        expect(await taskOf(id)).toMatchObject({ gate: 'passed', attention: null });
    });

    it('clears the closed attention when the PR is reopened, and the gate waits again', async () => {
        const { id, number } = await observedAs({ state: 'closed' });
        await store.reconcile(id);
        expect(await taskOf(id)).toMatchObject({ attention: 'closed' });

        github.replies.set(number, facts(number));
        clock.ms += 61_000;
        await observer.observeDue();
        await store.reconcile(id);

        const reopened = await taskOf(id);
        expect(reopened).toMatchObject({ attention: null, gate: 'open' });
        expect(reopened.waitReason).toBe(`waiting for a person to merge https://github.com/${REPO}/pull/${number}`);
    });
});
