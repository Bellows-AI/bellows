import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
    formatRepoRef,
    githubRepo,
    resolveBatchPlan,
    type BatchPlan,
    type PrFacts,
    type RepoRef,
} from '@factory-ai/core';
import { createBatchMerger, type BatchMerger } from '../src/batch-merger.js';
import { createBatchPrObserver, type BatchPrObserver } from '../src/batch-pr-observer.js';
import { createBatchStore } from '../src/db/batches/batch-store.js';
import type { BatchStore } from '../src/db/batches/batch-store-types.js';
import { claimMerges } from '../src/db/batches/batch-store-merge.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { createPrLifecycleStore, type PrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { GitHubReadError } from '../src/github/pr-read.js';
import { useTestDb } from './harness.js';
import { REPO_VARIANTS } from './repo-variants.js';
import { testOrg, testUser } from './fixtures.js';
import { BATCH_REPO, batchPlan, facts, prTask, recordPr, rootOf, setSucceeded } from './batch-fixtures.js';
import type { GitHubAppClient } from '../src/github/app-client.js';
import { githubForge } from '../test/helpers-forge.js';
import { recordingForge } from '../test/helpers-recording-forge.js';

/**
 * Batch rows carry and key by the repository triple (forge, host, path), against a real database. A target is made
 * non-GitHub by raw SQL, since no edge creates one yet; every isolation case moves the forge and the host
 * independently, so each predicate is proven on its own. GitHub is a fake: it answers for GitHub paths only.
 */

const enabled = Boolean(process.env.DATABASE_URL);

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const ALICE = ALICE_USER.id;

const db = useTestDb({ orgs: [ORG], users: [ALICE_USER], max: 10 });

interface Home {
    name: string;
    forge: 'github' | 'gitlab';
    host: string;
    path: string;
}

/** Same path, another forge on the same host; same path, another host on the same forge. */
const SAME_PATH: Home[] = [
    { name: 'another forge, same host', forge: 'gitlab', host: 'github.com', path: BATCH_REPO },
    { name: 'another host, same forge', forge: 'github', host: 'gl.example', path: BATCH_REPO },
];
/** Both differ, and the path nests: the triple a derived row must keep whole. */
const NESTED: Home = {
    name: 'another forge and host, nested path',
    forge: 'gitlab',
    host: 'gl.example',
    path: 'g/sub/p',
};
const HOMES: Home[] = [...SAME_PATH, NESTED];

const refOf = (home: Home): RepoRef => ({ forge: home.forge, host: home.host, path: home.path });
const tripleOf = (home: Home) => ({ forge: home.forge, host: home.host, repo: home.path });

let sql: Sql;
let jobs: JobStore;
let prs: PrLifecycleStore;
let store: BatchStore;
let observer: BatchPrObserver;
let merger: BatchMerger;

/** The fake GitHub: what each PR number answers, and what was requested of it. */
const github = {
    replies: new Map<number, PrFacts>(),
    merges: [] as number[],
    reads: [] as number[],
    branchReads: [] as string[],
};
const client: Pick<GitHubAppClient, 'readPullRequest' | 'mergePullRequest' | 'readBranchState'> = {
    async readPullRequest(_repo, number) {
        github.reads.push(number);
        const reply = github.replies.get(number);
        if (reply === undefined) throw new GitHubReadError('not found', 'not_found');
        return reply;
    },
    async mergePullRequest(_repo, number) {
        github.merges.push(number);
        return { mergeCommitSha: `m${number}` };
    },
    async readBranchState(_repo, branch, shas) {
        github.branchReads.push(branch);
        return {
            headSha: 'tip',
            contains: Object.fromEntries(shas.map((sha) => [sha, true])),
            requiredContexts: null,
            checks: [],
        };
    },
};

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    prs = createPrLifecycleStore({ sql, orgId: ORG });
    jobs = createJobStore({ sql, orgId: ORG, prs });
    store = createBatchStore({ sql, orgId: ORG, stop: (id, by) => jobs.stop(id, by) });
    observer = createBatchPrObserver({
        sql,
        orgId: ORG,
        forge: githubForge(client),
        recordMerge: (repo, number, deliveryId, mergedAt) => jobs.closeMergedPr(repo, number, deliveryId, mergedAt),
        reconcile: (id) => store.reconcile(id),
    });
    merger = createBatchMerger({
        sql,
        orgId: ORG,
        forge: githubForge(client),
        mergeToken: async () => ({ ok: true, token: 'ghs_installation' }),
        recordMerge: (repo, number, deliveryId, mergedAt) => jobs.closeMergedPr(repo, number, deliveryId, mergedAt),
        reconcile: (id) => store.reconcile(id),
    });
});

beforeEach(() => {
    github.replies.clear();
    github.merges.length = 0;
    github.reads.length = 0;
    github.branchReads.length = 0;
});

const admitAll = async () => true;

/** A started one-task batch whose target lives at `home`: the plan wire is GitHub-only, so the target is moved by SQL. */
async function startAt(home: Home, policy: 'automerge' | 'human' = 'human'): Promise<string> {
    const source: BatchPlan = batchPlan('Ref', [{ key: 'one', policy, tasks: [prTask('a')] }]);
    const { id } = await store.create(source, ALICE);
    await sql`update batch_target set forge = ${home.forge}, host = ${home.host}, repo = ${home.path} where batch_id = ${id}`;
    const started = await store.start({
        id,
        version: 1,
        plan: resolveBatchPlan(source, { [BATCH_REPO]: 'main' }),
        startedBy: ALICE,
    });
    expect(started).toMatchObject({ result: 'ok' });
    return id;
}

let nextPr = 7000;

/** A batch at `home` whose task succeeded and published a PR on `home`'s path; the observation row is not read yet. */
async function succeededAt(home: Home, policy: 'automerge' | 'human' = 'human') {
    const id = await startAt(home, policy);
    await store.reconcile(id);
    const root = await rootOf(store, id, 'a');
    nextPr += 1;
    await recordPr(prs, root, nextPr, { repo: home.path });
    await setSucceeded(sql, root);
    await store.reconcile(id);
    return { id, root, number: nextPr };
}

/** The observation `claimDue` bound, read as a ready PR on the target's branch: the state a merge is claimed from. */
async function observedReady(id: string, number: number) {
    await observer.observeDue();
    await sql`
        update batch_pr_observation
        set outcome = 'ready', stale = false, error_code = null, error_detail = null, failures = 0,
            base_branch = 'main', head_sha = 'h1', target_sha = 't1', pr_state = 'open'
        where batch_id = ${id} and pr_number = ${number}
    `;
}

const mergeOf = (home: Home, number: number) =>
    sql`insert into pr_merge (org_id, forge, host, repo, pr_number, delivery_id)
        values (${ORG}, ${home.forge}, ${home.host}, ${home.path}, ${number}, ${`d-${number}-${home.host}`})`;

const GITHUB_HOME: Home = { name: 'github', forge: 'github', host: 'github.com', path: BATCH_REPO };

const triplesOf = async (table: string, id: string) =>
    sql<{ forge: string; host: string; repo: string }[]>`
        select forge, host, repo from ${sql(table)} where batch_id = ${id}
    `;

describe.skipIf(!enabled)('batch rows carry the repository triple', () => {
    it('stamps a plan target as GitHub on github.com and reads it back as the ref', async () => {
        const id = await startAt(GITHUB_HOME);
        expect(await triplesOf('batch_target', id)).toEqual([tripleOf(GITHUB_HOME)]);
        expect((await store.get(id))!.plan.targets).toMatchObject([{ repo: githubRepo(BATCH_REPO) }]);
    });

    it.each(HOMES)('stores a plan target on $name as given and reads it back as the ref', async (home) => {
        const source = batchPlan('Ref', [{ key: 'one', tasks: [prTask('a')] }], {
            targets: [{ key: 'web', repo: refOf(home) }],
        });
        const { id } = await store.create(source, ALICE);
        expect(await triplesOf('batch_target', id)).toEqual([tripleOf(home)]);
        expect((await store.get(id))!.plan.targets).toEqual([{ key: 'web', repo: refOf(home) }]);
    });

    it('keeps a mixed-case gitlab path exact from intake through the plan, the target and the root job', async () => {
        const ref: RepoRef = { forge: 'gitlab', host: 'gl.example', path: 'Group/Sub/Project' };
        const source = batchPlan('Case', [{ key: 'one', tasks: [prTask('a')] }], {
            targets: [{ key: 'web', repo: ref }],
        });
        const { id } = await store.create(source, ALICE);
        const started = await store.start({
            id,
            version: 1,
            plan: resolveBatchPlan(source, { [formatRepoRef(ref)]: 'main' }),
            startedBy: ALICE,
        });
        expect(started).toMatchObject({ result: 'ok' });
        await store.reconcile(id);

        const record = (await store.get(id))!;
        expect(record.plan.targets).toEqual([{ key: 'web', repo: ref, branch: 'main' }]);
        expect(await triplesOf('batch_target', id)).toEqual([{ forge: 'gitlab', host: 'gl.example', repo: ref.path }]);
        const root = await rootOf(store, id, 'a');
        const [job] = await sql`select forge, host, repo from job where id = ${root}`;
        expect(job).toEqual({ forge: 'gitlab', host: 'gl.example', repo: ref.path });
    });

    it.each(HOMES)('keeps $name on the root job, the attempt, the observation and the acceptance', async (home) => {
        const { id, root, number } = await succeededAt(home);
        await observer.observeDue();
        await mergeOf(home, number);
        await store.reconcile(id);

        const [job] = await sql`select forge, host, repo from job where id = ${root}`;
        expect(job).toEqual(tripleOf(home));
        expect(await triplesOf('batch_attempt', id)).toEqual([tripleOf(home)]);
        expect(await triplesOf('batch_acceptance', id)).toEqual([tripleOf(home)]);
    });

    it.each(HOMES)('keeps $name on the observation row and the merge intent', async (home) => {
        const { id, number } = await succeededAt(home, 'automerge');
        await observedReady(id, number);
        expect(await triplesOf('batch_pr_observation', id)).toEqual([tripleOf(home)]);

        const intents = await claimMerges({ sql, orgId: ORG }, 5, admitAll);

        expect(intents).toMatchObject([{ batchId: id, repo: refOf(home), prNumber: number }]);
        expect(await triplesOf('batch_merge', id)).toEqual([tripleOf(home)]);
    });
});

describe.skipIf(!enabled)('a GitHub merge of the same path never reads as another forge or host', () => {
    it.each(SAME_PATH)('does not accept a task for a PR merged on $name', async (home) => {
        const { id, number } = await succeededAt(home);
        await mergeOf(GITHUB_HOME, number);

        await store.reconcile(id);
        await observer.observeDue();

        expect(await triplesOf('batch_acceptance', id)).toEqual([]);
        expect((await store.get(id))!.tasks[0]).toMatchObject({ gate: 'open' });
        // The observation is still taken: the anti-join is on the triple too.
        expect(await triplesOf('batch_pr_observation', id)).toEqual([tripleOf(home)]);
    });

    it.each(SAME_PATH)('keeps the task a merge candidate on $name', async (home) => {
        const { id, number } = await succeededAt(home, 'automerge');
        await observedReady(id, number);
        await mergeOf(GITHUB_HOME, number);

        const intents = await claimMerges({ sql, orgId: ORG }, 5, admitAll);

        expect(intents).toMatchObject([{ batchId: id, repo: refOf(home) }]);
    });

    it.each(SAME_PATH)('still repairs a failing PR on $name', async (home) => {
        const { id, number } = await succeededAt(home);
        await observer.observeDue();
        await sql`
            update batch_pr_observation
            set outcome = 'checks_failing', repairable = true, stale = false, error_code = null, failures = 0,
                head_sha = 'h1', pr_state = 'open'
            where batch_id = ${id} and pr_number = ${number}
        `;
        await mergeOf(GITHUB_HOME, number);

        await store.reconcile(id);

        const repairs = await sql`select 1 from batch_attempt where batch_id = ${id} and kind = 'repair'`;
        expect(repairs).toHaveLength(1);
    });

    it.each(SAME_PATH)('reports the acceptance on $name by its own time, not the GitHub merge', async (home) => {
        const { id, number } = await succeededAt(home);
        await sql`
            insert into batch_acceptance (org_id, batch_id, task_key, attempt, kind, forge, host, repo, pr_number, pr_url)
            values (${ORG}, ${id}, 'a', 1, 'pr_merged', ${home.forge}, ${home.host}, ${home.path}, ${number}, 'https://x/1')
        `;
        await sql`
            insert into pr_merge (org_id, forge, host, repo, pr_number, delivery_id, merged_at)
            values (${ORG}, 'github', 'github.com', ${home.path}, ${number}, 'd-report', '2020-01-01T00:00:00Z')
        `;

        const report = (await store.report(id))!;

        expect(report.prs.merged).toHaveLength(1);
        expect(report.prs.merged[0]!.mergedAt).not.toBe('2020-01-01T00:00:00.000Z');
    });

    it.each(SAME_PATH)('does not wake the observation on $name for a GitHub hint', async (home) => {
        const { id, number } = await succeededAt(home);
        await observer.observeDue();

        expect(await observer.requestRefresh({ repo: BATCH_REPO, numbers: [number] })).toBe(0);
        expect(await triplesOf('batch_pr_observation', id)).toEqual([tripleOf(home)]);
    });

    it('wakes a GitHub observation for a hint that differs by case', async () => {
        const { number } = await succeededAt(GITHUB_HOME);
        await observer.observeDue();

        expect(await observer.requestRefresh({ repo: 'ACME/web', numbers: [number] })).toBe(1);
    });

    it.each(SAME_PATH)('keeps the narrow merge slot across forges and hosts: $name waits for it', async (home) => {
        const github_ = await succeededAt(GITHUB_HOME, 'automerge');
        await observedReady(github_.id, github_.number);
        expect(await claimMerges({ sql, orgId: ORG }, 5, admitAll)).toMatchObject([{ batchId: github_.id }]);

        const other = await succeededAt(home, 'automerge');
        await observedReady(other.id, other.number);

        expect(await claimMerges({ sql, orgId: ORG }, 5, admitAll)).toEqual([]);
    });
});

describe.skipIf(!enabled)('GitHub facts never settle a PR of another forge or host', () => {
    it.each(SAME_PATH)('records no merge and applies nothing for an observation on $name', async (home) => {
        const { id, number } = await succeededAt(home);
        github.replies.set(
            number,
            facts(number, { state: 'closed', merged: true, mergedAt: '2026-01-01T00:00:00Z', mergeCommitSha: 'm1' })
        );

        await observer.observeDue();

        expect(await sql`select 1 from pr_merge where pr_number = ${number}`).toEqual([]);
        const [row] = await sql`select error_code, outcome from batch_pr_observation where batch_id = ${id}`;
        expect(row).toMatchObject({ error_code: 'binding', outcome: null });
    });

    it.each(SAME_PATH)('requests no merge for an intent on $name', async (home) => {
        const { id, number } = await succeededAt(home, 'automerge');
        await observedReady(id, number);
        github.replies.set(number, facts(number));

        await merger.mergeDue();

        expect(github.merges).toEqual([]);
        expect(await sql`select 1 from pr_merge where pr_number = ${number}`).toEqual([]);
        expect(await sql`select state from batch_merge where batch_id = ${id}`).toMatchObject([{ state: 'changed' }]);
    });
});

/** Every variant of `github.com` the reader cannot answer for, at the batch's own path. */
const UNREADABLE: Home[] = REPO_VARIANTS.map((variant) => ({ ...variant, path: BATCH_REPO }));

describe.skipIf(!enabled)('a GitHub answer is applied only to the identity it was bound to', () => {
    /** An automerge task whose merge request was sent and not answered: the intent the recovery reads back. */
    async function uncertainAt(home: Home) {
        const { id, number } = await succeededAt(home, 'automerge');
        await observedReady(id, number);
        const [intent] = await claimMerges({ sql, orgId: ORG }, 5, admitAll);
        await sql`update batch_merge set state = 'uncertain' where id = ${intent!.id}::bigint`;
        return { id, number };
    }

    it.each(UNREADABLE)('records no merge when recovering an uncertain intent on $name', async (home) => {
        const { id, number } = await uncertainAt(home);
        github.replies.set(
            number,
            facts(number, { state: 'closed', merged: true, mergedAt: '2026-01-01T00:00:00Z', mergeCommitSha: 'm1' })
        );

        await merger.mergeDue();

        expect(await sql`select 1 from pr_merge where pr_number = ${number}`).toEqual([]);
        expect(await sql`select state from batch_merge where batch_id = ${id}`).toMatchObject([{ state: 'uncertain' }]);
        expect(await triplesOf('batch_acceptance', id)).toEqual([]);
    });

    it('records no merge when the answer to an uncertain GitHub intent is for another pull request', async () => {
        const { id, number } = await uncertainAt(GITHUB_HOME);
        github.replies.set(
            number,
            facts(number + 1, { state: 'closed', merged: true, mergedAt: '2026-01-01T00:00:00Z', mergeCommitSha: 'm1' })
        );

        await merger.mergeDue();

        expect(await sql`select 1 from pr_merge where pr_number = ${number}`).toEqual([]);
        expect(await sql`select state from batch_merge where batch_id = ${id}`).toMatchObject([{ state: 'uncertain' }]);
    });

    it('still records the merge of an uncertain GitHub intent the answer is bound to', async () => {
        const { id, number } = await uncertainAt(GITHUB_HOME);
        github.replies.set(
            number,
            facts(number, { state: 'closed', merged: true, mergedAt: '2026-01-01T00:00:00Z', mergeCommitSha: 'm1' })
        );

        await merger.mergeDue();

        expect(await sql`select state from batch_merge where batch_id = ${id}`).toMatchObject([{ state: 'merged' }]);
        expect(await sql`select 1 from pr_merge where pr_number = ${number}`).toHaveLength(1);
    });

    /** A stage whose only task is accepted and merged, with the merge commit already stored: verification is next. */
    async function mergedStageAt(home: Home) {
        const { id, number } = await succeededAt(home, 'automerge');
        await observedReady(id, number);
        const [intent] = await claimMerges({ sql, orgId: ORG }, 5, admitAll);
        await sql`update batch_merge set state = 'merged', merge_commit_sha = 'm1' where id = ${intent!.id}::bigint`;
        await sql`
            insert into batch_acceptance (org_id, batch_id, task_key, attempt, kind, forge, host, repo, pr_number, pr_url)
            values (${ORG}, ${id}, 'a', 1, 'pr_merged', ${home.forge}, ${home.host}, ${home.path}, ${number}, 'https://x/1')
        `;
        await sql`update batch_task set gate = 'passed' where batch_id = ${id} and key = 'a'`;
        return id;
    }

    it.each(UNREADABLE)(
        'keeps verification of a stage on $name inconclusive without reading the branch',
        async (home) => {
            const id = await mergedStageAt(home);

            await merger.mergeDue();

            expect(github.branchReads).toEqual([]);
            expect(await sql`select state from batch_stage_verification where batch_id = ${id}`).toMatchObject([
                { state: 'unknown' },
            ]);
            expect((await store.get(id))!.completedAt).toBeNull();
        }
    );

    it('verifies a GitHub stage from its stored merge commit', async () => {
        const id = await mergedStageAt(GITHUB_HOME);

        await merger.mergeDue();

        expect(github.branchReads).toEqual(['main']);
        expect(await sql`select state from batch_stage_verification where batch_id = ${id}`).toMatchObject([
            { state: 'pending' },
        ]);
    });

    // The credential is a side effect too: a ref no client answers for must reach no mint, no token read, no request.
    function recordingDeps() {
        const recording = recordingForge();
        const mergeTokens: string[] = [];
        const settled = { recordMerge: async () => undefined, reconcile: (id: string) => store.reconcile(id) };
        return {
            recording,
            mergeTokens,
            observer: createBatchPrObserver({ sql, orgId: ORG, forge: recording.forge, ...settled }),
            merger: createBatchMerger({
                sql,
                orgId: ORG,
                forge: recording.forge,
                mergeToken: async () => {
                    mergeTokens.push('merge token');
                    return { ok: true, token: 'ghs_member' };
                },
                ...settled,
            }),
            seen: () => ({ credentials: recording.credentials, requests: recording.requests, mergeTokens }),
        };
    }
    const NONE = { credentials: [], requests: [], mergeTokens: [] };

    it.each(UNREADABLE)('reads no credential and makes no request to observe or merge on $name', async (home) => {
        const deps = recordingDeps();
        // An automerge task that is otherwise eligible: the merger claims it, so an empty record is the guard.
        const eligible = await succeededAt(home, 'automerge');
        await observedReady(eligible.id, eligible.number);

        await deps.observer.observeDue();
        await deps.merger.mergeDue();

        expect(deps.seen()).toEqual(NONE);
        expect(await sql`select state from batch_merge where batch_id = ${eligible.id}`).toMatchObject([
            { state: 'changed' },
        ]);
    });

    it.each(UNREADABLE)('reads no credential and makes no request to verify a stage on $name', async (home) => {
        const deps = recordingDeps();
        const id = await mergedStageAt(home);

        await deps.merger.mergeDue();

        expect(deps.seen()).toEqual(NONE);
        expect(
            await sql`select 1 from batch_stage_verification where batch_id = ${id} and state = 'unknown'`
        ).toHaveLength(1);
    });

    it.each(UNREADABLE)('reads no pull request for an observation on $name', async (home) => {
        const { number } = await succeededAt(home);
        github.replies.set(number, facts(number));

        await observer.observeDue();

        expect(github.reads).toEqual([]);
    });
});
