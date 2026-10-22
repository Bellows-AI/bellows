import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { AdmissionBudgets } from '../src/db/job-store-admission.js';
import type { Claim, JobStore } from '../src/db/job-store-types.js';
import { fairBoardScan } from '../src/routes/job-context.js';
import { useTestDb } from './harness.js';
import { type CraftShape, craftJob, expireLease, testOrg } from './fixtures.js';

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

const craft = (org: string, shape: CraftShape) => craftJob({ sql, org, author: '' }, { author: null, ...shape });
const queued = (org: string, repo: string, createdMinutesAgo: number) => craft(org, { repo, createdMinutesAgo });

/** One board replica: its own scanner over the same two org boards, as each dashboard pod has. */
function replica(admission: AdmissionBudgets) {
    const boards = [ORG_A, ORG_B].map((orgId) => createJobStore({ sql, orgId, admission }));
    const scan = fairBoardScan();
    return (worker: string) =>
        scan<Claim>(
            boards,
            (e) => {
                throw e;
            },
            (board: JobStore) => board.claim(worker, LEASE_SECONDS)
        );
}

const runningOf = async (org: string): Promise<number> => {
    const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from job where org_id = ${org} and status = 'running' and review_of is null
    `;
    return row!.n;
};

describe.skipIf(!enabled)('cross-org fairness on every replica (issue #831)', () => {
    it('two replicas polling once each admit one task from each org, not two from the busier one', async () => {
        // Org A floods the queue with older work; org B has one newer task.
        for (let i = 0; i < 6; i++) await queued(ORG_A, `acme/a${i}`, 60 - i);
        await queued(ORG_B, 'acme/b0', 1);
        const first = replica({ global: 2 });
        const second = replica({ global: 2 });

        await first('w1');
        await second('w2');
        expect(await runningOf(ORG_A)).toBe(1);
        expect(await runningOf(ORG_B)).toBe(1);
    });

    it("an org waiting for a lost attempt's takeover is served before a busier queue", async () => {
        const lost = await queued(ORG_B, 'acme/b-lost', 120);
        const scanB = replica({});
        expect((await scanB('w0'))?.id).toBe(lost);
        await expireLease(sql, lost);
        // Org A has fewer running rows and older queued work, and would win on those alone.
        for (let i = 0; i < 3; i++) await queued(ORG_A, `acme/a${i}`, 300 - i);
        await sql`update job set created_at = now() - interval '1 minute' where id = ${lost}`;

        expect((await replica({})('w1'))?.id).toBe(lost);
    });

    it('an org whose handed-over row waits for its new holder is served before older work elsewhere', async () => {
        const handed = await queued(ORG_B, 'acme/b-handed', 1);
        const claim = await replica({})('w0');
        expect(claim?.id).toBe(handed);
        await createJobStore({ sql, orgId: ORG_B }).interrupt(handed, claim!.leaseToken, {
            reason: 'drained',
            release: true,
        });
        for (let i = 0; i < 3; i++) await queued(ORG_A, `acme/a${i}`, 300 - i);

        expect((await replica({ global: 1 })('w1'))?.id).toBe(handed);
    });

    it('a takeover deferred by a failed preparation gives its org no priority', async () => {
        const lost = await queued(ORG_A, 'acme/a-lost', 120);
        await replica({})('w0');
        await expireLease(sql, lost);
        await sql`update job set claim_deferred_until = now() + interval '1 minute' where id = ${lost}`;
        await queued(ORG_A, 'acme/a-fresh', 300);
        const waiting = await queued(ORG_B, 'acme/b0', 1);

        expect((await replica({})('w1'))?.id).toBe(waiting);
    });

    it('inside an org a takeover comes before older queued work', async () => {
        const lost = await queued(ORG_A, 'acme/a-lost', 1);
        await replica({})('w0');
        await expireLease(sql, lost);
        await queued(ORG_A, 'acme/a-old', 300);

        expect((await replica({})('w1'))?.id).toBe(lost);
    });

    it('with equal running, the org whose oldest task has waited longest goes first', async () => {
        await queued(ORG_A, 'acme/a0', 5);
        const older = await queued(ORG_B, 'acme/b0', 50);

        expect((await replica({})('w1'))?.id).toBe(older);
    });
});
