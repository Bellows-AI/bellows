import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { PrOperationWrite } from '../src/db/jobs/job-store-pr-operations.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { expireLease, testOrg } from './fixtures.js';

/**
 * Issue #983: every managed publish operation (a PR the driver created, or reused) leaves one row on
 * the board under the attempt's lease. The operation id is minted by the driver per operation, so a
 * replayed verdict or a retried write adds nothing while two genuine operations on one PR are two rows.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const WORKER = 'driver-1';
const LEASE_SECONDS = 300;
const db = useTestDb({ max: 4, orgs: [ORG, OTHER_ORG] });

let sql: Sql;
let store: JobStore;
let other: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    other = createJobStore({ sql, orgId: OTHER_ORG });
});

async function claimed(on: JobStore = store): Promise<Claim> {
    const job = await on.create('do the thing', null, { repo: null, executor: null });
    if (typeof job === 'string') throw new Error(job);
    const c = await on.claim(WORKER, LEASE_SECONDS);
    if (!c) throw new Error('nothing was claimable');
    return c;
}

const operation = (over: Partial<PrOperationWrite> = {}): PrOperationWrite => ({
    operationId: randomUUID(),
    operation: 'created',
    repo: 'Bellows-AI/bellows',
    prNumber: 42,
    prUrl: 'https://github.com/Bellows-AI/bellows/pull/42',
    branch: 'fix/10',
    ...over,
});

interface Stored {
    org_id: string;
    job_id: string;
    operation_id: string;
    claim_seq: string;
    operation: string;
    repo: string;
    pr_number: number;
    pr_url: string;
    branch: string;
    created_at: Date;
}
const rowsOf = (id: string) =>
    sql<Stored[]>`select * from job_pr_operation where job_id = ${id} order by created_at, operation_id`;

describe.skipIf(!enabled)('PR operations', () => {
    it('stores the operation whole, under the job, its org and the claim that wrote it', async () => {
        const c = await claimed();
        const written = operation();
        expect(await store.writePrOperation(c.id, c.leaseToken, written)).toEqual({ result: 'ok' });
        const [row, ...rest] = await rowsOf(c.id);
        expect(rest).toEqual([]);
        expect(row).toMatchObject({
            org_id: ORG,
            job_id: c.id,
            operation_id: written.operationId,
            claim_seq: String(c.claimSeq),
            operation: 'created',
            repo: written.repo,
            pr_number: 42,
            pr_url: written.prUrl,
            branch: written.branch,
        });
        expect(row!.created_at).toBeInstanceOf(Date);
    });

    it('a repeated verdict writes no second operation', async () => {
        const c = await claimed();
        const written = operation();
        await store.writePrOperation(c.id, c.leaseToken, written);
        await store.writePrOperation(c.id, c.leaseToken, written);
        // A replay that disagrees about what the operation was never rewrites the first answer.
        await store.writePrOperation(c.id, c.leaseToken, { ...written, operation: 'reused' });
        const rows = await rowsOf(c.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ operation: 'created' });
    });

    it('two genuine operations on one PR are two rows', async () => {
        const c = await claimed();
        const created = operation();
        const reused = operation({ operation: 'reused' });
        await store.writePrOperation(c.id, c.leaseToken, created);
        await store.writePrOperation(c.id, c.leaseToken, reused);
        const rows = await rowsOf(c.id);
        expect(rows.map((r) => [r.operation_id, r.operation, r.pr_number]).sort()).toEqual(
            [
                [created.operationId, 'created', 42],
                [reused.operationId, 'reused', 42],
            ].sort()
        );
    });

    it('refuses a write under a lease that was lost, and stores nothing', async () => {
        const c = await claimed();
        expect(await store.writePrOperation(c.id, randomUUID(), operation())).toEqual({ result: 'lost' });
        await expireLease(sql, c.id);
        const next = await store.claim(WORKER, LEASE_SECONDS);
        expect(next?.id).toBe(c.id);
        expect(await store.writePrOperation(c.id, c.leaseToken, operation())).toEqual({ result: 'lost' });
        expect(await rowsOf(c.id)).toHaveLength(0);
        // The next holder records under its own lease and its own claim.
        expect(await store.writePrOperation(c.id, next!.leaseToken, operation())).toEqual({ result: 'ok' });
        expect((await rowsOf(c.id))[0]).toMatchObject({ claim_seq: String(next!.claimSeq) });
    });

    it('answers missing for an unknown job, and writes nothing across organizations', async () => {
        const c = await claimed();
        expect(await store.writePrOperation(randomUUID(), randomUUID(), operation())).toEqual({ result: 'missing' });
        expect(await other.writePrOperation(c.id, c.leaseToken, operation())).toEqual({ result: 'missing' });
        expect(await rowsOf(c.id)).toHaveLength(0);
    });

    it('is removed with its job', async () => {
        const c = await claimed();
        await store.writePrOperation(c.id, c.leaseToken, operation());
        await sql`delete from job where id = ${c.id}`;
        expect(await rowsOf(c.id)).toHaveLength(0);
    });
});
