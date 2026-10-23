import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStatus, JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { craftJob, testOrg } from './fixtures.js';

/**
 * Issue #821: the board's status transitions are explicit. Storage refuses any `job.status` move
 * outside the graph below (migration 084), whichever statement writes it; the completion policy's
 * `succeeded → failed` rewrite is allowed only inside the verdict's own transaction. A refused move is
 * a board bug, kept apart from a replayed settle (its receipt) and a stale one (`lost`).
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ max: 4, orgs: [ORG] });

const STATUSES: JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'dead', 'stopped'];
/** Every `job.status` move the board makes; the policy rewrite is tested on its own below. */
const ALLOWED: [JobStatus, JobStatus][] = [
    ['queued', 'running'],
    ['queued', 'stopped'],
    ['running', 'queued'],
    ['running', 'succeeded'],
    ['running', 'failed'],
    ['running', 'dead'],
    ['running', 'stopped'],
];
const POLICY_REWRITE: [JobStatus, JobStatus] = ['succeeded', 'failed'];
const FORBIDDEN = STATUSES.flatMap((from) =>
    STATUSES.filter((to) => to !== from)
        .map((to): [JobStatus, JobStatus] => [from, to])
        .filter(([f, t]) => ![...ALLOWED, POLICY_REWRITE].some(([a, b]) => a === f && b === t))
);

let sql: Sql;
let store: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

const rowAt = (status: JobStatus) => craftJob({ sql, org: ORG, author: '' }, { status, repo: null, author: null });

const statusOf = async (id: string): Promise<JobStatus> => {
    const [row] = await sql<{ status: JobStatus }[]>`select status from job where org_id = ${ORG} and id = ${id}`;
    return row!.status;
};

const refusal = { code: '23514', constraint_name: 'job_status_transition' };

const claimOnly = async (): Promise<Claim> => {
    const job = await store.create('do the thing', null, { repo: null, executor: null });
    if (typeof job === 'string') throw new Error(job);
    const claim = await store.claim('worker-1', 300);
    if (claim?.id !== job.id) throw new Error('the created job was not the one claimed');
    return claim;
};

describe.skipIf(!enabled)('job status transitions (issue #821)', () => {
    it('the spec covers every distinct status pair', () => {
        expect(ALLOWED.length + 1 + FORBIDDEN.length).toBe(STATUSES.length * (STATUSES.length - 1));
    });

    it('allows exactly the board transitions', async () => {
        for (const [from, to] of ALLOWED) {
            const id = await rowAt(from);
            await sql`update job set status = ${to} where org_id = ${ORG} and id = ${id}`;
            expect(await statusOf(id), `${from} -> ${to}`).toBe(to);
        }
    });

    it('refuses every other status move and leaves the row where it was', async () => {
        for (const [from, to] of FORBIDDEN) {
            const id = await rowAt(from);
            await expect(
                sql`update job set status = ${to} where org_id = ${ORG} and id = ${id}`,
                `${from} -> ${to}`
            ).rejects.toMatchObject(refusal);
            expect(await statusOf(id), `${from} -> ${to}`).toBe(from);
        }
    });

    it('a write that keeps the status is not a transition', async () => {
        const id = await rowAt('succeeded');
        await sql`update job set status = status, output = 'rewritten' where org_id = ${ORG} and id = ${id}`;
        expect(await statusOf(id)).toBe('succeeded');
    });

    it('rewrites succeeded to failed only as the policy refusal of the verdict transaction', async () => {
        const [from, to] = POLICY_REWRITE;
        const landed = await rowAt(from);
        await expect(sql`update job set status = ${to} where org_id = ${ORG} and id = ${landed}`).rejects.toMatchObject(
            refusal
        );
        // The marker is transaction-local: one set by an earlier transaction licenses nothing.
        await sql`select set_config('factory.policy_refusal', ${landed}, true)`;
        await expect(sql`update job set status = ${to} where org_id = ${ORG} and id = ${landed}`).rejects.toMatchObject(
            refusal
        );
        // Another row's marker licenses nothing either.
        const other = await rowAt(from);
        await expect(
            sql.begin(async (tx) => {
                await tx`select set_config('factory.policy_refusal', ${other}, true)`;
                await tx`update job set status = ${to} where org_id = ${ORG} and id = ${landed}`;
            })
        ).rejects.toMatchObject(refusal);
        await sql.begin(async (tx) => {
            await tx`select set_config('factory.policy_refusal', ${landed}, true)`;
            await tx`update job set status = ${to} where org_id = ${ORG} and id = ${landed}`;
        });
        expect(await statusOf(landed)).toBe(to);
    });

    it('complete refuses a status that is not an outcome, and writes nothing', async () => {
        const claim = await claimOnly();
        await expect(
            store.complete(claim.id, claim.leaseToken, { status: 'dead' as never, exitCode: 1, output: '' })
        ).rejects.toThrow();
        const [row] = await sql<{ status: JobStatus; lease_token: string | null }[]>`
            select status, lease_token from job where org_id = ${ORG} and id = ${claim.id}
        `;
        expect(row).toEqual({ status: 'running', lease_token: claim.leaseToken });
        const receipts = await sql`select 1 from job_settle_receipt where org_id = ${ORG} and job_id = ${claim.id}`;
        expect(receipts).toHaveLength(0);
        await expect(
            store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' })
        ).resolves.toMatchObject({ result: 'ok' });
    });

    it('a settle on a concluded attempt answers its receipt or lost, never the transition refusal', async () => {
        const claim = await claimOnly();
        const verdict = { status: 'succeeded', exitCode: 0, output: 'done' } as const;
        const first = await store.complete(claim.id, claim.leaseToken, verdict);
        expect(first).toMatchObject({ result: 'ok' });
        await expect(store.complete(claim.id, claim.leaseToken, verdict)).resolves.toEqual(first);
        await expect(
            store.complete(claim.id, claim.leaseToken, { status: 'failed', exitCode: 1, output: 'other' })
        ).resolves.toMatchObject({ result: 'lost' });
        await expect(store.suspend(claim.id, claim.leaseToken)).resolves.toMatchObject({ result: 'lost' });
        expect(await statusOf(claim.id)).toBe('succeeded');
    });
});
