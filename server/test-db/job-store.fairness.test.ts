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
function replica(
    admission: AdmissionBudgets,
    wrap: (board: JobStore, orgId: string) => JobStore = (board) => board,
    log: (e: Error) => void = (e) => {
        throw e;
    }
) {
    const boards = [ORG_A, ORG_B].map((orgId) => wrap(createJobStore({ sql, orgId, admission }), orgId));
    const scan = fairBoardScan();
    return (worker: string) =>
        scan<Claim>(boards, log, (board: JobStore, options) => board.claim(worker, LEASE_SECONDS, options));
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

    it('a poll whose claim was refused by the global budget admits no new work from a later board', async () => {
        // Org A runs one row and has two more queued; org B has one queued; the budget is two, so the poll starts with room.
        const budget = { global: 2 } as const;
        const heavy = createJobStore({ sql, orgId: ORG_A, admission: budget });
        const first = await queued(ORG_A, 'acme/a0', 60);
        await queued(ORG_A, 'acme/a1', 59);
        const firstClaim = await heavy.claim('w0', LEASE_SECONDS);
        expect(firstClaim?.id).toBe(first);
        await queued(ORG_A, 'acme/a2', 58);
        const light = await queued(ORG_B, 'acme/b0', 1);

        // Org B ranks first (fewest running). Before its claim another driver fills the budget, so the claim is
        // refused; then the first heavy row settles before the poll reaches org A, whose board would now admit a row.
        const poll = replica(budget, (board, orgId) =>
            orgId === ORG_B
                ? {
                      ...board,
                      claim: async (worker, leaseSeconds, options) => {
                          await heavy.claim('w-other', LEASE_SECONDS);
                          const refused = await board.claim(worker, leaseSeconds, options);
                          await heavy.complete(first, firstClaim!.leaseToken, {
                              status: 'succeeded',
                              exitCode: 0,
                              output: '',
                          });
                          return refused;
                      },
                  }
                : board
        );
        expect(await poll('w1')).toBeNull();
        expect(await runningOf(ORG_A)).toBe(1);
        expect(await runningOf(ORG_B)).toBe(0);

        // The next poll hands the freed slot to the org that was waiting.
        expect((await replica(budget)('w2'))?.id).toBe(light);
    });

    // The refusal interleaving of the test above, with the poll's later board varied (issue #831).
    const refusedPoll = async (
        mutate: (board: JobStore, orgId: string, settle: () => Promise<void>) => JobStore,
        log?: (e: Error) => void
    ) => {
        const budget = { global: 2 } as const;
        const heavy = createJobStore({ sql, orgId: ORG_A, admission: budget });
        const first = await queued(ORG_A, 'acme/a0', 60);
        await queued(ORG_A, 'acme/a1', 59);
        const firstClaim = await heavy.claim('w0', LEASE_SECONDS);
        await queued(ORG_A, 'acme/a2', 58);
        await queued(ORG_B, 'acme/b0', 1);
        const settle = async () => {
            await heavy.complete(first, firstClaim!.leaseToken, { status: 'succeeded', exitCode: 0, output: '' });
        };
        const fill = () => heavy.claim('w-other', LEASE_SECONDS);
        const poll = replica(budget, (board, orgId) => mutate({ ...board, fill } as JobStore, orgId, settle), log);
        return { poll, runningA: () => runningOf(ORG_A) };
    };

    it('claims a later board takeover-only after a global refusal, whatever its demand read said', async () => {
        const { poll, runningA } = await refusedPoll(
            (board, orgId, settle) => {
                if (orgId === ORG_A)
                    return { ...board, demand: async () => Promise.reject(new Error('demand read failed')) };
                return {
                    ...board,
                    claim: async (worker, leaseSeconds, options) => {
                        await (board as unknown as { fill: () => Promise<unknown> }).fill();
                        const refused = await board.claim(worker, leaseSeconds, options);
                        await settle();
                        return refused;
                    },
                };
            },
            () => {}
        );
        expect(await poll('w1')).toBeNull();
        expect(await runningA()).toBe(1);
    });

    it('keeps a global refusal when the claim throws after reporting it', async () => {
        const failures: Error[] = [];
        const { poll, runningA } = await refusedPoll(
            (board, orgId, settle) =>
                orgId === ORG_B
                    ? {
                          ...board,
                          claim: async (worker, leaseSeconds, options) => {
                              await (board as unknown as { fill: () => Promise<unknown> }).fill();
                              await board.claim(worker, leaseSeconds, options);
                              await settle();
                              throw new Error('claim failed after the refusal');
                          },
                      }
                    : board,
            (e) => failures.push(e)
        );
        await expect(poll('w1')).rejects.toThrow('claim failed after the refusal');
        expect(await runningA()).toBe(1);
        expect(failures).toHaveLength(1);
    });

    it('a takeover-only claim never admits a queued row, and still takes over an expired one', async () => {
        const budget = { global: 5 } as const;
        const board = createJobStore({ sql, orgId: ORG_A, admission: budget });
        const lost = await queued(ORG_A, 'acme/lost', 120);
        expect((await board.claim('w0', LEASE_SECONDS))?.id).toBe(lost);
        await queued(ORG_A, 'acme/new', 1);
        expect(await board.claim('w1', LEASE_SECONDS, { takeoverOnly: true })).toBeNull();
        await expireLease(sql, lost);
        expect((await board.claim('w2', LEASE_SECONDS, { takeoverOnly: true }))?.id).toBe(lost);
    });

    it('a takeover-only claim whose row was released while it prepared gives the deferral back', async () => {
        const budget = { global: 5 } as const;
        const lost = await queued(ORG_A, 'acme/lost', 120);
        expect((await createJobStore({ sql, orgId: ORG_A, admission: budget }).claim('w0', LEASE_SECONDS))?.id).toBe(
            lost
        );
        await expireLease(sql, lost);
        // The plan read is the claim's preparation: the old owner releases the row while it runs.
        const preparing = createJobStore({
            sql,
            orgId: ORG_A,
            admission: budget,
            plan: {
                readFor: async () => {
                    await sql`update job set status = 'queued' where id = ${lost}`;
                    return { config: null, services: [], revision: null, error: null };
                },
            },
        });
        expect(await preparing.claim('w1', LEASE_SECONDS, { takeoverOnly: true })).toBeNull();

        // Nothing is left of the reservation: the next poll, with room, claims the row at once.
        const [row] = await sql<
            { deferred: Date | null }[]
        >`select claim_deferred_until as deferred from job where id = ${lost}`;
        expect(row!.deferred).toBeNull();
        expect((await createJobStore({ sql, orgId: ORG_A, admission: budget }).claim('w2', LEASE_SECONDS))?.id).toBe(
            lost
        );
    });

    it('with equal running, the org whose oldest task has waited longest goes first', async () => {
        await queued(ORG_A, 'acme/a0', 5);
        const older = await queued(ORG_B, 'acme/b0', 50);

        expect((await replica({})('w1'))?.id).toBe(older);
    });
});
