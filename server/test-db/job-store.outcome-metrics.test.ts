import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { reviewRefOf } from '../src/db/jobs/job-store-reviews.js';
import { fingerprintOf } from '../src/db/jobs/job-store-receipts.js';
import type { Claim, CreateJobStoreDeps, JobStore, ReviewerSpec } from '../src/db/jobs/job-store-types.js';
import { boardMetrics, countOf, type MetricsHarness } from '../test/helpers-metrics.js';
import { captureLogs } from '../test/helpers-log.js';
import { account, expireLease, randomGithubId, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The board's attempt-outcome counters: every interruption a committed transaction appended and every verdict or dead
 * retirement it settled, counted after the commit from the row it wrote — never from the request, never for a replay,
 * never for a rolled-back transaction.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const WORKER = 'driver-1';
const LEASE_SECONDS = 300;
const INTERRUPTIONS = 'bellows.job.interruptions';
const SETTLED = 'bellows.job.settled';
const db = useTestDb({ max: 6, orgs: [ORG] });

let sql: Sql;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
});

type PlanReader = NonNullable<CreateJobStoreDeps['plan']>;
type Plan = Awaited<ReturnType<PlanReader['readFor']>>;

const SECURITY: ReviewerSpec = {
    name: 'security',
    instructions: 'Look for leaked secrets.',
    timeoutMinutes: 7,
    connections: [],
};

/** A store reporting into a fresh in-memory meter, its plan answering `plan`. */
const counted = (plan: Partial<Plan> = {}): { store: JobStore; harness: MetricsHarness } => {
    const { metrics, harness } = boardMetrics();
    const store = createJobStore({
        sql,
        orgId: ORG,
        metrics: metrics.claim,
        plan: { readFor: async () => ({ config: null, services: [], revision: null, error: null, ...plan }) as Plan },
        githubApp: true,
    });
    return { store, harness };
};

async function queued(store: JobStore, repo: string | null = null): Promise<string> {
    const job = await store.create('do the thing', await account(sql, randomGithubId(), 'outcome-cat'), {
        repo,
        executor: null,
    });
    if (typeof job === 'string') throw new Error(job);
    return job.id;
}

async function claim(store: JobStore): Promise<Claim> {
    const c = await store.claim(WORKER, LEASE_SECONDS);
    if (!c) throw new Error('nothing was claimable');
    return c;
}

const succeeded = { status: 'succeeded', exitCode: 0, output: 'did the work' } as const;
/** A verdict the storage refuses (`exit_code` is an int): its commit throws and rolls back. */
const UNSTORABLE = { status: 'failed', exitCode: 2_147_483_648, output: 'too big' };

const statusOf = async (id: string) =>
    (await sql<{ status: string }[]>`select status from job where org_id = ${ORG} and id = ${id}`)[0]!.status;

/** Stages a conclusion the board cannot commit, then expires the lease. */
async function stageUnstorable(id: string, c: Claim): Promise<void> {
    await sql`
        insert into job_conclusion (org_id, job_id, lease_token, claim_seq, fingerprint, result)
        values (${ORG}, ${id}, ${c.leaseToken}, ${c.claimSeq}, ${fingerprintOf(UNSTORABLE)}, ${sql.json(UNSTORABLE)})
    `;
    await expireLease(sql, id);
}

describe.skipIf(!enabled)('interruption counters — database', () => {
    it('counts a node-loss hand-back refunded, and its replay not again', async () => {
        const { store, harness } = counted();
        const id = await queued(store);
        const c = await claim(store);
        const drained = { reason: 'the node was drained', release: true, nodeLoss: true };
        expect(await store.interrupt(id, c.leaseToken, drained)).toMatchObject({ result: 'ok' });
        expect(await store.interrupt(id, c.leaseToken, drained)).toMatchObject({ result: 'ok' });
        const points = await harness.points(INTERRUPTIONS);
        expect(countOf(points, { cause: 'node_loss', refunded: true })).toBe(1);
        expect(points).toHaveLength(1);
    });

    it('counts the third consecutive dockerd loss unrefunded', async () => {
        const { store, harness } = counted();
        const id = await queued(store);
        const lost = { reason: 'the docker daemon was lost', release: true, nodeLoss: true, daemonLoss: true };
        for (let round = 0; round < 3; round += 1) await store.interrupt(id, (await claim(store)).leaseToken, lost);
        const points = await harness.points(INTERRUPTIONS);
        expect(countOf(points, { cause: 'daemon_loss', refunded: true })).toBe(2);
        expect(countOf(points, { cause: 'daemon_loss', refunded: false })).toBe(1);
    });

    it('counts an adoption of an attempt its takeover already recorded once in total', async () => {
        const { store, harness } = counted();
        const id = await queued(store);
        const first = await claim(store);
        await expireLease(sql, id);
        const adopter = await claim(store);
        expect(
            await store.interrupt(id, adopter.leaseToken, {
                reason: 'adopted',
                release: false,
                claimSeq: first.claimSeq,
            })
        ).toMatchObject({ result: 'ok' });
        const points = await harness.points(INTERRUPTIONS);
        expect(countOf(points, { cause: 'lease_expired', refunded: true })).toBe(1);
        expect(points).toHaveLength(1);
    });

    it('counts a running review re-leased to its caller’s next claim once, and its replay not again', async () => {
        const { store, harness } = counted({ reviewers: [SECURITY] });
        const id = await queued(store, 'acme/web');
        const caller = await claim(store);
        const request = { key: 'sec-1', profile: 'security', revision: 'h:2', ref: reviewRefOf(id, 'sec-1') };
        expect(await store.requestReview(caller.id, caller.leaseToken, request)).toMatchObject({ result: 'created' });
        await expireLease(sql, id);
        const reclaimed = await claim(store);
        expect(await store.requestReview(id, reclaimed.leaseToken, request)).toMatchObject({ result: 'existing' });
        expect(await store.readReview(id, reclaimed.leaseToken, 'sec-1')).toMatchObject({ result: 'ok' });
        const points = await harness.points(INTERRUPTIONS);
        expect(countOf(points, { cause: 'review_lease_expired', refunded: true })).toBe(1);
    });
});

describe.skipIf(!enabled)('settle counters — database', () => {
    it('counts a failed verdict by its failure kind, and the identical verdict replayed not again', async () => {
        const { store, harness } = counted();
        const id = await queued(store);
        const c = await claim(store);
        const verdict = { status: 'failed', exitCode: 1, output: 'timed out', failureKind: 'timeout' } as const;
        expect(await store.complete(id, c.leaseToken, verdict)).toMatchObject({ result: 'ok' });
        expect(await store.complete(id, c.leaseToken, verdict)).toMatchObject({ result: 'ok' });
        const points = await harness.points(SETTLED);
        expect(countOf(points, { outcome: 'failed', cause: 'timeout' })).toBe(1);
        expect(points).toHaveLength(1);
    });

    it('counts a success the evidence policy refused as the failed policy verdict it landed as', async () => {
        const { store, harness } = counted({ policy: { gates: true } });
        const id = await queued(store, 'acme/web');
        const c = await claim(store);
        expect(await store.complete(id, c.leaseToken, succeeded)).toMatchObject({ result: 'ok' });
        expect(await statusOf(id)).toBe('failed');
        const points = await harness.points(SETTLED);
        expect(countOf(points, { outcome: 'failed', cause: 'policy' })).toBe(1);
        expect(countOf(points, { outcome: 'succeeded', cause: 'none' })).toBeUndefined();
    });
});

describe.skipIf(!enabled)('staged conclusion counters — database', () => {
    it('counts a claim’s commit of an expired staged verdict once, and nothing on the next claim', async () => {
        const { store, harness } = counted();
        const id = await queued(store);
        const c = await claim(store);
        await store.stageConclusion(id, c.leaseToken, succeeded, LEASE_SECONDS);
        await expireLease(sql, id);
        expect(await store.claim(WORKER, LEASE_SECONDS)).toBeNull();
        expect(await store.claim(WORKER, LEASE_SECONDS)).toBeNull();
        expect(await statusOf(id)).toBe('succeeded');
        const interruptions = await harness.points(INTERRUPTIONS);
        expect(countOf(interruptions, { cause: 'staged_commit', refunded: false })).toBe(1);
        expect(interruptions).toHaveLength(1);
        const settles = await harness.points(SETTLED);
        expect(countOf(settles, { outcome: 'succeeded', cause: 'none' })).toBe(1);
        expect(settles).toHaveLength(1);
    });

    it('counts nothing for a staged commit that threw and rolled back', async () => {
        const { store, harness } = counted();
        const id = await queued(store);
        await stageUnstorable(id, await claim(store));
        const captured = captureLogs();
        try {
            expect(await store.claim(WORKER, LEASE_SECONDS)).toBeNull();
        } finally {
            captured.stop();
        }
        expect(await statusOf(id)).toBe('running');
        expect(await harness.points(INTERRUPTIONS)).toEqual([]);
        expect(await harness.points(SETTLED)).toEqual([]);
    });

    it('counts a Stop’s commit of an expired staged verdict once', async () => {
        const { store, harness } = counted();
        const id = await queued(store);
        const c = await claim(store);
        await store.stageConclusion(id, c.leaseToken, succeeded, LEASE_SECONDS);
        await expireLease(sql, id);
        expect(await store.stop(id, null)).toEqual({ result: 'conflict', status: 'succeeded' });
        expect(countOf(await harness.points(INTERRUPTIONS), { cause: 'staged_commit', refunded: false })).toBe(1);
        expect(countOf(await harness.points(SETTLED), { outcome: 'succeeded', cause: 'none' })).toBe(1);
    });

    it('counts nothing for a Stop whose staged commit rolled back its savepoint', async () => {
        const { store, harness } = counted();
        const id = await queued(store);
        await stageUnstorable(id, await claim(store));
        const captured = captureLogs();
        try {
            expect(await store.stop(id, null)).toEqual({ result: 'conflict', status: 'running' });
        } finally {
            captured.stop();
        }
        expect(await harness.points(INTERRUPTIONS)).toEqual([]);
        expect(await harness.points(SETTLED)).toEqual([]);
    });
});
