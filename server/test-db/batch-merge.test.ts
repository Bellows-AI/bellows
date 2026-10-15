import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { BatchPlan, PrFacts } from '@factory-ai/core';
import { createBatchMerger, type BatchMerger, type MergeClient } from '../src/batch-merger.js';
import { createBatchPrObserver, type BatchPrObserver } from '../src/batch-pr-observer.js';
import { createBatchStore, type BatchStore } from '../src/db/batch-store.js';
import { claimMerges } from '../src/db/batch-store-merge.js';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { createPrLifecycleStore, type PrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { GitHubMergeError } from '../src/github/pr-merge.js';
import { GitHubReadError, type BranchState } from '../src/github/pr-read.js';
import { useTestDb } from './harness.js';
import { testOrg, testUser } from './fixtures.js';
import { batchPlan, checks, facts, prTask, recordPr, rootOf, setSucceeded, startBatch } from './batch-fixtures.js';

/**
 * Protected automerge and verified stage progression against a real database (docs/batches.md):
 * the merge intent's fences, the one-request-per-target slot, cancellation and expiry races,
 * restart and the combined verification are SQL, so they are pinned here. GitHub is a fake: it
 * cannot prove how hosted protection or a merge queue behaves, only that the board asks, records
 * and refuses correctly given what the provider answers.
 */

const enabled = Boolean(process.env.DATABASE_URL);

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const ALICE = ALICE_USER.id;
const HOURS = 3_600_000;

const db = useTestDb({ orgs: [ORG], users: [ALICE_USER], max: 10 });

let sql: Sql;
let jobs: JobStore;
let prs: PrLifecycleStore;
let store: BatchStore;
let observer: BatchPrObserver;
let merger: BatchMerger;
/** Real time plus an offset the test moves, so a recorded merge is never "before" a row the database stamped. */
const clock = { offset: 0 };
const now = () => new Date(Date.now() + clock.offset);

/** The fake GitHub: what each PR answers, what a merge request does, and the target branch. */
const github = {
    replies: new Map<number, PrFacts | Error>(),
    /** A merge request's behaviour per PR number; absent means GitHub accepts it. */
    mergeFails: new Map<number, GitHubMergeError>(),
    /** When set, a failing merge request still merges on the provider side (a lost response). */
    mergeLands: new Set<number>(),
    reads: [] as number[],
    merges: [] as { number: number; sha: string }[],
    branch: { headSha: 'tip', requiredContexts: ['build'] as string[] | null, checks: checks('passing') } as {
        headSha: string;
        requiredContexts: string[] | null;
        checks: ReturnType<typeof checks>;
    },
    notOnTarget: new Set<string>(),
    /** Runs once, before the next read answers: where a test injects a race. */
    beforeRead: undefined as (() => Promise<unknown>) | undefined,
};

const land = (number: number) => {
    const reply = github.replies.get(number) as PrFacts;
    github.replies.set(
        number,
        facts(number, {
            ...reply,
            state: 'closed',
            merged: true,
            mergedAt: now().toISOString(),
            mergeCommitSha: `m${number}`,
        })
    );
};

const client: MergeClient = {
    async readPullRequest(_repo, number) {
        github.reads.push(number);
        const hook = github.beforeRead;
        github.beforeRead = undefined;
        if (hook) await hook();
        const reply = github.replies.get(number);
        if (reply === undefined) throw new GitHubReadError('not found', 'not_found');
        if (reply instanceof Error) throw reply;
        return reply;
    },
    async mergePullRequest(_repo, number, request) {
        github.merges.push({ number, sha: request.sha });
        const failure = github.mergeFails.get(number);
        if (github.mergeLands.has(number)) land(number);
        if (failure) throw failure;
        land(number);
        return { mergeCommitSha: `m${number}` };
    },
    async readBranchState(_repo, _branch, shas): Promise<BranchState> {
        return {
            headSha: github.branch.headSha,
            contains: Object.fromEntries(shas.map((sha) => [sha, !github.notOnTarget.has(sha)])),
            requiredContexts: github.branch.requiredContexts,
            checks: github.branch.checks,
        };
    },
};

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    prs = createPrLifecycleStore({ sql, orgId: ORG });
    jobs = createJobStore({ sql, orgId: ORG, prs });
    store = createBatchStore({ sql, orgId: ORG, stop: (id, by) => jobs.stop(id, by), now });
    observer = createBatchPrObserver({
        sql,
        orgId: ORG,
        reader: client,
        recordMerge: (repo, number, deliveryId, mergedAt) => jobs.closeMergedPr(repo, number, deliveryId, mergedAt),
        reconcile: (id) => store.reconcile(id),
        now,
    });
    merger = createBatchMerger({
        sql,
        orgId: ORG,
        client,
        recordMerge: (repo, number, deliveryId, mergedAt) => jobs.closeMergedPr(repo, number, deliveryId, mergedAt),
        reconcile: (id) => store.reconcile(id),
        now,
    });
});

beforeEach(() => {
    clock.offset = 0;
    github.replies.clear();
    github.mergeFails.clear();
    github.mergeLands.clear();
    github.reads.length = 0;
    github.merges.length = 0;
    github.beforeRead = undefined;
    github.notOnTarget.clear();
    github.branch = { headSha: 'tip', requiredContexts: ['build'], checks: checks('passing') };
});

const plan = (stages: Record<string, unknown>[]): BatchPlan => batchPlan('Merge', stages);

const frozen = (source: BatchPlan) => startBatch(store, source, ALICE);

let nextPr = 4000;
async function publish(root: string): Promise<number> {
    nextPr += 1;
    await recordPr(prs, root, nextPr);
    return nextPr;
}

const policyStage = (policy: 'automerge' | 'human', keys: string[], stage = 'one') => ({
    key: stage,
    policy,
    tasks: keys.map(prTask),
});

/** A started batch whose first-stage task `key` has succeeded and published a PR the fake GitHub reports ready. */
async function readyBatch(source: BatchPlan, key = 'a') {
    const id = await frozen(source);
    await store.reconcile(id);
    const root = await rootOf(store, id, key);
    const number = await publish(root);
    await setSucceeded(sql, root);
    await store.reconcile(id);
    github.replies.set(number, facts(number));
    await observer.observeDue();
    return { id, root, number };
}

const task = async (id: string, key: string) => (await store.get(id))!.tasks.find((t) => t.key === key)!;
const intents = async (id: string) =>
    sql<{ state: string; observation_revision: string; head_sha: string; task_key: string }[]>`
        select state, observation_revision::text, head_sha, task_key from batch_merge where batch_id = ${id} order by id
    `;

describe.skipIf(!enabled)('automerge', () => {
    it('merges an eligible PR bound to the observed head, passes its gate, and advances only after the combined verification', async () => {
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));

        await merger.mergeDue();

        expect(github.merges).toEqual([{ number, sha: 'h1' }]);
        expect(await intents(id)).toMatchObject([{ state: 'merged', head_sha: 'h1' }]);
        expect(await task(id, 'a')).toMatchObject({ execution: 'succeeded', gate: 'passed' });
        // The stage verified in the same pass, because the target's checks pass and it holds the merge.
        const record = (await store.get(id))!;
        expect(record.completedAt).not.toBeNull();
    });

    it('holds the stage, and the next stage, while the combined checks are pending, then advances', async () => {
        github.branch.checks = checks('pending');
        const source = plan([policyStage('automerge', ['a'], 'one'), policyStage('human', ['b'], 'two')]);
        const { id } = await readyBatch(source);

        await merger.mergeDue();

        expect(await task(id, 'a')).toMatchObject({ gate: 'passed' });
        expect((await store.get(id))!.activeStage).toBe('one');
        expect(await task(id, 'b')).toMatchObject({ execution: 'pending' });
        const report = (await store.report(id))!;
        expect(report.verification).toMatchObject([{ stage: 'one', state: 'pending' }]);

        github.branch.checks = checks('passing');
        clock.offset += 2 * 60_000;
        await merger.mergeDue();

        expect((await store.get(id))!.activeStage).toBe('two');
        expect((await task(id, 'b')).execution).not.toBe('pending');
        expect((await store.report(id))!.verification).toMatchObject([{ stage: 'one', state: 'passed' }]);
    });

    it.each<{
        name: string;
        /** Breaks the verification: before the batch is ready (no number yet), or after with its PR number. */
        breakBefore?: () => void;
        breakAfter?: (number: number) => void;
        verify: (id: string) => Promise<void>;
    }>([
        {
            name: 'turns a failing combined verification into an attention signal, never a completed stage',
            breakBefore: () => {
                github.branch.checks = checks('failing');
            },
            verify: async (id) => {
                const report = (await store.report(id))!;
                expect(report.verification).toMatchObject([{ stage: 'one', state: 'failed' }]);
                expect(report.verification[0]!.detail).toContain('build');
                expect(report.totals.needsAttention).toBe(1);
                expect(report.state).not.toBe('completed');
                // The record a waiting client polls carries the same row, so a wait can stop on it.
                expect((await store.get(id))!.verification).toEqual(report.verification);

                github.branch.checks = checks('passing');
                clock.offset += 2 * 60_000;
                await merger.mergeDue();
                expect((await store.get(id))!.completedAt).not.toBeNull();
            },
        },
        {
            name: 'fails verification when a merged change is not on the target tip',
            breakAfter: (number) => {
                github.notOnTarget.add(`m${number}`);
            },
            verify: async (id) => {
                expect((await store.get(id))!.completedAt).toBeNull();
            },
        },
    ])('$name', async ({ breakBefore, breakAfter, verify }) => {
        breakBefore?.();
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        breakAfter?.(number);

        await merger.mergeDue();

        expect((await store.report(id))!.verification).toMatchObject([{ state: 'failed' }]);
        await verify(id);
    });

    it('issues zero merge requests under the human policy', async () => {
        const { id } = await readyBatch(plan([policyStage('human', ['a'])]));

        await merger.mergeDue();
        clock.offset += 10 * 60_000;
        await merger.mergeDue();

        expect(github.merges).toEqual([]);
        expect(await intents(id)).toEqual([]);
        expect(await task(id, 'a')).toMatchObject({ gate: 'open' });
    });

    it("reports an automerge task's open PR as the board's to merge, not parked, until a refusal hands it to a person (#688)", async () => {
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));

        expect(await store.reconcile(id)).toMatchObject({ active: 0, waiting: 1 });
        const waiting = (await store.report(id))!;
        expect(waiting.state).toBe('running');
        expect(waiting.tasks[0]).toMatchObject({ execution: 'succeeded', gate: 'open', next: { action: 'wait' } });

        github.mergeFails.set(number, new GitHubMergeError('405 required checks', 'refused'));
        await merger.mergeDue();

        expect(await store.reconcile(id)).toMatchObject({ active: 0, waiting: 0 });
        const refused = (await store.report(id))!;
        expect(refused.state).toBe('parked');
        expect(refused.tasks[0]).toMatchObject({ attention: 'refused', next: { action: 'merge' } });
    });

    it('hands an automerge PR waiting on a review to a person: the board does not act on it (#688)', async () => {
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        github.replies.set(number, facts(number, { requiredApprovals: 1 }));
        clock.offset += 61_000;
        await observer.observeDue();

        expect(await store.reconcile(id)).toMatchObject({ active: 0, waiting: 0 });
        const report = (await store.report(id))!;
        expect(report.state).toBe('parked');
        expect(report.tasks[0]).toMatchObject({
            observation: { outcome: 'review_required' },
            next: { action: 'merge' },
        });
        expect(report.tasks[0]!.waitReason).toContain('approving review');
    });

    it('hands an automerge PR the board can no longer read to a person, but waits out a transient read error (#688)', async () => {
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        github.replies.set(number, new GitHubReadError('timed out', 'transport'));
        clock.offset += 61_000;
        await observer.observeDue();
        expect(await store.reconcile(id)).toMatchObject({ waiting: 1 });
        expect((await store.report(id))!.tasks[0]).toMatchObject({ next: { action: 'wait' } });

        github.replies.set(number, new GitHubReadError('no access', 'forbidden'));
        clock.offset += 16 * 60_000;
        await observer.observeDue();

        expect(await store.reconcile(id)).toMatchObject({ active: 0, waiting: 0 });
        const report = (await store.report(id))!;
        expect(report.state).toBe('parked');
        expect(report.tasks[0]).toMatchObject({ next: { action: 'merge' } });
        expect(report.tasks[0]!.waitReason).toContain('cannot be read (forbidden)');
    });

    it("names what blocks the board now, not an earlier merge request's outcome (#688)", async () => {
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        github.mergeFails.set(number, new GitHubMergeError('405 required checks', 'refused'));
        await merger.mergeDue();
        expect((await task(id, 'a')).waitReason).toContain('merge refused');

        github.replies.set(number, facts(number, { headSha: 'h2', requiredApprovals: 1 }));
        clock.offset += 61_000;
        await observer.observeDue();
        await store.reconcile(id);

        const report = (await store.report(id))!;
        expect(report.tasks[0]).toMatchObject({ next: { action: 'merge' } });
        expect(report.tasks[0]!.waitReason).toContain('approving review');
    });

    it("hands an optional task's open PR to a person once its stage advanced without it (#688)", async () => {
        const optional = { ...prTask('b'), required: false };
        const source = plan([{ key: 'one', policy: 'automerge', tasks: [prTask('a'), optional] }]);
        const { id } = await readyBatch(source);
        const pending = await publish(await rootOf(store, id, 'b'));
        await setSucceeded(sql, await rootOf(store, id, 'b'));
        github.replies.set(pending, facts(pending, { checks: checks('pending') }));
        await store.reconcile(id);
        await observer.observeDue();
        expect((await store.report(id))!.tasks[1]).toMatchObject({ next: { action: 'wait' } });

        await merger.mergeDue();
        await store.reconcile(id);

        const report = (await store.report(id))!;
        expect(report.tasks[0]).toMatchObject({ gate: 'passed' });
        expect(report.tasks[1]).toMatchObject({ gate: 'open', next: { action: 'merge' } });
    });

    it("reports a human stage's open PR as a person's to merge, and the batch parked", async () => {
        const { id } = await readyBatch(plan([policyStage('human', ['a'])]));

        expect(await store.reconcile(id)).toMatchObject({ active: 0, waiting: 0 });
        const report = (await store.report(id))!;
        expect(report.state).toBe('parked');
        expect(report.tasks[0]).toMatchObject({ next: { action: 'merge' } });
    });

    it('refuses to merge past a protection GitHub enforces, parks the task, and does not repeat the same observation', async () => {
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        github.mergeFails.set(number, new GitHubMergeError('405 required checks', 'refused'));

        await merger.mergeDue();

        expect(await intents(id)).toMatchObject([{ state: 'refused' }]);
        expect(await task(id, 'a')).toMatchObject({ gate: 'open', attention: 'refused' });
        expect((await task(id, 'a')).waitReason).toContain('merge refused');

        clock.offset += 10 * 60_000;
        await merger.mergeDue();
        expect(github.merges).toHaveLength(1);

        // A new observation (the head moved) is new evidence: it may be asked again.
        github.mergeFails.delete(number);
        github.replies.set(number, facts(number, { headSha: 'h2' }));
        clock.offset += 61_000;
        await observer.observeDue();
        await merger.mergeDue();
        expect(github.merges).toEqual([
            { number, sha: 'h1' },
            { number, sha: 'h2' },
        ]);
        expect(await task(id, 'a')).toMatchObject({ gate: 'passed', attention: null });
    });

    it('does not merge a PR whose checks are not passing or whose observation is stale', async () => {
        const failing = await readyBatch(plan([policyStage('automerge', ['a'])]));
        github.replies.set(failing.number, facts(failing.number, { checks: checks('pending') }));
        clock.offset += 61_000;
        await observer.observeDue();
        await merger.mergeDue();
        expect(github.merges).toEqual([]);

        github.replies.set(failing.number, facts(failing.number));
        clock.offset += 61_000;
        await observer.observeDue();
        await sql`update batch_pr_observation set stale = true`;
        await merger.mergeDue();
        expect(github.merges).toEqual([]);
        expect(await intents(failing.id)).toEqual([]);
    });

    it.each<{ name: string; moved: Partial<PrFacts>; gateStaysOpen: boolean }>([
        {
            name: 'stops without a request when the head moved after it was observed',
            moved: { headSha: 'h-new' },
            gateStaysOpen: true,
        },
        {
            name: 'stops without a request when the PR was retargeted or a requirement stopped being met',
            moved: { baseBranch: 'release' },
            gateStaysOpen: false,
        },
    ])('$name', async ({ moved, gateStaysOpen }) => {
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        github.replies.set(number, facts(number, moved));

        await merger.mergeDue();

        expect(github.merges).toEqual([]);
        expect(await intents(id)).toMatchObject([{ state: 'changed' }]);
        if (gateStaysOpen) expect(await task(id, 'a')).toMatchObject({ gate: 'open' });
    });

    it('asks again after a backoff when the recheck changed but the observation did not, and parks after the tries are spent', async () => {
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        github.replies.set(number, facts(number, { mergeable: null }));
        await merger.mergeDue();
        expect(await intents(id)).toMatchObject([{ state: 'changed' }]);
        expect(github.merges).toEqual([]);

        // GitHub finished computing mergeability: the same observation is eligible again after the backoff.
        github.replies.set(number, facts(number));
        clock.offset += HOURS;
        await merger.mergeDue();
        expect(github.merges).toEqual([{ number, sha: 'h1' }]);
        expect(await task(id, 'a')).toMatchObject({ gate: 'passed' });
    });

    it('reconciles a PR a person merged first instead of requesting again', async () => {
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        land(number);

        await merger.mergeDue();

        expect(github.merges).toEqual([]);
        expect(await intents(id)).toMatchObject([{ state: 'merged' }]);
        expect(await task(id, 'a')).toMatchObject({ gate: 'passed' });
    });

    it('serializes merges to one repository and target across batches', async () => {
        const first = await readyBatch(plan([policyStage('automerge', ['a'])]));
        const second = await readyBatch(plan([policyStage('automerge', ['a'])]));
        github.mergeFails.set(first.number, new GitHubMergeError('timeout', 'uncertain'));

        await merger.mergeDue();

        // The first request's answer is unknown, so it holds the target: the second batch waits.
        expect(github.merges).toEqual([{ number: first.number, sha: 'h1' }]);
        expect(await intents(first.id)).toMatchObject([{ state: 'uncertain' }]);
        expect(await intents(second.id)).toEqual([]);

        // Once the first is reconciled (never accepted) the target is free again for the other batch.
        github.mergeFails.delete(first.number);
        await merger.mergeDue();
        expect(await intents(first.id)).toMatchObject([{ state: 'lapsed' }]);
        expect(github.merges).toEqual([
            { number: first.number, sha: 'h1' },
            { number: second.number, sha: 'h1' },
        ]);
        expect(await task(second.id, 'a')).toMatchObject({ gate: 'passed' });
    });

    it('never has two unresolved requests for one target, even when claimed together', async () => {
        const first = await readyBatch(plan([policyStage('automerge', ['a'])]));
        const second = await readyBatch(plan([policyStage('automerge', ['a'])]));

        const claimed = await claimMerges({ sql, orgId: ORG, now }, 4);

        expect(claimed).toHaveLength(1);
        expect([first.id, second.id]).toContain(claimed[0]!.batchId);
    });

    it('reconciles an uncertain request against the PR: a lost response that merged is recorded, not repeated', async () => {
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        github.mergeFails.set(number, new GitHubMergeError('connection reset', 'uncertain'));
        github.mergeLands.add(number);

        await merger.mergeDue();
        expect(github.merges).toHaveLength(1);

        clock.offset += 10 * 60_000;
        await merger.mergeDue();

        expect(github.merges).toHaveLength(1);
        expect(await intents(id)).toMatchObject([{ state: 'merged' }]);
        expect(await task(id, 'a')).toMatchObject({ gate: 'passed' });
    });

    it('treats an uncertain request that did not merge as never accepted, and may ask again after backoff', async () => {
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        github.mergeFails.set(number, new GitHubMergeError('bad gateway', 'uncertain'));

        await merger.mergeDue();
        expect(await intents(id)).toMatchObject([{ state: 'uncertain' }]);
        // The next pass reads the PR back instead of asking again: still open, so never accepted.
        await merger.mergeDue();
        expect(await intents(id)).toMatchObject([{ state: 'lapsed' }]);
        // Inside the backoff nothing is asked.
        await merger.mergeDue();
        expect(github.merges).toHaveLength(1);

        github.mergeFails.delete(number);
        clock.offset += HOURS;
        await merger.mergeDue();

        expect(github.merges).toHaveLength(2);
        expect(await task(id, 'a')).toMatchObject({ gate: 'passed' });
    });

    it('reconciles an intent a dead process left dispatching, and never sends the request again itself', async () => {
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        const claimed = await claimMerges({ sql, orgId: ORG, now }, 1);
        expect(claimed).toHaveLength(1);
        // The process died here: the intent stands, its lease runs out, the provider merged it.
        land(number);
        clock.offset += HOURS;

        await merger.mergeDue();

        expect(github.merges).toEqual([]);
        expect(await intents(id)).toMatchObject([{ state: 'merged' }]);
        expect(await task(id, 'a')).toMatchObject({ gate: 'passed' });
    });

    it('records a dispatching intent left by a dead process as never accepted when the PR is still open', async () => {
        const { id } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        await claimMerges({ sql, orgId: ORG, now }, 1);
        clock.offset += HOURS;

        await merger.mergeDue();

        expect(await intents(id)).toMatchObject([{ state: 'lapsed' }]);
    });

    // Fenced before the claim: the pass finds nothing to claim, so no request and no intent row.
    it.each<{ name: string; fence: (id: string) => Promise<void>; after?: (id: string) => Promise<void> }>([
        {
            name: 'issues no request after a cancel committed',
            fence: async (id) => {
                await store.cancel(id, ALICE);
            },
        },
        {
            name: 'issues no request once the time limit expired, and the expired batch is not reactivated by a delayed observation',
            fence: async (id) => {
                clock.offset += 13 * HOURS;
                await store.reconcile(id);
                expect((await store.get(id))!.expiredAt).not.toBeNull();
            },
            after: async (id) => {
                expect((await store.get(id))!.completedAt).toBeNull();
            },
        },
        {
            name: 'issues no request once the deadline passed, before any pass stamped the expiry',
            fence: async () => {
                clock.offset += 13 * HOURS;
            },
            after: async (id) => {
                const [batch] = await sql<{ expired_at: Date | null }[]>`select expired_at from batch where id = ${id}`;
                expect(batch!.expired_at).toBeNull();
            },
        },
    ])('$name', async ({ fence, after }) => {
        const { id } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        await fence(id);

        await merger.mergeDue();

        expect(github.merges).toEqual([]);
        expect(await intents(id)).toEqual([]);
        await after?.(id);
    });

    // Fenced between the claim and the send: the claimed intent settles fenced, never sent.
    it.each<{ name: string; fence: (id: string) => () => Promise<unknown> }>([
        {
            name: 'stops a claimed request when a cancel commits between the claim and the send',
            fence: (id) => () => store.cancel(id, ALICE),
        },
        {
            name: 'stops a claimed request whose deadline passes between the claim and the send',
            fence: () => async () => {
                clock.offset += 13 * HOURS;
            },
        },
    ])('$name', async ({ fence }) => {
        const { id } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        github.beforeRead = fence(id);

        await merger.mergeDue();

        expect(github.merges).toEqual([]);
        expect(await intents(id)).toMatchObject([{ state: 'fenced' }]);
    });

    it('records a merge the provider accepted before the fence, without advancing a fenced batch', async () => {
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        const [claimed] = await claimMerges({ sql, orgId: ORG, now }, 1);
        expect(claimed).toBeDefined();
        await store.cancel(id, ALICE);
        land(number);
        clock.offset += HOURS;

        await merger.mergeDue();

        expect(await intents(id)).toMatchObject([{ state: 'merged' }]);
        expect((await store.get(id))!.completedAt).toBeNull();
    });

    it('merges only the active stage and never a task whose stage already advanced', async () => {
        const source = plan([policyStage('automerge', ['a'], 'one'), policyStage('automerge', ['b'], 'two')]);
        const { id } = await readyBatch(source);

        await merger.mergeDue();

        expect((await intents(id)).map((row) => row.task_key)).toEqual(['a']);
    });
});
