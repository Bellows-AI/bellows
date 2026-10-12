import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { resolveBatchPlan, validateBatchPlan, type BatchPlan, type PrFacts } from '@factory-ai/core';
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

/**
 * Protected automerge and verified stage progression against a real database (docs/batches.md):
 * the merge intent's fences, the one-request-per-target slot, cancellation and expiry races,
 * restart and the combined verification are SQL, so they are pinned here. GitHub is a fake: it
 * cannot prove how hosted protection or a merge queue behaves, only that the board asks, records
 * and refuses correctly given what the provider answers.
 */

const enabled = Boolean(process.env.DATABASE_URL);

const ORG = 'test-org';
const ALICE = '00000000-0000-4000-8000-00000000ba71';
const REPO = 'acme/web';
const HOURS = 3_600_000;

const db = useTestDb({ orgs: [ORG], users: [{ id: ALICE, githubUserId: 90079, login: 'alice' }], max: 10 });

let sql: Sql;
let jobs: JobStore;
let prs: PrLifecycleStore;
let store: BatchStore;
let observer: BatchPrObserver;
let merger: BatchMerger;
/** Real time plus an offset the test moves, so a recorded merge is never "before" a row the database stamped. */
const clock = { offset: 0 };
const now = () => new Date(Date.now() + clock.offset);

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
        title: 'Merge',
        targets: [{ key: 'web', repo: REPO }],
        defaultTarget: 'web',
        executor: 'claude',
        concurrency: 2,
        stages,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.plan;
}

async function frozen(source: BatchPlan): Promise<string> {
    const { id } = await store.create(source, ALICE);
    const started = await store.start({
        id,
        version: 1,
        plan: resolveBatchPlan(source, { [REPO]: 'main' }),
        startedBy: ALICE,
    });
    expect(started).toMatchObject({ result: 'ok' });
    return id;
}

const rootOf = async (id: string, key: string) => (await store.get(id))!.tasks.find((t) => t.key === key)!.rootJobId!;

async function setSucceeded(root: string) {
    const [head] = await sql<{ id: string }[]>`
        select id from job where root_job_id = ${root} order by created_at desc, id desc limit 1
    `;
    await sql`update job set status = 'succeeded', finished_at = now(), lease_token = null where id = ${head!.id}`;
}

let nextPr = 4000;
async function publish(root: string): Promise<number> {
    nextPr += 1;
    await prs.recordPublication({
        root,
        repo: REPO,
        prNumber: nextPr,
        prUrl: `https://github.com/${REPO}/pull/${nextPr}`,
        headBranch: `factory/${root}`,
        baseBranch: 'main',
    });
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
    const root = await rootOf(id, key);
    const number = await publish(root);
    await setSucceeded(root);
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

    it('turns a failing combined verification into an attention signal, never a completed stage', async () => {
        github.branch.checks = checks('failing');
        const { id } = await readyBatch(plan([policyStage('automerge', ['a'])]));

        await merger.mergeDue();

        const report = (await store.report(id))!;
        expect(report.verification).toMatchObject([{ stage: 'one', state: 'failed' }]);
        expect(report.verification[0]!.detail).toContain('build');
        expect(report.totals.needsAttention).toBe(1);
        expect(report.state).not.toBe('completed');

        github.branch.checks = checks('passing');
        clock.offset += 2 * 60_000;
        await merger.mergeDue();
        expect((await store.get(id))!.completedAt).not.toBeNull();
    });

    it('fails verification when a merged change is not on the target tip', async () => {
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        github.notOnTarget.add(`m${number}`);

        await merger.mergeDue();

        expect((await store.report(id))!.verification).toMatchObject([{ state: 'failed' }]);
        expect((await store.get(id))!.completedAt).toBeNull();
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

    it('stops without a request when the head moved after it was observed', async () => {
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        github.replies.set(number, facts(number, { headSha: 'h-new' }));

        await merger.mergeDue();

        expect(github.merges).toEqual([]);
        expect(await intents(id)).toMatchObject([{ state: 'changed' }]);
        expect(await task(id, 'a')).toMatchObject({ gate: 'open' });
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

    it('stops without a request when the PR was retargeted or a requirement stopped being met', async () => {
        const { id, number } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        github.replies.set(number, facts(number, { baseBranch: 'release' }));
        await merger.mergeDue();
        expect(github.merges).toEqual([]);
        expect(await intents(id)).toMatchObject([{ state: 'changed' }]);
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

    it('issues no request after a cancel committed', async () => {
        const { id } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        await store.cancel(id, ALICE);

        await merger.mergeDue();

        expect(github.merges).toEqual([]);
        expect(await intents(id)).toEqual([]);
    });

    it('stops a claimed request when a cancel commits between the claim and the send', async () => {
        const { id } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        github.beforeRead = () => store.cancel(id, ALICE);

        await merger.mergeDue();

        expect(github.merges).toEqual([]);
        expect(await intents(id)).toMatchObject([{ state: 'fenced' }]);
    });

    it('issues no request once the time limit expired, and the expired batch is not reactivated by a delayed observation', async () => {
        const { id } = await readyBatch(plan([policyStage('automerge', ['a'])]));
        clock.offset += 13 * HOURS;
        await store.reconcile(id);
        expect((await store.get(id))!.expiredAt).not.toBeNull();

        await merger.mergeDue();

        expect(github.merges).toEqual([]);
        expect(await intents(id)).toEqual([]);
        expect((await store.get(id))!.completedAt).toBeNull();
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
