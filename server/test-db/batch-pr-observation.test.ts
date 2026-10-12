import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { resolveBatchPlan, validateBatchPlan, type BatchPlan, type PrFacts } from '@factory-ai/core';
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
    observer = observerFor(ORG, jobs, store);
});

beforeEach(() => {
    github.replies.clear();
    github.reads.length = 0;
    clock.ms = Date.now();
});

const prTask = (key: string) => ({
    key,
    objective: `do ${key}`,
    acceptance: `${key} works`,
    verification: 'npm test',
    completion: { kind: 'pr' },
});

function plan(stages: Record<string, unknown>[]): BatchPlan {
    const result = validateBatchPlan({
        planVersion: 1,
        title: 'Observe',
        targets: [{ key: 'web', repo: REPO }],
        defaultTarget: 'web',
        executor: 'claude',
        concurrency: 2,
        stages,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.plan;
}

async function frozen(source: BatchPlan, target: BatchStore = store): Promise<string> {
    const { id } = await target.create(source, ALICE);
    const started = await target.start({
        id,
        version: 1,
        plan: resolveBatchPlan(source, { [REPO]: 'main' }),
        startedBy: ALICE,
    });
    expect(started).toMatchObject({ result: 'ok' });
    return id;
}

async function rootOf(id: string, key: string, target: BatchStore = store): Promise<string> {
    const record = (await target.get(id))!;
    return record.tasks.find((t) => t.key === key)!.rootJobId!;
}

async function setSucceeded(root: string) {
    const [head] = await sql<{ id: string }[]>`
        select id from job where root_job_id = ${root} order by created_at desc, id desc limit 1
    `;
    await sql`update job set status = 'succeeded', finished_at = now(), lease_token = null where id = ${head!.id}`;
}

let nextPr = 2000;
async function publish(root: string, store: PrLifecycleStore = prs, repo = REPO): Promise<number> {
    nextPr += 1;
    await store.recordPublication({
        root,
        repo,
        prNumber: nextPr,
        prUrl: `https://github.com/${repo}/pull/${nextPr}`,
        headBranch: `factory/${root}`,
        baseBranch: 'main',
    });
    return nextPr;
}

const checks = (state: 'passing' | 'failing' | 'pending') => [
    { name: 'build', state, url: 'https://ci/1', detail: null },
];

const facts = (number: number, extra: Partial<PrFacts> = {}): PrFacts => ({
    repo: REPO,
    number,
    url: `https://github.com/${REPO}/pull/${number}`,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    baseBranch: 'main',
    headSha: 'h1',
    targetSha: 't1',
    mergeable: true,
    requiredContexts: ['build'],
    requiredApprovals: 0,
    approvals: 0,
    checks: checks('passing'),
    ...extra,
});

const jobCount = async () => Number((await sql`select count(*) from job`)[0]!.count);

/** A one-task batch whose run succeeded and whose PR is published: the state observation exists for. */
async function succeededWithPr() {
    const id = await frozen(plan([{ key: 'one', tasks: [prTask('a')] }]));
    await store.reconcile(id);
    const root = await rootOf(id, 'a');
    const number = await publish(root);
    await setSucceeded(root);
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
        await setSucceeded(root);
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
        await setSucceeded(root);
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
        await setSucceeded(rootOther);
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
