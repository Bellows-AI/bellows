import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { EvidencePolicy, RecordedEvidence } from '../src/db/evidence-policy.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { STAGED_COMMIT_REASON } from '../src/db/jobs/job-store-conclusions.js';
import { reviewRefOf } from '../src/db/jobs/job-store-reviews.js';
import type { Claim, CreateJobStoreDeps, JobStore, ReviewerSpec } from '../src/db/jobs/job-store-types.js';
import { createWorkflowStore } from '../src/db/workflows/workflow-store.js';
import type { WorkflowDefinition } from '../src/db/workflows/workflow-schema.js';
import { useTestDb } from './harness.js';
import { fingerprintOf } from '../src/db/jobs/job-store-receipts.js';
import {
    account,
    expectStillLocked,
    expireLease,
    holdLock,
    mustCreate,
    randomGithubId,
    spendInterruptionBudget,
    testOrg,
} from './fixtures.js';

/**
 * Issue #821 (D1): an attempt's final envelope is staged on the board under its lease before the
 * driver completes and tears down. A staged conclusion is binding: the board commits it when the
 * lease expires before the driver's complete lands — never retiring, stopping or re-running the
 * attempt — and the driver's identical complete afterwards replays the board's receipt.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const WORKER = 'driver-1';
const LEASE_SECONDS = 300;
const db = useTestDb({ max: 8, orgs: [ORG] });

let sql: Sql;
let store: JobStore;
let workflows: ReturnType<typeof createWorkflowStore>;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    workflows = createWorkflowStore({ sql, orgId: ORG });
});

const succeeded = { status: 'succeeded', exitCode: 0, output: 'did the work' } as const;
const failed = { status: 'failed', exitCode: 1, output: 'it broke' } as const;
const PASSED: RecordedEvidence = { treeBefore: 'h:1', treeAfter: 'h:2', gates: 'passed' };

/** A two-node graph: the entry's success inserts the review node. */
const walk: WorkflowDefinition = {
    entry: 'implement',
    params: [],
    nodes: [
        { name: 'implement', kind: 'agent', session: 'resume', prompt: 'implement' },
        { name: 'review', kind: 'agent', session: 'fresh', prompt: 'review the work' },
    ],
    edges: [{ from: 'implement', to: 'review', when: 'succeeded' }],
};

async function queue(on: JobStore = store, repo: string | null = null): Promise<string> {
    const job = await on.create('do the thing', null, { repo, executor: null });
    if (typeof job === 'string') throw new Error(job);
    return job.id;
}

async function queueWorkflow(): Promise<string> {
    const created = await workflows.create({
        name: `walk-${randomGithubId()}`,
        scope: { kind: 'org' },
        definition: walk,
        createdBy: null,
    });
    const job = await mustCreate(
        store.create('fix the thing', null, {
            repo: null,
            executor: null,
            workflow: {
                id: (created as { id: string }).id,
                name: 'walk',
                node: walk.entry,
                snapshot: walk,
                params: {},
            },
        })
    );
    return job.id;
}

async function claim(on: JobStore = store): Promise<Claim> {
    const c = await on.claim(WORKER, LEASE_SECONDS);
    if (!c) throw new Error('nothing was claimable');
    return c;
}

const rowOf = async (id: string) => {
    const [row] = await sql<
        {
            status: string;
            output: string | null;
            failure_kind: string | null;
            lease_expires_at: Date;
            cancel_requested_at: Date | null;
            stopped_by: string | null;
            interruptions: { reason: string; claimSeq: number }[];
            attempts: number;
        }[]
    >`select status, output, failure_kind, lease_expires_at, cancel_requested_at, stopped_by, interruptions, attempts
      from job where org_id = ${ORG} and id = ${id}`;
    return row!;
};

const conclusions = (id: string) =>
    sql<{ lease_token: string; claim_seq: string; fingerprint: string; policy: unknown; reviewers: unknown }[]>`
        select lease_token, claim_seq, fingerprint, policy, reviewers from job_conclusion
        where org_id = ${ORG} and job_id = ${id}
    `;

const receipts = (id: string) =>
    sql<{ operation: string }[]>`select operation from job_settle_receipt where org_id = ${ORG} and job_id = ${id}`;

const threadOf = (root: string) =>
    sql<{ id: string; status: string }[]>`
        select id, status from job where org_id = ${ORG} and root_job_id = ${root} order by created_at, id
    `;

type PlanReader = NonNullable<CreateJobStoreDeps['plan']>;
type Plan = Awaited<ReturnType<PlanReader['readFor']>>;
const plan = (over: Partial<Plan> = {}): Plan =>
    ({ config: null, services: [], revision: null, error: null, ...over }) as Plan;

describe.skipIf(!enabled)('staged conclusions — database', () => {
    it('stages under a held lease, snapshots the policy and reviewers, and renews the lease', async () => {
        const reviewers: ReviewerSpec[] = [
            { name: 'security', instructions: 'look for leaks', timeoutMinutes: 5, connections: [] },
        ];
        const declared = createJobStore({
            sql,
            orgId: ORG,
            plan: { readFor: async () => plan({ policy: { gates: true }, reviewers }) },
        });
        const id = await queue(declared, 'acme/web');
        const c = await claim(declared);
        await sql`update job set lease_expires_at = now() + interval '5 seconds' where id = ${id}`;

        expect(await store.stageConclusion(id, c.leaseToken, succeeded, LEASE_SECONDS)).toEqual({ result: 'ok' });

        const [staged] = await conclusions(id);
        expect(staged).toMatchObject({
            lease_token: c.leaseToken,
            claim_seq: String(c.claimSeq),
            policy: { gates: true },
            reviewers,
        });
        expect((await rowOf(id)).lease_expires_at.getTime()).toBeGreaterThan(Date.now() + 200_000);
        expect((await rowOf(id)).status).toBe('running');
    });

    it('answers an identical restage ok, a different one conflict, keeping the first', async () => {
        const id = await queue();
        const c = await claim();
        await store.stageConclusion(id, c.leaseToken, succeeded, LEASE_SECONDS);

        expect(await store.stageConclusion(id, c.leaseToken, succeeded, LEASE_SECONDS)).toEqual({ result: 'ok' });
        expect(await store.stageConclusion(id, c.leaseToken, failed, LEASE_SECONDS)).toEqual({ result: 'conflict' });
        expect(await conclusions(id)).toHaveLength(1);
    });

    it('refuses a superseded or concluded lease as lost, and an unknown job as missing', async () => {
        const id = await queue();
        const old = await claim();
        await expireLease(sql, id);
        await claim();
        expect(await store.stageConclusion(id, old.leaseToken, succeeded, LEASE_SECONDS)).toEqual({ result: 'lost' });

        const done = await queue();
        const c = await claim();
        await store.complete(done, c.leaseToken, succeeded);
        expect(await store.stageConclusion(done, c.leaseToken, succeeded, LEASE_SECONDS)).toEqual({ result: 'lost' });

        expect(await store.stageConclusion(randomUUID(), c.leaseToken, succeeded, LEASE_SECONDS)).toEqual({
            result: 'missing',
        });
    });

    it('never commits a staged conclusion whose lease is still live', async () => {
        const id = await queue();
        const c = await claim();
        await store.stageConclusion(id, c.leaseToken, succeeded, LEASE_SECONDS);

        expect(await store.claim(WORKER, LEASE_SECONDS)).toBeNull();
        expect((await rowOf(id)).status).toBe('running');
    });

    // F1: an exhausted attempt whose lease expired after it staged is committed, never retired dead.
    it('commits an exhausted attempt’s staged verdict at the next claim instead of retiring it dead', async () => {
        const id = await queue();
        const c = await claim();
        await sql`update job set max_attempts = 1 where id = ${id}`;
        await spendInterruptionBudget(sql, id);
        await store.stageConclusion(id, c.leaseToken, succeeded, LEASE_SECONDS);
        await expireLease(sql, id);

        expect(await store.claim(WORKER, LEASE_SECONDS)).toBeNull();

        const row = await rowOf(id);
        expect(row).toMatchObject({ status: 'succeeded', output: 'did the work', failure_kind: null });
        expect(row.interruptions.at(-1)).toMatchObject({ reason: STAGED_COMMIT_REASON, claimSeq: c.claimSeq });
        expect(await receipts(id)).toEqual([{ operation: 'complete' }]);
    });

    it('lets a Stop stamped while the lease lived stand behind the staged verdict, walking no further', async () => {
        const root = await queueWorkflow();
        const c = await claim();
        await store.stageConclusion(root, c.leaseToken, succeeded, LEASE_SECONDS);
        expect(await store.stop(root, null)).toMatchObject({ result: 'requested' });
        await expireLease(sql, root);

        expect(await store.claim(WORKER, LEASE_SECONDS)).toBeNull();

        expect(await rowOf(root)).toMatchObject({ status: 'succeeded', cancel_requested_at: null });
        expect(await threadOf(root)).toHaveLength(1);
    });

    it('commits the staged verdict on a Stop after the expiry, answering its status as the conflict', async () => {
        const actor = await account(sql, randomGithubId(), 'stop-cat');
        const root = await queueWorkflow();
        const c = await claim();
        await store.stageConclusion(root, c.leaseToken, succeeded, LEASE_SECONDS);
        await expireLease(sql, root);

        expect(await store.stop(root, actor)).toEqual({ result: 'conflict', status: 'succeeded' });

        const row = await rowOf(root);
        expect(row).toMatchObject({ status: 'succeeded', stopped_by: actor, cancel_requested_at: null });
        expect(row.interruptions.at(-1)).toMatchObject({ reason: STAGED_COMMIT_REASON });
        expect(await threadOf(root)).toHaveLength(1);
    });

    it('leaves a staged review to its own commit when its caller’s verdict stops the reviews', async () => {
        const security: ReviewerSpec = { name: 'security', instructions: 'leaks', timeoutMinutes: 5, connections: [] };
        const reviewing = createJobStore({
            sql,
            orgId: ORG,
            plan: { readFor: async () => plan({ reviewers: [security] }) },
        });
        const author = await account(sql, randomGithubId(), 'review-cat');
        const created = await reviewing.create('ship it', author, { repo: 'acme/web', executor: null });
        if (typeof created === 'string') throw new Error(created);
        const caller = await claim(reviewing);
        const asked = await reviewing.requestReview(caller.id, caller.leaseToken, {
            key: 'sec-1',
            profile: 'security',
            revision: 'h:2',
            ref: reviewRefOf(caller.id, 'sec-1'),
        });
        if (asked.result !== 'created' || !asked.claim) throw new Error(`review not created: ${asked.result}`);
        const review = asked.claim;
        expect(review.id).not.toBe(caller.id);
        await reviewing.stageConclusion(review.id, review.leaseToken, succeeded, LEASE_SECONDS);
        await expireLease(sql, review.id);

        await reviewing.complete(caller.id, caller.leaseToken, succeeded);
        expect((await rowOf(review.id)).status).toBe('running');

        await reviewing.claim(WORKER, LEASE_SECONDS);
        expect((await rowOf(review.id)).status).toBe('succeeded');
    });

    // F3: the commit is the claim's first statement, before any remote read.
    it('commits a staged row even when the claim’s plan read then throws', async () => {
        let down = false;
        const flaky = createJobStore({
            sql,
            orgId: ORG,
            plan: {
                readFor: async () => {
                    if (down) throw new Error('github is down');
                    return plan();
                },
            },
        });
        const id = await queue(flaky, 'acme/web');
        const c = await claim(flaky);
        await flaky.stageConclusion(id, c.leaseToken, succeeded, LEASE_SECONDS);
        await expireLease(sql, id);
        await queue(flaky, 'acme/web');
        down = true;

        await expect(flaky.claim(WORKER, LEASE_SECONDS)).rejects.toThrow('github is down');

        expect((await rowOf(id)).status).toBe('succeeded');
        expect(await receipts(id)).toEqual([{ operation: 'complete' }]);
    });

    // F4: the board judges the staged verdict by the policy the attempt ran under.
    it('commits by the policy snapshot, not a policy stamped after the stage', async () => {
        let policy: EvidencePolicy | undefined;
        const declared = createJobStore({
            sql,
            orgId: ORG,
            plan: { readFor: async () => plan(policy ? { policy } : {}) },
        });
        const id = await queue(declared, 'acme/web');
        const c = await claim(declared);
        await declared.stageConclusion(id, c.leaseToken, succeeded, LEASE_SECONDS);
        policy = { gates: true };
        await sql`update job set policy = ${sql.json({ gates: true })} where id = ${id}`;
        await expireLease(sql, id);

        await declared.claim(WORKER, LEASE_SECONDS);

        expect(await rowOf(id)).toMatchObject({ status: 'succeeded', failure_kind: null });
    });

    it('rewrites a staged success its snapshot policy refuses to a failed policy verdict', async () => {
        const declared = createJobStore({
            sql,
            orgId: ORG,
            plan: { readFor: async () => plan({ policy: { gates: true } }) },
        });
        const id = await queue(declared, 'acme/web');
        const c = await claim(declared);
        await declared.stageConclusion(id, c.leaseToken, succeeded, LEASE_SECONDS);
        await expireLease(sql, id);

        await declared.claim(WORKER, LEASE_SECONDS);

        expect(await rowOf(id)).toMatchObject({ status: 'failed', failure_kind: 'policy' });

        const passing = await queue(declared, 'acme/web');
        const p = await claim(declared);
        expect(p.id).toBe(passing);
        await declared.stageConclusion(passing, p.leaseToken, { ...succeeded, evidence: PASSED }, LEASE_SECONDS);
        await expireLease(sql, passing);
        await declared.claim(WORKER, LEASE_SECONDS);
        expect(await rowOf(passing)).toMatchObject({ status: 'succeeded', failure_kind: null });
    });

    // Case b: the board committed it, then the original holder's complete arrives.
    it('answers the original holder’s identical complete after the board committed it', async () => {
        const id = await queue();
        const c = await claim();
        await store.stageConclusion(id, c.leaseToken, succeeded, LEASE_SECONDS);
        await expireLease(sql, id);
        await store.claim(WORKER, LEASE_SECONDS);

        expect(await store.complete(id, c.leaseToken, succeeded)).toEqual({
            result: 'ok',
            threadDone: false,
            reclaimId: null,
        });
        expect(await receipts(id)).toHaveLength(1);
    });

    it('commits once when the driver’s complete races the claim’s commit', async () => {
        const root = await queueWorkflow();
        const c = await claim();
        await store.stageConclusion(root, c.leaseToken, succeeded, LEASE_SECONDS);
        await expireLease(sql, root);

        const [completed] = await Promise.all([
            store.complete(root, c.leaseToken, succeeded),
            store.claim(WORKER, LEASE_SECONDS),
        ]);

        expect(completed).toMatchObject({ result: 'ok' });
        expect(await receipts(root)).toHaveLength(1);
        expect(await threadOf(root)).toHaveLength(2);
    });

    it('removes a thread’s staged conclusions with the thread', async () => {
        const id = await queue();
        const c = await claim();
        await store.stageConclusion(id, c.leaseToken, succeeded, LEASE_SECONDS);
        await store.complete(id, c.leaseToken, succeeded);

        expect(await store.removeThread(id, null)).not.toBe('conflict');
        expect(await conclusions(id)).toEqual([]);
    });
});

/** Amendment (R2 finding 2): a staged conclusion is the attempt's outcome, binding on the board. */
describe.skipIf(!enabled)('a staged conclusion binds the attempt — database', () => {
    it('refuses a different complete under the staged lease, and commits the staged one later', async () => {
        const id = await queue();
        const c = await claim();
        await store.stageConclusion(id, c.leaseToken, succeeded, LEASE_SECONDS);

        expect(await store.complete(id, c.leaseToken, failed)).toEqual({ result: 'conflict' });
        expect((await rowOf(id)).status).toBe('running');

        await expireLease(sql, id);
        await store.claim(WORKER, LEASE_SECONDS);
        expect(await rowOf(id)).toMatchObject({ status: 'succeeded', output: 'did the work' });
    });

    it('takes the identical complete as the ordinary verdict', async () => {
        const id = await queue();
        const c = await claim();
        await store.stageConclusion(id, c.leaseToken, succeeded, LEASE_SECONDS);

        expect(await store.complete(id, c.leaseToken, succeeded)).toMatchObject({ result: 'ok' });
        expect(await rowOf(id)).toMatchObject({ status: 'succeeded', interruptions: [] });
    });

    it.each([
        ['a suspend', (s: JobStore, id: string, token: string) => s.suspend(id, token)],
        [
            'a released interrupt',
            (s: JobStore, id: string, token: string) => s.interrupt(id, token, { reason: 'drained', release: true }),
        ],
    ])('refuses %s under a staged lease and strands nothing', async (_what, settle) => {
        const id = await queue();
        const c = await claim();
        await store.stageConclusion(id, c.leaseToken, succeeded, LEASE_SECONDS);

        expect(await settle(store, id, c.leaseToken)).toEqual({ result: 'conflict' });
        expect((await rowOf(id)).status).toBe('running');

        await expireLease(sql, id);
        await store.claim(WORKER, LEASE_SECONDS);
        expect((await rowOf(id)).status).toBe('succeeded');
    });
});

/**
 * Codex round 1: a settle decides on the staged conclusion only under the job row's lock, so a stage
 * that holds the row (its insert not yet committed) is waited out and then read, never overwritten;
 * and a Stop serializes with a staged lease expiring under it.
 */
describe.skipIf(!enabled)('a staged conclusion against concurrent settles — database', () => {
    /** Holds the row the way a stage does, and inserts its conclusion just before committing. */
    const stageHeld = (id: string, c: Claim) =>
        holdLock(
            sql,
            'row',
            id,
            (tx) =>
                tx`
                insert into job_conclusion (org_id, job_id, lease_token, claim_seq, fingerprint, result)
                values (${ORG}, ${id}, ${c.leaseToken}, ${c.claimSeq}, ${fingerprintOf(succeeded)},
                        ${tx.json(succeeded as never)})
            `
        );

    it.each([
        ['a different complete', (id: string, token: string) => store.complete(id, token, failed)],
        ['a suspend', (id: string, token: string) => store.suspend(id, token)],
        [
            'a released interrupt',
            (id: string, token: string) => store.interrupt(id, token, { reason: 'drained', release: true }),
        ],
    ])('refuses %s that raced a stage still holding the row', async (_what, settle) => {
        const id = await queue();
        const c = await claim();
        const held = await stageHeld(id, c);

        const settling = settle(id, c.leaseToken);
        await expectStillLocked(settling);
        await held.release();

        expect(await settling).toEqual({ result: 'conflict' });
        expect((await rowOf(id)).status).toBe('running');
        await expireLease(sql, id);
        await store.claim(WORKER, LEASE_SECONDS);
        expect(await rowOf(id)).toMatchObject({ status: 'succeeded', output: 'did the work' });
    });

    it('commits a staged attempt whose lease expired while its Stop waited on the row', async () => {
        const actor = await account(sql, randomGithubId(), 'race-cat');
        const root = await queueWorkflow();
        const c = await claim();
        await store.stageConclusion(root, c.leaseToken, succeeded, LEASE_SECONDS);
        const held = await holdLock(
            sql,
            'row',
            root,
            (tx) => tx`update job set lease_expires_at = now() - interval '1 second' where id = ${root}`
        );

        const stopping = store.stop(root, actor);
        await expectStillLocked(stopping);
        await held.release();

        expect(await stopping).toEqual({ result: 'conflict', status: 'succeeded' });
        expect(await rowOf(root)).toMatchObject({ status: 'succeeded', stopped_by: actor, cancel_requested_at: null });
        expect(await threadOf(root)).toHaveLength(1);
    });
});

/**
 * Codex round 2: a staged conclusion the board cannot commit (here an exit code past the int4
 * column, inserted around the route's validation) is logged and skipped — still guarded, never
 * taken over or retired — and never blocks the rest of the org's claims. A Stop of it answers the
 * conflict of a row it cannot settle, still running.
 */
describe.skipIf(!enabled)('a staged conclusion the board cannot commit — database', () => {
    it('is skipped by the claim, which takes the next job, and a Stop answers it running', async () => {
        const poisoned = await queue();
        const c = await claim();
        const bad = { status: 'failed', exitCode: 2_147_483_648, output: 'too big' };
        await sql`
            insert into job_conclusion (org_id, job_id, lease_token, claim_seq, fingerprint, result)
            values (${ORG}, ${poisoned}, ${c.leaseToken}, ${c.claimSeq}, ${fingerprintOf(bad)}, ${sql.json(bad)})
        `;
        await expireLease(sql, poisoned);
        const healthy = await queue();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect((await store.claim(WORKER, LEASE_SECONDS))?.id).toBe(healthy);
            expect(errors).toHaveBeenCalledWith(expect.stringContaining(poisoned));
            expect(await rowOf(poisoned)).toMatchObject({ status: 'running', interruptions: [] });

            expect(await store.stop(poisoned, null)).toEqual({ result: 'conflict', status: 'running' });
            expect(await rowOf(poisoned)).toMatchObject({ status: 'running', cancel_requested_at: null });
        } finally {
            errors.mockRestore();
        }
    });
});

/**
 * Codex round 3: a stage that waits on the row past its lease renews from the moment it commits,
 * and the claim's retirement and stamped-stop sweeps decide on a row only after locking it, so a
 * stage committing under them is never retired dead or settled stopped.
 */
describe.skipIf(!enabled)('a slow stage against the claim sweeps — database', () => {
    const HELD_MS = 1500;
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('renews the lease from its commit, not from when it began waiting', async () => {
        const id = await queue();
        const c = await claim();
        const held = await holdLock(sql, 'row', id);

        const staging = store.stageConclusion(id, c.leaseToken, succeeded, 1);
        await pause(HELD_MS);
        await held.release();

        expect(await staging).toEqual({ result: 'ok' });
        const [row] = await sql<{ live: boolean }[]>`select lease_expires_at > now() as live from job where id = ${id}`;
        expect(row!.live).toBe(true);
    });

    /** Holds the row as a stage does, committing its conclusion on release with the lease still past. */
    const stageCommitting = (id: string, c: Claim) =>
        holdLock(
            sql,
            'row',
            id,
            (tx) =>
                tx`
                insert into job_conclusion (org_id, job_id, lease_token, claim_seq, fingerprint, result)
                values (${ORG}, ${id}, ${c.leaseToken}, ${c.claimSeq}, ${fingerprintOf(succeeded)},
                        ${tx.json(succeeded as never)})
            `
        );

    it.each([
        [
            'the dead retirement',
            async (id: string) => {
                await sql`update job set max_attempts = 1 where id = ${id}`;
                await spendInterruptionBudget(sql, id);
            },
        ],
        [
            'the stamped-stop settle',
            async (id: string) => {
                await sql`update job set cancel_requested_at = now() where id = ${id}`;
            },
        ],
    ])('never lets %s take a row a stage commits under it', async (_what, prepare) => {
        const id = await queue();
        const c = await claim();
        await prepare(id);
        await expireLease(sql, id);
        const held = await stageCommitting(id, c);

        const claiming = store.claim(WORKER, LEASE_SECONDS);
        await pause(HELD_MS / 3);
        await held.release();
        await claiming;

        expect((await rowOf(id)).status).toBe('running');
        await store.claim(WORKER, LEASE_SECONDS);
        expect(await rowOf(id)).toMatchObject({ status: 'succeeded', output: 'did the work' });
    });
});
