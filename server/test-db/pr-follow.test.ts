import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { PrFacts } from '@factory-ai/core';
import type { PrReader } from '../src/batch-pr-observer.js';
import { createBatchStore } from '../src/db/batches/batch-store.js';
import type { BatchStore } from '../src/db/batches/batch-store-types.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { createPrLifecycleStore, type PrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import type { WorkflowDefinition } from '../src/db/workflows/workflow-schema.js';
import { GitHubReadError } from '../src/github/pr-read.js';
import { createPrFollower, type PrFollower } from '../src/pr-follower.js';
import { useTestDb } from './harness.js';
import { mustCreate, testOrg, testUser } from './fixtures.js';
import {
    batchPlan,
    checks,
    facts as batchFacts,
    prTask,
    recordPr,
    rootOf,
    setSucceeded,
    startBatch,
} from './batch-fixtures.js';

/**
 * The PR follower against a real database (docs/workflows.md, docs/architecture.md): the periodic
 * read that makes the two webhook-only paths converge without the webhook. GitHub is a fake
 * reader; every test here delivers NO webhook unless it says so. What the fake cannot prove is the
 * installation's real rate limit, only that the board stops reading once told to.
 */

const enabled = Boolean(process.env.DATABASE_URL);

const ORG = testOrg();
const OTHER = testOrg();
const ALICE = testUser('alice-follow');
const REPO = 'acme/widgets';
const WORKER = 'worker-1';
const LEASE_SECONDS = 300;
const MINUTE = 60_000;

const db = useTestDb({ orgs: [ORG, OTHER], users: [ALICE], max: 10 });

/** entry (publish: true) -> review (a `pr-delivery-wait` boundary): the parked review-wait shape. */
const waitingWorkflow: WorkflowDefinition = {
    entry: 'verify',
    params: [],
    nodes: [
        { name: 'verify', kind: 'agent', session: 'fresh', publish: true, prompt: 'verify' },
        {
            name: 'review',
            kind: 'agent',
            session: 'fresh',
            prompt: 'react to review',
            runtime: { runtime: 'pr-delivery-wait', block: 'fake/test-block', params: {} },
        },
    ],
    edges: [{ from: 'verify', to: 'review', when: 'succeeded' }],
};

let sql: Sql;
let prs: PrLifecycleStore;
let jobs: JobStore;
let follower: PrFollower;

/** What the fake GitHub answers per PR number, and which numbers were actually read. */
const github = { replies: new Map<number, PrFacts | Error>(), reads: [] as number[] };
const reader: PrReader = {
    async readPullRequest(_repo, number) {
        github.reads.push(number);
        const reply = github.replies.get(number);
        if (reply === undefined) throw new GitHubReadError('not found', 'not_found');
        if (reply instanceof Error) throw reply;
        return reply;
    },
};

const followerFor = (
    orgId: string,
    jobStore: JobStore,
    lifecycle: PrLifecycleStore,
    options: { concurrency?: number; reader?: PrReader; now?: () => Date } = {}
) =>
    createPrFollower({
        sql,
        orgId,
        reader: options.reader ?? reader,
        prs: lifecycle,
        recordMerge: (repo, number, deliveryId, mergedAt) => jobStore.closeMergedPr(repo, number, deliveryId, mergedAt),
        // The first poll of a new row is spread over the interval in production; a test wants it due.
        spreadMs: 0,
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        ...(options.now === undefined ? {} : { now: options.now }),
    });

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    prs = createPrLifecycleStore({ sql, orgId: ORG });
    jobs = createJobStore({ sql, orgId: ORG, prs });
});

beforeEach(() => {
    github.replies.clear();
    github.reads.length = 0;
    // A follower holds the installation's rate-limit pause in memory; a pause one test earned must not outlive it.
    if (enabled) follower = followerFor(ORG, jobs, prs);
});

let nextPr = 3000;

/** The PR as GitHub reports it: open, with its activity stamped `offsetMs` from now. */
const openPr = (number: number, offsetMs = MINUTE): PrFacts =>
    batchFacts(number, { repo: REPO, updatedAt: new Date(Date.now() + offsetMs).toISOString() });

const mergedPr = (number: number): PrFacts =>
    batchFacts(number, {
        repo: REPO,
        state: 'closed',
        merged: true,
        mergedAt: new Date().toISOString(),
        mergeCommitSha: `m${number}`,
        updatedAt: new Date().toISOString(),
    });

const closedPr = (number: number): PrFacts =>
    batchFacts(number, { repo: REPO, state: 'closed', merged: false, updatedAt: new Date().toISOString() });

/** Makes every followed PR due now, standing in for the interval passing. */
const makeDue = () => sql`update pr_follow set next_poll_at = now() - interval '1 second' where org_id = ${ORG}`;

/** A workflow thread whose entry published `number` and parked on the review wait. */
async function parkedThread(name: string): Promise<{ root: string; number: number }> {
    nextPr += 1;
    const number = nextPr;
    const { id: root } = await mustCreate(
        jobs.create('start the thread', null, {
            repo: REPO,
            executor: null,
            workflow: { id: randomUUID(), name, node: waitingWorkflow.entry, snapshot: waitingWorkflow, params: {} },
        })
    );
    const claim = (await jobs.claim(WORKER, LEASE_SECONDS)) as Claim;
    await jobs.session(claim.id, claim.leaseToken, `sess-${name}`);
    await jobs.complete(claim.id, claim.leaseToken, {
        status: 'succeeded',
        exitCode: 0,
        output: 'published',
        publication: {
            repo: REPO,
            prNumber: number,
            prUrl: `https://github.com/${REPO}/pull/${number}`,
            headBranch: `factory/${root}`,
            baseBranch: 'main',
        },
    });
    return { root, number };
}

/** A workflow-less thread that finished and published `number`: the non-batch thread a merge closes. */
async function plainThread(): Promise<{ root: string; number: number }> {
    nextPr += 1;
    const number = nextPr;
    const { id: root } = await mustCreate(jobs.create('plain work', null, { repo: REPO, executor: null }));
    const claim = (await jobs.claim(WORKER, LEASE_SECONDS)) as Claim;
    await jobs.complete(claim.id, claim.leaseToken, {
        status: 'succeeded',
        exitCode: 0,
        output: 'published',
        publication: {
            repo: REPO,
            prNumber: number,
            prUrl: `https://github.com/${REPO}/pull/${number}`,
            headBranch: `factory/${root}`,
            baseBranch: 'main',
        },
    });
    return { root, number };
}

const doneAtOf = async (root: string): Promise<Date | null> =>
    (await sql<{ done_at: Date | null }[]>`select done_at from job where org_id = ${ORG} and id = ${root}`)[0]!.done_at;

const mergeRows = async (number: number) =>
    sql<{ delivery_id: string }[]>`select delivery_id from pr_merge where org_id = ${ORG} and pr_number = ${number}`;

const followRow = async (number: number) =>
    (
        await sql<{ failures: number; error_code: string | null; next_poll_at: Date }[]>`
        select failures, error_code, next_poll_at from pr_follow
        where org_id = ${ORG} and pr_number = ${number}`
    )[0];

describe.skipIf(!enabled)('PR follower — a lost webhook still converges', () => {
    it('wakes a parked block wait whose PR changed, with no webhook delivered', async () => {
        const { root, number } = await parkedThread('lost-activity');
        github.replies.set(number, openPr(number));
        expect((await prs.waitOf(root))?.pending).toBe(0);

        await follower.observeDue();

        expect(github.reads).toEqual([number]);
        expect((await prs.waitOf(root))?.pending).toBe(1);
        const continuation = (await jobs.claim(WORKER, LEASE_SECONDS)) as Claim | null;
        expect(continuation?.rootJobId).toBe(root);
        expect(continuation?.command).toBe('react to review');
    });

    it('closes a non-batch thread whose PR merged, with no webhook delivered', async () => {
        const { root, number } = await plainThread();
        github.replies.set(number, mergedPr(number));
        expect(await doneAtOf(root)).toBeNull();

        await follower.observeDue();

        expect(await doneAtOf(root)).not.toBeNull();
        expect((await mergeRows(number)).map((row) => row.delivery_id)).toEqual([`observed:m${number}`]);
    });

    it('cancels a parked wait on a merged PR as the merge webhook does', async () => {
        const { root, number } = await parkedThread('lost-merge');
        github.replies.set(number, mergedPr(number));

        await follower.observeDue();

        expect(await prs.waitOf(root)).toMatchObject({ terminalReason: 'pr merged' });
        expect((await prs.waitOf(root))?.cancelledAt).not.toBeNull();
        expect(await doneAtOf(root)).not.toBeNull();
    });

    it('cancels a parked wait on a PR closed unmerged as the close webhook does, and does not close the thread', async () => {
        const { root, number } = await parkedThread('lost-close');
        github.replies.set(number, closedPr(number));

        await follower.observeDue();

        expect(await prs.waitOf(root)).toMatchObject({ terminalReason: 'pr closed' });
        expect(await doneAtOf(root)).toBeNull();
        expect(await mergeRows(number)).toEqual([]);
    });
});

describe.skipIf(!enabled)('PR follower — idempotent beside the webhook', () => {
    it('folds nothing for activity a webhook already folded', async () => {
        const { root, number } = await parkedThread('webhook-first');
        await prs.recordDelivery({
            deliveryId: 'guid-1',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: number,
        });
        // GitHub stamped the activity before the board folded the webhook that reported it.
        github.replies.set(number, openPr(number, -MINUTE));

        await follower.observeDue();

        // The observed delivery is recorded (silence on re-read) but folded into no wait.
        expect(await prs.waitOf(root)).toMatchObject({ pending: 1, lastDeliveryId: 'guid-1' });
    });

    it('folds activity newer than the last webhook fold', async () => {
        const { root, number } = await parkedThread('webhook-then-more');
        await prs.recordDelivery({
            deliveryId: 'guid-2',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: number,
        });
        github.replies.set(number, openPr(number, MINUTE));

        await follower.observeDue();

        expect((await prs.waitOf(root))?.pending).toBe(2);
    });

    it('folds the same facts once however many passes read them', async () => {
        const { root, number } = await parkedThread('repeat');
        github.replies.set(number, openPr(number));

        await follower.observeDue();
        await makeDue();
        await follower.observeDue();
        await makeDue();
        await follower.observeDue();

        expect(github.reads).toEqual([number, number, number]);
        expect((await prs.waitOf(root))?.pending).toBe(1);
    });

    it('does not read a PR whose merge the webhook already recorded', async () => {
        const { root, number } = await plainThread();
        await jobs.closeMergedPr(REPO, number, 'guid-merge');
        github.replies.set(number, mergedPr(number));
        const closedAt = await doneAtOf(root);

        await follower.observeDue();

        expect(github.reads).toEqual([]);
        expect(await doneAtOf(root)).toEqual(closedAt);
        expect((await mergeRows(number)).map((row) => row.delivery_id)).toEqual(['guid-merge']);
    });

    it('applies a merge once when two replicas read it', async () => {
        const { number } = await plainThread();
        github.replies.set(number, mergedPr(number));
        const second = followerFor(ORG, jobs, prs);

        await Promise.all([follower.observeDue(), second.observeDue()]);

        expect(await mergeRows(number)).toHaveLength(1);
    });
});

describe.skipIf(!enabled)('PR follower — a failed read is never an answer', () => {
    it('leaves the wait and the thread alone, records the failure and retries on the backoff', async () => {
        const { root, number } = await parkedThread('flaky');
        github.replies.set(number, new GitHubReadError('boom', 'transport'));

        await follower.observeDue();

        expect((await prs.waitOf(root))?.pending).toBe(0);
        expect((await prs.waitOf(root))?.cancelledAt).toBeNull();
        expect(await doneAtOf(root)).toBeNull();
        const failed = await followRow(number);
        expect(failed).toMatchObject({ failures: 1, error_code: 'transport' });
        expect(failed!.next_poll_at.getTime()).toBeGreaterThan(Date.now());

        // Not due yet: the backoff holds.
        await follower.observeDue();
        expect(github.reads).toEqual([number]);

        // Due again and GitHub answers: the pass converges and the failure count resets.
        github.replies.set(number, mergedPr(number));
        await makeDue();
        await follower.observeDue();
        expect(github.reads).toEqual([number, number]);
        expect(await doneAtOf(root)).not.toBeNull();
    });

    it.each(['not_found', 'forbidden'] as const)('never reads %s as a closed PR', async (kind) => {
        const { root, number } = await parkedThread(`unreadable-${kind}`);
        github.replies.set(number, new GitHubReadError('unreadable', kind));

        await follower.observeDue();

        expect((await prs.waitOf(root))?.cancelledAt).toBeNull();
        expect(await doneAtOf(root)).toBeNull();
        expect(await mergeRows(number)).toEqual([]);
        expect(await followRow(number)).toMatchObject({ failures: 1, error_code: kind });
    });

    it('stops the whole pass at a rate limit and reads nothing more until it lifts', async () => {
        const first = await plainThread();
        const second = await plainThread();
        const limited = new GitHubReadError('limited', 'rate_limited', MINUTE);
        github.replies.set(first.number, limited);
        github.replies.set(second.number, limited);
        const single = followerFor(ORG, jobs, prs, { concurrency: 1 });

        await single.observeDue();

        expect(github.reads).toHaveLength(1);
        await makeDue();
        await single.observeDue();
        expect(github.reads).toHaveLength(1);
    });
});

describe.skipIf(!enabled)('PR follower — what it reads', () => {
    it('reads a PR at most once per interval', async () => {
        const { number } = await parkedThread('cadence');
        github.replies.set(number, openPr(number, -MINUTE));

        await follower.observeDue();
        await follower.observeDue();

        expect(github.reads).toEqual([number]);
        expect((await followRow(number))!.next_poll_at.getTime()).toBeGreaterThan(Date.now() + MINUTE);
    });

    it('does not read a thread that is already done', async () => {
        const { root } = await plainThread();
        await jobs.markDone(root, null);

        await follower.observeDue();

        expect(github.reads).toEqual([]);
    });

    it('leaves a batch task PR to the batch observer', async () => {
        const batches: BatchStore = createBatchStore({ sql, orgId: ORG, stop: (id, by) => jobs.stop(id, by) });
        const id = await startBatch(batches, batchPlan('Follow', [{ key: 'one', tasks: [prTask('a')] }]), ALICE.id);
        await batches.reconcile(id);
        const root = await rootOf(batches, id, 'a');
        nextPr += 1;
        await recordPr(prs, root, nextPr, { repo: REPO });
        await setSucceeded(sql, root);
        github.replies.set(nextPr, openPr(nextPr));

        await follower.observeDue();

        expect(github.reads).toEqual([]);
    });

    it("never reads another organization's PR", async () => {
        const otherPrs = createPrLifecycleStore({ sql, orgId: OTHER });
        const otherJobs = createJobStore({ sql, orgId: OTHER, prs: otherPrs });
        const { id: root } = await mustCreate(otherJobs.create('other org work', null, { repo: REPO, executor: null }));
        const claim = (await otherJobs.claim('worker-other', LEASE_SECONDS)) as Claim;
        await otherJobs.complete(claim.id, claim.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'published',
            publication: {
                repo: REPO,
                prNumber: 9100,
                prUrl: `https://github.com/${REPO}/pull/9100`,
                headBranch: `factory/${root}`,
                baseBranch: 'main',
            },
        });
        github.replies.set(9100, mergedPr(9100));

        await follower.observeDue();
        expect(github.reads).toEqual([]);

        await followerFor(OTHER, otherJobs, otherPrs).observeDue();
        expect(github.reads).toEqual([9100]);
    });

    it('forgets a PR no thread or wait follows any more', async () => {
        const { root, number } = await plainThread();
        github.replies.set(number, openPr(number, -MINUTE));
        await follower.observeDue();
        expect(await followRow(number)).toBeDefined();

        await jobs.markDone(root, null);
        await makeDue();
        await follower.observeDue();

        expect(await followRow(number)).toBeUndefined();
        expect(github.reads).toEqual([number]);
    });
});

describe.skipIf(!enabled)('PR follower — effects belong to the current claim', () => {
    it('applies nothing for a read taken by an owner whose lease another replica has since replaced', async () => {
        const { root, number } = await parkedThread('stale-owner');
        let release: (facts: PrFacts) => void = () => {};
        const stalled: PrReader = {
            readPullRequest: () => new Promise<PrFacts>((resolve) => (release = resolve)),
        };
        const stale = followerFor(ORG, jobs, prs, { reader: stalled });
        const pending = stale.observeDue();
        while ((await sql`select 1 from pr_follow where claim_token is not null`).length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        // The stalled owner's lease lapses; another replica reads the PR reopened and commits.
        await sql`update pr_follow set claimed_until = now() - interval '1 second'`;
        github.replies.set(number, openPr(number, -MINUTE));
        await follower.observeDue();
        expect(github.reads).toEqual([number]);

        release(closedPr(number));
        await pending;

        expect((await prs.waitOf(root))?.cancelledAt).toBeNull();
    });
});

describe.skipIf(!enabled)('PR follower — it never stops following a live thread', () => {
    it('catches a merge after the PR sat closed unmerged for days', async () => {
        const { root, number } = await plainThread();
        github.replies.set(number, closedPr(number));
        await follower.observeDue();
        expect(await doneAtOf(root)).toBeNull();
        expect((await followRow(number))!.next_poll_at.getTime()).toBeGreaterThan(Date.now());

        // The PR is reopened and merged days later, both webhooks lost.
        github.replies.set(number, mergedPr(number));
        const later = () => new Date(Date.now() + 5 * 24 * 60 * MINUTE);
        await followerFor(ORG, jobs, prs, { now: later }).observeDue();

        expect(await doneAtOf(root)).not.toBeNull();
    });
});

describe.skipIf(!enabled)('PR follower — activity is consumed per wait', () => {
    it('folds activity seen before the wait existed once the wait is open', async () => {
        const { root, number } = await plainThread();
        github.replies.set(number, openPr(number));
        await follower.observeDue();

        // The wait commits after the follower already read this activity.
        await prs.enterWait({ root, reason: 'review', repo: REPO, prNumber: number });
        await makeDue();
        await follower.observeDue();

        expect((await prs.waitOf(root))?.pending).toBe(1);
    });

    it('folds activity GitHub stamped in the same second the wait began', async () => {
        const { root, number } = await plainThread();
        await prs.enterWait({ root, reason: 'review', repo: REPO, prNumber: number });
        const [row] = await sql<{ active_at: Date }[]>`
            select active_at from workflow_wait where org_id = ${ORG} and root_job_id = ${root}`;
        const activeAt = row!.active_at;
        // Second resolution: an event 800 ms after the wait began is stamped with the second's start.
        const stamp = new Date(Math.floor(activeAt.getTime() / 1000) * 1000).toISOString();
        github.replies.set(number, batchFacts(number, { repo: REPO, updatedAt: stamp }));

        await follower.observeDue();

        expect((await prs.waitOf(root))?.pending).toBe(1);
    });
});

describe.skipIf(!enabled)('PR follower — the cursor identifies what was observed', () => {
    it.each([
        ['the wait stays open while the continuation runs', false],
        ['the wait is finished and entered again', true],
    ])('wakes the wait for a second activity in the same provider second when %s', async (_label, reenter) => {
        const { root, number } = await plainThread();
        await prs.enterWait({ root, reason: 'review', repo: REPO, prNumber: number });
        const stamp = new Date(Math.floor(Date.now() / 1000) * 1000 + MINUTE).toISOString();
        github.replies.set(number, batchFacts(number, { repo: REPO, updatedAt: stamp, checks: checks('passing') }));
        await follower.observeDue();
        expect((await prs.waitOf(root))?.pending).toBe(1);

        // Activity A woke a continuation that collected the PR.
        await prs.claimReview(root, 'review');
        if (reenter) {
            await prs.finishWait(root, 'review', 'collected');
            await prs.enterWait({ root, reason: 'review', repo: REPO, prNumber: number });
        }
        expect((await prs.waitOf(root))?.pending).toBe(0);

        // Activity B lands in the same provider second; its webhook is lost.
        github.replies.set(number, batchFacts(number, { repo: REPO, updatedAt: stamp, checks: checks('failing') }));
        await makeDue();
        await follower.observeDue();

        expect((await prs.waitOf(root))?.pending).toBe(1);
    });

    it('wakes a re-entered wait for activity after a webhook woke the previous continuation', async () => {
        const { root, number } = await plainThread();
        await prs.enterWait({ root, reason: 'review', repo: REPO, prNumber: number });
        // Webhook A wakes a continuation, which exits the block.
        await prs.recordDelivery({
            deliveryId: 'guid-a',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: number,
        });
        await prs.claimReview(root, 'review');
        await prs.finishWait(root, 'review', 'collected');
        // Activity B changes the PR after that; its webhook is lost; the workflow re-enters the wait later.
        const stamp = new Date().toISOString();
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await prs.enterWait({ root, reason: 'review', repo: REPO, prNumber: number });
        github.replies.set(number, batchFacts(number, { repo: REPO, updatedAt: stamp, headSha: 'h2' }));

        await follower.observeDue();
        expect((await prs.waitOf(root))?.pending).toBe(1);

        // The same facts never wake it again.
        await makeDue();
        await follower.observeDue();
        expect((await prs.waitOf(root))?.pending).toBe(1);
    });

    it('wakes nothing when an unchanged PR is read again and again', async () => {
        const { root, number } = await plainThread();
        await prs.enterWait({ root, reason: 'review', repo: REPO, prNumber: number });
        github.replies.set(number, openPr(number));
        for (let pass = 0; pass < 5; pass += 1) {
            await follower.observeDue();
            await makeDue();
        }
        expect(github.reads).toHaveLength(5);
        expect((await prs.waitOf(root))?.pending).toBe(1);
    });
});
