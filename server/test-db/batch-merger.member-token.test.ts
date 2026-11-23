import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { BatchPlan, PrFacts } from '@factory-ai/core';
import { createBatchMerger, type BatchMerger, type MergeClient } from '../src/batch-merger.js';
import { createBatchPrObserver } from '../src/batch-pr-observer.js';
import { createBatchStore } from '../src/db/batches/batch-store.js';
import type { BatchStore } from '../src/db/batches/batch-store-types.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { createPrLifecycleStore, type PrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { createMergeTokenSource } from '../src/forge/pr-token.js';
import { GitHubMergeError } from '../src/github/pr-merge.js';
import type { MemberForgeGrants } from '../src/integrations/member-forge-grant.js';
import { testSecretStore } from './env-secrets-harness.js';
import { type FakeGithub, startFakeGithub } from './fake-github.js';
import { batchPlan, facts, prTask, recordPr, rootOf, setSucceeded, startBatch } from './batch-fixtures.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import { memberGrantsOver, signMemberIn } from './member-grant-rig.js';

/**
 * Automerge merges as the batch's starter (docs/batches.md): the `PUT …/merge` carries the starter's user token, every
 * read the installation's. The token is resolved BEFORE an intent is claimed, so a starter whose grant is not live, a
 * deleted starter or an unreadable token leaves the task un-merged with no intent and no attempt spent: it never parks
 * the task, however many passes it takes. Under `AUTH_MODE=none` (no member grants) the installation token merges.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const STARTER = testUser('merge-starter');
const BLOCKED = testUser('merge-blocked');
const INSTALLATION_TOKEN = 'ghs_installation';
const PASSES = 5;
/** The default window: four dispatches at once, four candidates listed for each. */
const BLOCKED_BATCHES = 16;
const db = useTestDb({ orgs: [ORG], users: [STARTER, BLOCKED], max: 10 });

let sql: Sql;
let jobs: JobStore;
let prs: PrLifecycleStore;
let store: BatchStore;
let fake: FakeGithub;
let tokenFetch: typeof fetch;
let grants: MemberForgeGrants;
let tokenUnreadable = false;
const merges: { number: number; token: string }[] = [];
const reads: number[] = [];
const replies = new Map<number, PrFacts>();
let mergeFailure: GitHubMergeError | undefined;

const client: MergeClient = {
    async readPullRequest(_repo, number) {
        reads.push(number);
        return replies.get(number)!;
    },
    async mergePullRequest(_repo, number, _request, token) {
        merges.push({ number, token });
        if (mergeFailure) throw mergeFailure;
        return { mergeCommitSha: `m${number}` };
    },
    async readBranchState() {
        throw new Error('not read in this suite');
    },
};

beforeEach(async () => {
    sql = db.sql;
    fake = await startFakeGithub();
    tokenFetch = fetch;
    tokenUnreadable = false;
    merges.length = 0;
    reads.length = 0;
    replies.clear();
    mergeFailure = undefined;
    prs = createPrLifecycleStore({ sql, orgId: ORG });
    jobs = createJobStore({ sql, orgId: ORG, prs });
    store = createBatchStore({ sql, orgId: ORG, stop: (id, by) => jobs.stop(id, by) });
    grants = memberGrantsOver({ sql, fake, secrets: testSecretStore(sql), tokenFetch: () => tokenFetch });
});

afterEach(async () => {
    await fake.stop();
});

/** The real merge-token source over the real grants, or over none (`AUTH_MODE=none`); `tokenUnreadable` stands for a secret-store outage. */
const mergerOf = (memberGrants: MemberForgeGrants | undefined): BatchMerger => {
    const source = createMergeTokenSource({
        memberGrants,
        installation: async () => INSTALLATION_TOKEN,
    });
    return createBatchMerger({
        sql,
        orgId: ORG,
        client,
        recordMerge: (repo, number, deliveryId, mergedAt) =>
            jobs.closeMergedPr(repo, number, deliveryId, mergedAt),
        reconcile: (id) => store.reconcile(id),
        mergeToken: (who, signal) =>
            tokenUnreadable
                ? Promise.resolve({ ok: false, detail: 'the starter token could not be read' })
                : source(who, signal),
    });
};

const plan = (): BatchPlan => batchPlan('Merge', [{ key: 'one', policy: 'automerge', tasks: [prTask('a')] }]);

let nextPr = 7000;
/** A started batch (by STARTER) whose task succeeded and published a PR the fake GitHub reports ready. */
async function readyBatch(starter = STARTER.id) {
    const id = await startBatch(store, plan(), starter);
    await store.reconcile(id);
    const root = await rootOf(store, id, 'a');
    nextPr += 1;
    await recordPr(prs, root, nextPr);
    await setSucceeded(sql, root);
    await store.reconcile(id);
    replies.set(nextPr, facts(nextPr));
    const observer = createBatchPrObserver({
        sql,
        orgId: ORG,
        reader: client,
        recordMerge: (repo, number, deliveryId, mergedAt) =>
            jobs.closeMergedPr(repo, number, deliveryId, mergedAt),
        reconcile: (batchId) => store.reconcile(batchId),
    });
    await observer.observeDue();
    reads.length = 0;
    return { id, number: nextPr };
}

const intentsOf = (id: string) => sql<{ state: string }[]>`select state from batch_merge where batch_id = ${id}`;
const attentionOf = async (id: string) => (await store.get(id))!.tasks.find((t) => t.key === 'a')!.attention;
const passes = async (merger: BatchMerger, n: number) => {
    for (let i = 0; i < n; i += 1) await merger.mergeDue();
};

describe.skipIf(!enabled)('automerge as the batch starter', () => {
    it('sends the merge with the starter’s user token and reads through the installation', async () => {
        const pair = await signMemberIn({ grants, fake, orgId: ORG, user: STARTER });
        const { number } = await readyBatch();

        await mergerOf(grants).mergeDue();

        expect(merges).toEqual([{ number, token: pair.access_token }]);
        expect(pair.access_token).toMatch(/^ghu_/);
        expect(reads).toContain(number);
    });

    it('claims nothing while the starter’s grant is broken, spends no attempt, and merges once it is live again', async () => {
        await signMemberIn({ grants, fake, orgId: ORG, user: STARTER });
        const { id, number } = await readyBatch();
        await sql`update integration_grant set status = 'reconnect_required' where principal_user_id = ${STARTER.id}`;
        const merger = mergerOf(grants);

        await passes(merger, PASSES);

        expect(merges).toEqual([]);
        expect(await intentsOf(id)).toEqual([]);
        expect(await attentionOf(id)).toBeNull();

        await sql`update integration_grant set status = 'active' where principal_user_id = ${STARTER.id}`;
        await merger.mergeDue();
        expect(merges).toMatchObject([{ number }]);
        expect(merges[0]!.token).toMatch(/^ghu_/);
    });

    it('never merges a batch whose starter no longer exists, and never parks it: the batch deadline governs', async () => {
        await signMemberIn({ grants, fake, orgId: ORG, user: STARTER });
        const { id } = await readyBatch();
        await sql`update batch set started_by = null where id = ${id}`;

        await passes(mergerOf(grants), PASSES);

        expect(merges).toEqual([]);
        expect(await intentsOf(id)).toEqual([]);
        expect(await attentionOf(id)).toBeNull();
    });

    it('an unreadable token never parks the task however many passes, then merges with the member’s token', async () => {
        const pair = await signMemberIn({ grants, fake, orgId: ORG, user: STARTER });
        const { id, number } = await readyBatch();
        const merger = mergerOf(grants);
        tokenUnreadable = true;

        await passes(merger, PASSES);

        expect(merges).toEqual([]);
        expect(await intentsOf(id)).toEqual([]);
        expect(await attentionOf(id)).toBeNull();

        tokenUnreadable = false;
        await merger.mergeDue();
        expect(merges).toEqual([{ number, token: pair.access_token }]);
    });

    it('a refresh that answers 5xx is inconclusive: nothing merged, nothing parked', async () => {
        await signMemberIn({ grants, fake, orgId: ORG, user: STARTER }, { expiresIn: 1 });
        const { id } = await readyBatch();
        tokenFetch = async () => new Response('bad gateway', { status: 502 });

        await passes(mergerOf(grants), PASSES);

        expect(merges).toEqual([]);
        expect(await intentsOf(id)).toEqual([]);
        expect(await attentionOf(id)).toBeNull();
    });

    it('lists past token-blocked candidates: sixteen blocked older batches do not starve an eligible one', async () => {
        const pair = await signMemberIn({ grants, fake, orgId: ORG, user: STARTER });
        const blocked: string[] = [];
        // BLOCKED holds no grant: each of these is older than the eligible batch and fills the whole default window.
        for (let i = 0; i < BLOCKED_BATCHES; i += 1) blocked.push((await readyBatch(BLOCKED.id)).id);
        const { number } = await readyBatch();

        await mergerOf(grants).mergeDue();

        expect(merges).toEqual([{ number, token: pair.access_token }]);
        for (const id of blocked) {
            expect(await intentsOf(id)).toEqual([]);
            expect(await attentionOf(id)).toBeNull();
        }
    });

    // Pin, green before the change: no member grants (AUTH_MODE=none) merges with the installation token.
    it('merges with the installation token when there are no member grants', async () => {
        const { number } = await readyBatch();

        await mergerOf(undefined).mergeDue();

        expect(merges).toEqual([{ number, token: INSTALLATION_TOKEN }]);
    });

    // Pin, green before the change: a member's 403 on the merge is the existing refusal, and it parks the task.
    it('parks the task when the member’s merge is forbidden', async () => {
        await signMemberIn({ grants, fake, orgId: ORG, user: STARTER });
        const { id } = await readyBatch();
        mergeFailure = new GitHubMergeError('forbidden', 'forbidden');

        await mergerOf(grants).mergeDue();

        expect(await intentsOf(id)).toMatchObject([{ state: 'refused' }]);
        expect(await attentionOf(id)).toBe('refused');
    });
});
