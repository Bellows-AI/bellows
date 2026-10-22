import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import { admissionLockKey, type AdmissionBudgets } from '../src/db/job-store-admission.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';
import {
    type CraftShape,
    craftJob,
    expectUnblocked,
    expireLease,
    spendInterruptionBudget,
    testOrg,
} from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);

const ORG_A = testOrg();
const ORG_B = testOrg();
const LEASE_SECONDS = 300;
const REPO_X = 'acme/x';
const REPO_Y = 'acme/y';

const db = useTestDb({ max: 12, orgs: [ORG_A, ORG_B] });
let sql: Sql;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
});

const storeFor = (orgId: string, admission?: AdmissionBudgets): JobStore =>
    createJobStore({ sql, orgId, ...(admission ? { admission } : {}) });

/** An authorless row, in whatever state the case needs. */
const craft = (org: string, shape: CraftShape) => craftJob({ sql, org, author: '' }, { author: null, ...shape });

/** A queued root, `olderByMinutes` before now so the queue order is the order of the calls. */
const queued = (org: string, repo: string | null = REPO_X, olderByMinutes = 0) =>
    craft(org, { repo, createdMinutesAgo: olderByMinutes });

/** A worker still holding a running row that took no slot: claimed before any budget existed. */
const runningUnslotted = (org: string, repo: string | null = REPO_X) =>
    craft(org, { repo, status: 'running', lease: 'live', startedMinutesAgo: 1 });

const runningCount = async (where = sql`true`): Promise<number> => {
    const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from job where status = 'running' and review_of is null and ${where}
    `;
    return row!.n;
};

describe.skipIf(!enabled)('shared admission budgets', () => {
    it('refuses new work past the global budget across orgs, and admits it once a slot frees', async () => {
        const a = storeFor(ORG_A, { global: 2 });
        const b = storeFor(ORG_B, { global: 2 });
        await queued(ORG_A, REPO_X, 3);
        await queued(ORG_B, REPO_X, 2);
        const last = await queued(ORG_A, REPO_X, 1);

        const first = await a.claim('w1', LEASE_SECONDS);
        expect(await b.claim('w2', LEASE_SECONDS)).not.toBeNull();
        expect(await a.claim('w3', LEASE_SECONDS)).toBeNull();

        await a.complete(first!.id, first!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        expect((await a.claim('w3', LEASE_SECONDS))?.id).toBe(last);
    });

    it('caps one org without touching another', async () => {
        const a = storeFor(ORG_A, { org: 1 });
        const b = storeFor(ORG_B, { org: 1 });
        await queued(ORG_A, REPO_X, 3);
        await queued(ORG_A, REPO_Y, 2);
        await queued(ORG_B, REPO_X, 1);

        expect(await a.claim('w1', LEASE_SECONDS)).not.toBeNull();
        expect(await a.claim('w2', LEASE_SECONDS)).toBeNull();
        expect(await b.claim('w3', LEASE_SECONDS)).not.toBeNull();
    });

    it('a full repo does not hold up the rest of its org, and its waiting row keeps its place', async () => {
        const a = storeFor(ORG_A, { repo: 1 });
        await queued(ORG_A, REPO_X, 3);
        const waiting = await queued(ORG_A, REPO_X, 2);
        const other = await queued(ORG_A, REPO_Y, 1);

        await a.claim('w1', LEASE_SECONDS);
        expect((await a.claim('w2', LEASE_SECONDS))?.id).toBe(other);
        expect(await a.claim('w3', LEASE_SECONDS)).toBeNull();

        const [row] = await sql<{ claim_deferred_until: Date | null }[]>`
            select claim_deferred_until from job where id = ${waiting}
        `;
        expect(row!.claim_deferred_until).toBeNull();
    });

    it('concurrent claimers across orgs never exceed the global budget', async () => {
        const LIMIT = 3;
        const stores = [ORG_A, ORG_B].map((org) => storeFor(org, { global: LIMIT }));
        for (let i = 0; i < 4; i++) {
            await queued(ORG_A, `acme/a${i}`, 10 - i);
            await queued(ORG_B, `acme/b${i}`, 10 - i);
        }
        const CLAIMERS = 8;
        const claims = await Promise.all(
            Array.from({ length: CLAIMERS }, (_, i) => stores[i % 2]!.claim(`w${i}`, LEASE_SECONDS))
        );
        expect(claims.filter((c) => c !== null)).toHaveLength(LIMIT);
        expect(await runningCount()).toBe(LIMIT);
    });

    it('rows running before the budget existed count against it, even under concurrent claims', async () => {
        const LIMIT = 3;
        await runningUnslotted(ORG_A);
        await runningUnslotted(ORG_B);
        for (let i = 0; i < 4; i++) await queued(i % 2 === 0 ? ORG_A : ORG_B, `acme/r${i}`, 10 - i);
        const stores = [ORG_A, ORG_B].map((org) => storeFor(org, { global: LIMIT }));

        // Racing claimers that meet over moving the unslotted rows may all refuse for one poll, but
        // never admit past the budget; the moves they commit let the next polls fill it exactly.
        const CLAIMERS = 6;
        await Promise.all(Array.from({ length: CLAIMERS }, (_, i) => stores[i % 2]!.claim(`w${i}`, LEASE_SECONDS)));
        expect(await runningCount()).toBeLessThanOrEqual(LIMIT);
        for (let poll = 0; poll < CLAIMERS; poll++) await stores[poll % 2]!.claim(`p${poll}`, LEASE_SECONDS);
        expect(await runningCount()).toBe(LIMIT);
    });

    it('a slot another claimer holds is skipped, never waited on', async () => {
        const a = storeFor(ORG_A, { global: 2 });
        const id = await queued(ORG_A);
        const holder = await sql.reserve();
        try {
            await holder`select pg_advisory_lock(hashtextextended(${admissionLockKey('global', '', 1)}, 0))`;
            expect((await expectUnblocked(a.claim('w1', LEASE_SECONDS)))?.id).toBe(id);
            const [row] = await sql<{ slot: number }[]>`select admission_slot_global as slot from job where id = ${id}`;
            expect(row!.slot).toBe(2);
        } finally {
            await holder`select pg_advisory_unlock_all()`;
            holder.release();
        }
    });

    it('lowering a limit admits nothing until occupancy drains below it', async () => {
        const wide = storeFor(ORG_A, { global: 3 });
        for (let i = 0; i < 3; i++) await queued(ORG_A, `acme/l${i}`, 10 - i);
        const claims: Awaited<ReturnType<JobStore['claim']>>[] = [];
        for (let i = 0; i < 3; i++) claims.push(await wide.claim(`w${i}`, LEASE_SECONDS));
        // Slot 1 frees; slots 2 and 3 stay held. Under a limit of 2 that is already full.
        await wide.complete(claims[0]!.id, claims[0]!.leaseToken, { status: 'succeeded', exitCode: 0, output: '' });
        await queued(ORG_A, 'acme/l-next');

        const narrow = storeFor(ORG_A, { global: 2 });
        expect(await narrow.claim('w9', LEASE_SECONDS)).toBeNull();
        expect(await runningCount()).toBe(2);
    });

    it('a crashed owner keeps its slot, and its takeover needs no free one', async () => {
        const a = storeFor(ORG_A, { global: 1 });
        const crashed = await queued(ORG_A, REPO_X, 2);
        await queued(ORG_A, REPO_Y, 1);
        await a.claim('w1', LEASE_SECONDS);
        await expireLease(sql, crashed);

        const takeover = await a.claim('w2', LEASE_SECONDS);
        expect(takeover).toMatchObject({ id: crashed, continuesInterrupted: false });
        expect(await a.claim('w3', LEASE_SECONDS)).toBeNull();
    });

    it('an exhausted crashed row is retired and its slot admits queued work in the same poll', async () => {
        const a = storeFor(ORG_A, { global: 1 });
        const crashed = await queued(ORG_A, REPO_X, 2);
        const next = await queued(ORG_A, REPO_Y, 1);
        await a.claim('w1', LEASE_SECONDS);
        await spendInterruptionBudget(sql, crashed);
        await sql`update job set attempts = max_attempts where id = ${crashed}`;
        await expireLease(sql, crashed);

        expect((await a.claim('w2', LEASE_SECONDS))?.id).toBe(next);
        const [row] = await sql<{ status: string }[]>`select status from job where id = ${crashed}`;
        expect(row!.status).toBe('dead');
    });

    it('a review row is never counted', async () => {
        const a = storeFor(ORG_A, { global: 1 });
        const caller = await craft(ORG_A, { status: 'succeeded' });
        const review = await runningUnslotted(ORG_A);
        await sql`
            update job set review_of = ${caller}, review_key = 'k', review_profile = 'p',
                           review_spec = '{}'::jsonb, review_revision = 'r', review_ref = 'ref'
            where id = ${review}
        `;
        const id = await queued(ORG_A, REPO_Y);

        expect((await a.claim('w1', LEASE_SECONDS))?.id).toBe(id);
    });

    it('a handed-over row frees its slot and is offered ahead of older queued work', async () => {
        const a = storeFor(ORG_A, { global: 1 });
        await queued(ORG_A, REPO_Y, 30);
        const handed = await queued(ORG_A, REPO_X, 60);
        const claim = await a.claim('w1', LEASE_SECONDS);
        expect(claim?.id).toBe(handed);
        await sql`update job set session_id = ${'session-of-the-handed-over-run'} where id = ${handed}`;
        // A newer row queued before the release: oldest-first alone would offer it first.
        await sql`update job set created_at = now() - interval '90 minutes' where id <> ${handed} and org_id = ${ORG_A}`;
        await a.interrupt(handed, claim!.leaseToken, { reason: 'drained', release: true });

        expect((await a.claim('w2', LEASE_SECONDS))?.id).toBe(handed);
    });

    it('without a budget nothing is refused', async () => {
        const a = storeFor(ORG_A);
        for (let i = 0; i < 3; i++) await queued(ORG_A, REPO_X + i, 3 - i);
        for (let i = 0; i < 3; i++) expect(await a.claim(`w${i}`, LEASE_SECONDS)).not.toBeNull();
    });
});
