import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnectionStore } from '../src/db/connection-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { bindConnectionRow } from '../src/db/jobs/job-store-connections.js';
import { prLockKey, settleIfMergeClosed } from '../src/db/jobs/job-store-merge.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { sweepRuntimeWakes, wakeOneRound } from '../src/db/workflows/workflow-blocks/runtime.js';
import type { WorkflowDefinition } from '../src/db/workflows/workflow-schema.js';
import { expireLease, spendInterruptionBudget, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import { DEADLINE_MS, holder, pool, settledWithin, value, waitForLockWait } from './lock-order-harness.js';

/**
 * BEL-161: the bind locks the thread's ROOT ROW (`for no key update`) and then the thread advisory lock, so every
 * thread writer must take them in that order too. Each B case holds the root row `for share`, queues the bind on
 * it, queues the writer behind it, releases, and requires both to finish: a 40P01 is the inversion (the writer held
 * the advisory lock and waited on the root row the bind then held).
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('blo-alice');
const WORKER = 'worker-blo';
const LEASE_SECONDS = 60;
const REPO = 'acme/app';
const BINDER = 'tlo-bind';
const WRITER = 'tlo-writer';
const HOOK = 'tlo-hook';
const CLAIMER = 'tlo-claimer';
const PULL = 12;
const succeeded = { status: 'succeeded', exitCode: 0, output: 'ok' } as const;
const db = useTestDb({ orgs: [ORG], users: [ALICE], max: 8 });

let sql: Sql;
let binderPool: Sql;
let writerPool: Sql;
let hookPool: Sql;
let claimPool: Sql;
let plain: JobStore;
let writer: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    binderPool = pool(BINDER);
    writerPool = pool(WRITER);
    hookPool = pool(HOOK);
    claimPool = pool(CLAIMER);
    plain = createJobStore({ sql, orgId: ORG, prs: createPrLifecycleStore({ sql, orgId: ORG }) });
    writer = createJobStore({
        sql: writerPool,
        orgId: ORG,
        prs: createPrLifecycleStore({ sql: writerPool, orgId: ORG }),
    });
});

afterAll(async () => {
    await binderPool?.end({ timeout: 5 });
    await writerPool?.end({ timeout: 5 });
    await hookPool?.end({ timeout: 5 });
    await claimPool?.end({ timeout: 5 });
});

const connect = async (): Promise<string> =>
    (
        await createConnectionStore({ sql, orgId: ORG }).create({
            ownerUserId: ALICE.id,
            site: 'example.atlassian.net',
            cloudId: `cloud-${randomUUID()}`,
            email: `a-${randomUUID()}@example.com`,
            apiToken: 'tok',
            access: 'read',
        })
    ).id;

const queued = async (): Promise<string> => {
    const created = await plain.create('do the work', ALICE.id, { repo: REPO, executor: null });
    if (typeof created === 'string') throw new Error(created);
    return created.id;
};

/** A thread whose root ran to a terminal verdict, optionally published to the suite's PR. */
const terminalRoot = async (published = false): Promise<string> => {
    const root = await queued();
    const claim = await plain.claim(WORKER, LEASE_SECONDS);
    if (!claim) throw new Error('nothing was claimable');
    await plain.complete(root, claim.leaseToken, {
        ...succeeded,
        ...(published && {
            publication: {
                repo: REPO,
                prNumber: PULL,
                prUrl: `https://github.com/${REPO}/pull/${PULL}`,
                headBranch: `factory/${root}`,
                baseBranch: 'main',
            },
        }),
    });
    return root;
};

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

/** A workflow thread that published to the suite's PR and parked on a delivery wait (the block-wait fixture). */
const waitingThread = async (): Promise<string> => {
    const created = await plain.create('start the thread', ALICE.id, {
        repo: REPO,
        executor: null,
        workflow: {
            id: randomUUID(),
            name: 'blo',
            node: waitingWorkflow.entry,
            snapshot: waitingWorkflow,
            params: {},
        },
    });
    if (typeof created === 'string') throw new Error(created);
    const claim = await plain.claim(WORKER, LEASE_SECONDS);
    if (!claim) throw new Error('nothing was claimable');
    await plain.complete(created.id, claim.leaseToken, {
        ...succeeded,
        publication: {
            repo: REPO,
            prNumber: PULL,
            prUrl: `https://github.com/${REPO}/pull/${PULL}`,
            headBranch: `factory/${created.id}`,
            baseBranch: 'main',
        },
    });
    return created.id;
};
const revisionOf = async (id: string): Promise<number> =>
    (await sql<{ rev: number }[]>`select binding_revision as rev from job where id = ${id}`)[0]!.rev;

/**
 * Hold the root `for share`, queue the bind on it, then the writer behind it, release, and require both to finish.
 * The bind is queued first so it wins the root row: a writer that already holds the advisory lock is then a cycle.
 */
async function raceWithBind<W>(root: string, start: () => Promise<W>) {
    const fresh = await connect();
    const share = await holder(sql, (tx) => tx`select id from job where id = ${root} for share`);
    const bind = bindConnectionRow(binderPool, {
        orgId: ORG,
        id: root,
        connectionId: fresh,
        bindingRevision: await revisionOf(root),
        userId: ALICE.id,
    });
    await waitForLockWait(sql, BINDER, Date.now() + DEADLINE_MS);
    const written = start();
    await waitForLockWait(sql, WRITER, Date.now() + DEADLINE_MS);
    share.release();
    await share.done;
    const [bound, result] = await settledWithin([bind, written]);
    expect(value(bound)).toEqual({ ok: true, revision: 1 });
    return value(result);
}

const rootRow = async (id: string) =>
    (
        await sql<{ done_at: Date | null; reclaimed: Date | null }[]>`
            select done_at, worktree_reclaimed_at as reclaimed from job where id = ${id}`
    )[0]!;

describe.skipIf(!enabled)('bind vs thread writers — database', () => {
    it('B1: retry and a bind on one root do not deadlock', async () => {
        const root = await terminalRoot();
        const retried = await raceWithBind(root, () => writer.createRetry(root, ALICE.id));
        expect(retried).toMatchObject({ id: expect.any(String) });
    });

    it('B2: a follow-up without connections and a bind on one root do not deadlock', async () => {
        const root = await terminalRoot();
        const made = await raceWithBind(root, () => writer.createFollowUp(root, 'again', ALICE.id));
        expect(made).toMatchObject({ id: expect.any(String) });
    });

    it('B3: remove and a bind on one root do not deadlock', async () => {
        const root = await terminalRoot();
        const removed = await raceWithBind(root, () => writer.removeThread(root, null));
        expect(removed).not.toBe('missing');
        const left = await sql`select id from job where id = ${root}`;
        expect(left).toHaveLength(0);
    });

    it('B4: a merge close and a bind on one root do not deadlock', async () => {
        const root = await terminalRoot(true);
        const closed = await raceWithBind(root, () => writer.closeMergedPr(REPO, PULL, `guid-${randomUUID()}`));
        expect(closed).toEqual({ outcome: 'applied', closedRoots: 1 });
        expect((await rootRow(root)).done_at).not.toBeNull();
    });

    it('B5: done and a bind on one root do not deadlock', async () => {
        const root = await terminalRoot();
        const done = await raceWithBind(root, () => writer.markDone(root, null));
        expect(done).toMatchObject({ doneAt: expect.anything() });
    });

    it('B6: an ack-reclaim and a bind on one root do not deadlock', async () => {
        const root = await terminalRoot();
        await plain.markDone(root, null);
        const claim = await plain.claimReclaim(WORKER, LEASE_SECONDS);
        if (!claim) throw new Error('no reclaim was claimable');
        const acked = await raceWithBind(root, () => writer.ackReclaim(claim.id, claim.token));
        expect(acked).toBe('ok');
        expect((await rootRow(root)).reclaimed).not.toBeNull();
    });

    it('B7: reopen and a bind on one root do not deadlock', async () => {
        const root = await terminalRoot();
        await plain.markDone(root, null);
        const reopened = await raceWithBind(root, () => writer.reopen(root));
        expect(reopened).toEqual({ result: 'ok' });
        expect((await rootRow(root)).done_at).toBeNull();
    });

    it('B10: the marked-thread settle of a stop and a bind on one root do not deadlock', async () => {
        const root = await queued();
        await plain.stop(root, ALICE.id);
        await sql`insert into job_merge_close (org_id, root_job_id) values (${ORG}, ${root})`;
        const settled = await raceWithBind(root, () => settleIfMergeClosed({ sql: writerPool, orgId: ORG }, root));
        expect(settled).toBe(true);
        expect((await rootRow(root)).done_at).not.toBeNull();
        const reclaims = await sql`select 1 from task_reclaim where org_id = ${ORG} and root_job_id = ${root}`;
        expect(reclaims).toHaveLength(1);
    });

    /** Guard for the verdict's root-first lock: green on the old tree too, RED only with that step reverted. */
    it('B8: a verdict on a member and a redelivered merge webhook do not deadlock', async () => {
        const root = await terminalRoot(true);
        const made = await plain.createFollowUp(root, 'again', ALICE.id);
        if (typeof made === 'string') throw new Error(made);
        const member = await plain.claim(WORKER, LEASE_SECONDS);
        if (member?.id !== made.id) throw new Error('the follow-up was not claimed');
        expect(await plain.closeMergedPr(REPO, PULL, `guid-${randomUUID()}`)).toEqual({
            outcome: 'applied',
            closedRoots: 1,
        });
        const hooks = createJobStore({
            sql: hookPool,
            orgId: ORG,
            prs: createPrLifecycleStore({ sql: hookPool, orgId: ORG }),
        });

        const prLock = await holder(
            sql,
            (tx) => tx`select pg_advisory_xact_lock(hashtextextended(${prLockKey(ORG, REPO, PULL)}::text, 0))`
        );
        const verdict = writer.complete(member.id, member.leaseToken, {
            ...succeeded,
            publication: {
                repo: REPO,
                prNumber: PULL,
                prUrl: `https://github.com/${REPO}/pull/${PULL}`,
                headBranch: `factory/${root}`,
                baseBranch: 'main',
            },
        });
        await waitForLockWait(sql, WRITER, Date.now() + DEADLINE_MS);
        const redelivered = hooks.closeMergedPr(REPO, PULL, `guid-${randomUUID()}`);
        await waitForLockWait(sql, HOOK, Date.now() + DEADLINE_MS);
        prLock.release();
        await prLock.done;
        const [completed, hooked] = await settledWithin([verdict, redelivered]);
        expect(value(completed)).toMatchObject({ result: 'ok' });
        expect(value(hooked)).toEqual({ outcome: 'duplicate', closedRoots: 0 });
    });

    /** Guard for the claim's root-row try: the fence's root lock must not wait behind a bind while the claim holds the advisory lock. */
    it('B9: the claim fence on a merge-marked thread and a bind on its root do not deadlock', async () => {
        const root = await waitingThread();
        const prs = createPrLifecycleStore({ sql, orgId: ORG });
        await prs.recordDelivery({
            deliveryId: `d-${randomUUID()}`,
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: PULL,
        });
        await sweepRuntimeWakes({ sql, orgId: ORG, prs });
        await prs.cancelForRepoPr(REPO, PULL, 'pr closed');
        await sql`insert into job_merge_close (org_id, root_job_id) values (${ORG}, ${root})`;

        const fresh = await connect();
        const share = await holder(sql, (tx) => tx`select id from job where id = ${root} for share`);
        const bind = bindConnectionRow(binderPool, {
            orgId: ORG,
            id: root,
            connectionId: fresh,
            bindingRevision: await revisionOf(root),
            userId: ALICE.id,
        });
        await waitForLockWait(sql, BINDER, Date.now() + DEADLINE_MS);
        // The bind is queued on the root row first; the claim then runs to its fence (a cancelled continuation reads no plan).
        const claimer = createJobStore({
            sql: claimPool,
            orgId: ORG,
            prs: createPrLifecycleStore({ sql: claimPool, orgId: ORG }),
        });
        const claim = claimer.claim(WORKER, LEASE_SECONDS) as Promise<Claim | null>;
        // Fixed: the claim refuses without waiting. Old: the fence queues on the root row behind the bind.
        await Promise.race([
            claim.then(
                () => undefined,
                () => undefined
            ),
            waitForLockWait(sql, CLAIMER, Date.now() + DEADLINE_MS).catch(() => undefined),
        ]);
        share.release();
        await share.done;
        const [claimed, bound] = await settledWithin([claim, bind]);
        expect(value(claimed)).toBeNull();
        expect(value(bound)).toEqual({ ok: true, revision: 1 });
        expect(await plain.claim(WORKER, LEASE_SECONDS)).toBeNull();
        const settled = await sql<{ status: string }[]>`
            select status from job where org_id = ${ORG} and root_job_id = ${root} and id <> ${root}`;
        expect(settled.map((r) => r.status)).toEqual(['stopped']);
    });

    /** Guard for the dead sweep settling after its commit: the sweep must not hold B while waiting on root A. */
    it('B11: the dead sweep of a marked thread and a disconnect over two roots do not deadlock', async () => {
        const first = await queued();
        const second = await queued();
        const [rootA, rootB] = [first, second].sort() as [string, string];
        const claimedA = await plain.claim(WORKER, LEASE_SECONDS);
        const claimedB = await plain.claim(WORKER, LEASE_SECONDS);
        if (!claimedA || !claimedB) throw new Error('both roots should be claimable');
        const tokenOf = (id: string) => [claimedA, claimedB].find((c) => c.id === id)!.leaseToken;
        await plain.complete(rootA, tokenOf(rootA), succeeded);
        const made = await plain.createFollowUp(rootA, 'again', ALICE.id);
        if (typeof made === 'string') throw new Error(made);
        const member = await plain.claim(WORKER, LEASE_SECONDS);
        if (member?.id !== made.id) throw new Error('the follow-up was not claimed');
        await sql`insert into job_merge_close (org_id, root_job_id) values (${ORG}, ${rootA})`;

        const mine = await connect();
        for (const id of [rootA, rootB]) {
            const bound = await bindConnectionRow(sql, {
                orgId: ORG,
                id,
                connectionId: mine,
                bindingRevision: await revisionOf(id),
                userId: ALICE.id,
            });
            expect(bound).toMatchObject({ ok: true });
        }
        for (const id of [rootB, member.id]) {
            await sql`update job set attempts = max_attempts where id = ${id}`;
            await expireLease(sql, id);
            await spendInterruptionBudget(sql, id);
        }

        const share = await holder(sql, (tx) => tx`select id from job where id = ${rootA} for share`);
        const disconnected = createConnectionStore({ sql: binderPool, orgId: ORG }).disconnect(mine, {
            userId: ALICE.id,
            admin: false,
        });
        await waitForLockWait(sql, BINDER, Date.now() + DEADLINE_MS);
        const claim = createJobStore({ sql: claimPool, orgId: ORG }).claim(WORKER, LEASE_SECONDS);
        await waitForLockWait(sql, CLAIMER, Date.now() + DEADLINE_MS);
        share.release();
        await share.done;
        const [, claimed] = await settledWithin([disconnected, claim]);
        expect(value(claimed)).toBeNull();
        const statuses = await sql<{ id: string; status: string; done_at: Date | null }[]>`
            select id, status, done_at from job where id in (${rootB}, ${member.id})`;
        expect(statuses.map((r) => r.status)).toEqual(['dead', 'dead']);
        expect((await rootRow(rootA)).done_at).not.toBeNull();
    });

    it('B12: waking a parked round and a merge close of its PR do not deadlock', async () => {
        const root = await waitingThread();
        const writerPrs = createPrLifecycleStore({ sql: writerPool, orgId: ORG });
        await writerPrs.recordDelivery({
            deliveryId: `d-${randomUUID()}`,
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: PULL,
        });
        const hooks = createJobStore({
            sql: hookPool,
            orgId: ORG,
            prs: createPrLifecycleStore({ sql: hookPool, orgId: ORG }),
        });
        // Hold the wait row: the merge close queues on it (holding the root row, PR lock and ledger), then the wake.
        const wait = await holder(
            sql,
            (tx) => tx`select 1 from workflow_wait where org_id = ${ORG} and root_job_id = ${root} for update`
        );
        const merged = hooks.closeMergedPr(REPO, PULL, `guid-${randomUUID()}`);
        await waitForLockWait(sql, HOOK, Date.now() + DEADLINE_MS);
        const woken = wakeOneRound({ sql: writerPool, orgId: ORG, prs: writerPrs }, root, 'review', true);
        await waitForLockWait(sql, WRITER, Date.now() + DEADLINE_MS);
        wait.release();
        await wait.done;
        const [closed, wake] = await settledWithin([merged, woken]);
        expect(value(closed)).toEqual({ outcome: 'applied', closedRoots: 1 });
        expect(wake.status).toBe('fulfilled');
    });
});
