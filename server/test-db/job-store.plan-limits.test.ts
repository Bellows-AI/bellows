import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { loadConfig } from '../src/config.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { AdmissionBudgets } from '../src/db/jobs/job-store-admission.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { PlanLimitError, type PlanLimits, planLimits } from '../src/db/plan-limits.js';
import { fairBoardScan } from '../src/routes/jobs/job-context.js';
import { useTestDb } from './harness.js';
import { craftJob, testOrg } from './fixtures.js';

/**
 * The per-organization limits a plan sets (docs/commerce.md): the running cap the claim admits under,
 * the queued cap the create refuses at, the wall time the heartbeat stops a run past, the cap-weighted
 * claim order, and the stated default an org with no pushed plan gets.
 */

const enabled = Boolean(process.env.DATABASE_URL);

const ORG_A = testOrg();
const ORG_B = testOrg();
const LEASE_SECONDS = 300;

const db = useTestDb({ max: 12, orgs: [ORG_A, ORG_B] });
let sql: Sql;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
});

const storeFor = (orgId: string, planDefaults: PlanLimits = {}, admission: AdmissionBudgets = {}): JobStore =>
    createJobStore({ sql, orgId, planDefaults, admission });

const queued = (org: string, createdMinutesAgo = 0) =>
    craftJob({ sql, org, author: '' }, { author: null, repo: null, createdMinutesAgo });

/** The plan the commerce service pushed for `org`, with the limits it carries. */
const pushPlan = (org: string, limits: { running?: number; queued?: number; wallSeconds?: number }) => sql`
    insert into org_plan (org_id, plan, version, max_running, max_queued, max_wall_seconds)
    values (${org}, 'pro', 1, ${limits.running ?? null}, ${limits.queued ?? null}, ${limits.wallSeconds ?? null})
`;

const runningOf = async (org: string): Promise<number> => {
    const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from job where org_id = ${org} and status = 'running' and review_of is null
    `;
    return row!.n;
};

const create = (store: JobStore, key?: string) =>
    store.create('work', null, {
        repo: null,
        executor: null,
        ...(key ? { idempotency: { operation: 'create' as const, key, fingerprint: 'fp' } } : {}),
    });

type Served = { board: JobStore; claim: Claim; org: string };

/** One board replica's fair scan over both orgs: each call claims one row, or answers null. */
function scanner(admission: AdmissionBudgets): () => Promise<Served | null> {
    const orgs = [ORG_A, ORG_B];
    const boards = orgs.map((orgId) => storeFor(orgId, {}, admission));
    const scan = fairBoardScan();
    return async () => {
        let board: JobStore | null = null;
        const claim = await scan<JobStore, Claim>(
            boards,
            (e) => {
                throw e;
            },
            async (candidate, options) => {
                const claimed = await candidate.claim('w', LEASE_SECONDS, options);
                if (claimed) board = candidate;
                return claimed;
            }
        );
        return claim ? { board: board!, claim, org: orgs[boards.indexOf(board!)]! } : null;
    };
}

const finish = ({ board, claim }: Served) =>
    board.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });

describe.skipIf(!enabled)('plan limits per organization', () => {
    it('resolves an org with no pushed plan to the Free limits a cloud board requires, never unlimited', async () => {
        const cloud = loadConfig(
            {
                DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_dev',
                DEPLOYMENT_MODE: 'cloud',
                PLAN_DEFAULT_MAX_RUNNING: '1',
                PLAN_DEFAULT_MAX_QUEUED: '5',
                PLAN_DEFAULT_MAX_WALL_SECONDS: '3600',
            },
            { mode: 'none' }
        );
        expect(await planLimits(sql, ORG_A, cloud.planDefaults)).toEqual({ running: 1, queued: 5, wallSeconds: 3600 });
    });

    it('takes each limit from the pushed plan, and a limit the push left null from the default', async () => {
        await pushPlan(ORG_A, { running: 4 });
        expect(await planLimits(sql, ORG_A, { running: 1, queued: 5 })).toEqual({ running: 4, queued: 5 });
    });

    it('refuses a create at the queued cap, naming `queued`, and admits one once a queued row is claimed', async () => {
        await pushPlan(ORG_A, { queued: 2 });
        const store = storeFor(ORG_A);
        await create(store, 'plan-key-0001');
        await create(store);

        const refused = await create(store).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(PlanLimitError);
        expect(refused).toMatchObject({ limit: 'queued', max: 2 });
        // A replay of a recorded create answers its row whatever the cap says.
        expect(await create(store, 'plan-key-0001')).toMatchObject({ replayed: true });
        // Another org's queue is its own.
        await expect(create(storeFor(ORG_B, { queued: 1 }))).resolves.toMatchObject({ id: expect.any(String) });

        expect(await store.claim('w1', LEASE_SECONDS)).not.toBeNull();
        await expect(create(store)).resolves.toMatchObject({ id: expect.any(String) });
    });

    it('skips an org at its plan running cap while another org claims', async () => {
        await pushPlan(ORG_A, { running: 1 });
        const a = storeFor(ORG_A);
        const b = storeFor(ORG_B);
        await queued(ORG_A, 3);
        await queued(ORG_A, 2);
        await queued(ORG_B, 1);

        expect(await a.claim('w1', LEASE_SECONDS)).not.toBeNull();
        expect(await a.claim('w2', LEASE_SECONDS)).toBeNull();
        expect(await b.claim('w3', LEASE_SECONDS)).not.toBeNull();
        expect(await runningOf(ORG_A)).toBe(1);
    });

    it('caps an org with no pushed plan at the default running limit', async () => {
        const a = storeFor(ORG_A, { running: 1 });
        await queued(ORG_A, 2);
        await queued(ORG_A, 1);
        expect(await a.claim('w1', LEASE_SECONDS)).not.toBeNull();
        expect(await a.claim('w2', LEASE_SECONDS)).toBeNull();
    });

    it('answers stop with cause `wall-time` once the run passes its wall time, and records the cause', async () => {
        await pushPlan(ORG_A, { wallSeconds: 60 });
        const store = storeFor(ORG_A);
        await queued(ORG_A);
        const claim = (await store.claim('w1', LEASE_SECONDS))!;

        expect(await store.heartbeat(claim.id, claim.leaseToken, LEASE_SECONDS)).toMatchObject({
            cancelRequested: false,
            stopCause: null,
        });
        await sql`update job set started_at = now() - interval '2 minutes' where id = ${claim.id}`;
        expect(await store.heartbeat(claim.id, claim.leaseToken, LEASE_SECONDS)).toMatchObject({
            result: 'ok',
            cancelRequested: true,
            stopCause: 'wall-time',
        });
        // The driver parks the run as it parks any stop: a run outcome, never an infrastructure loss.
        expect(await store.suspend(claim.id, claim.leaseToken)).toMatchObject({ result: 'ok', status: 'stopped' });
        const [row] = await sql<{ stop_cause: string | null; interruptions: unknown[] }[]>`
            select stop_cause, interruptions from job where id = ${claim.id}
        `;
        expect(row).toEqual({ stop_cause: 'wall-time', interruptions: [] });
    });

    it("leaves a member's own stop without a cause", async () => {
        await pushPlan(ORG_A, { wallSeconds: 60 });
        const store = storeFor(ORG_A);
        await queued(ORG_A);
        const claim = (await store.claim('w1', LEASE_SECONDS))!;
        await store.stop(claim.id, null);
        await sql`update job set started_at = now() - interval '2 minutes' where id = ${claim.id}`;
        expect(await store.heartbeat(claim.id, claim.leaseToken, LEASE_SECONDS)).toMatchObject({
            cancelRequested: true,
            stopCause: null,
        });
    });

    it('gives two orgs with full queues runners in proportion to their caps, 2 and 4', async () => {
        await pushPlan(ORG_A, { running: 2 });
        await pushPlan(ORG_B, { running: 4 });
        // Org A's queue is older, so the order of fewest running alone would serve it first and as often as B.
        for (let i = 0; i < 12; i++) await queued(ORG_A, 600 - i);
        for (let i = 0; i < 12; i++) await queued(ORG_B, 300 - i);
        const next = scanner({ global: 3 });
        const served = { [ORG_A]: 0, [ORG_B]: 0 };
        for (let round = 0; round < 3; round++) {
            const held: Served[] = [];
            for (let one = await next(); one; one = await next()) {
                held.push(one);
                served[one.org] = (served[one.org] ?? 0) + 1;
            }
            for (const one of held) await finish(one);
        }
        expect(served).toEqual({ [ORG_A]: 3, [ORG_B]: 6 });
    });

    it('never starves an org when one slot refills at a time: equal shares go to the least recently served', async () => {
        await pushPlan(ORG_A, { running: 1 });
        await pushPlan(ORG_B, { running: 4 });
        // Both orgs read 0 running at every refill; org A's queue is older, which alone would win every refill.
        for (let i = 0; i < 10; i++) await queued(ORG_A, 600 - i);
        for (let i = 0; i < 10; i++) await queued(ORG_B, 300 - i);
        const next = scanner({ global: 1 });
        const order: string[] = [];
        for (let i = 0; i < 8; i++) {
            const one = (await next())!;
            order.push(one.org === ORG_A ? 'A' : 'B');
            await finish(one);
        }
        expect(order.join('')).toBe('ABABABAB');
    });
});
