import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { FinishPassWrite } from '../src/db/jobs/job-store-finish-passes.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { orgSql, REQUEST_ROLE } from '../src/db/org-sql.js';
import { boardPool } from '../src/db/pool.js';
import { useTestDb } from './harness.js';
import { expireLease, testOrg } from './fixtures.js';

/**
 * The finish-pass record (163): one row per answered finish pass of an attempt, written under its lease, idempotent
 * on the pass id. The failed rounds a job row has spent are a count of its `failed` rows across every claim of it —
 * a takeover reads the rounds its predecessor spent — and of no other row of the thread. Org-scoped like every
 * org table: another organization's session reads none of it.
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
let requestPool: Sql;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    other = createJobStore({ sql, orgId: OTHER_ORG });
    requestPool = boardPool(db.url as string, { max: 1, statementTimeoutMs: 10_000, role: REQUEST_ROLE });
});

afterAll(async () => {
    if (enabled) await requestPool.end({ timeout: 5 });
});

async function claimed(): Promise<Claim> {
    const job = await store.create('do the thing', null, { repo: null, executor: null });
    if (typeof job === 'string') throw new Error(job);
    const c = await store.claim(WORKER, LEASE_SECONDS);
    if (!c) throw new Error('nothing was claimable');
    return c;
}

const pass = (c: Claim, over: Partial<FinishPassWrite> = {}): FinishPassWrite => ({
    passId: randomUUID(),
    runClaimSeq: c.claimSeq,
    verdict: 'failed',
    gate: 'test',
    ...over,
});

const roundsOf = async (c: Claim, on: JobStore = store): Promise<number> => {
    const answer = await on.readFinishRounds(c.id, c.leaseToken);
    if (answer.result !== 'ok') throw new Error(`read answered ${answer.result}`);
    return answer.failedRounds;
};
const rowsOf = async (id: string): Promise<number> =>
    Number((await sql<{ n: string }[]>`select count(*) as n from job_finish_pass where job_id = ${id}`)[0]!.n);

/** Claims the row again after its lease expired: the takeover's claim. */
async function takeOver(c: Claim): Promise<Claim> {
    await expireLease(sql, c.id);
    const next = await store.claim(WORKER, LEASE_SECONDS);
    if (next?.id !== c.id) throw new Error('the takeover was not the claim');
    return next;
}

describe.skipIf(!enabled)('finish passes', () => {
    it('counts only the failed passes', async () => {
        const c = await claimed();
        expect(await roundsOf(c)).toBe(0);
        expect(await store.writeFinishPass(c.id, c.leaseToken, pass(c))).toEqual({ result: 'ok' });
        expect(await store.writeFinishPass(c.id, c.leaseToken, pass(c, { verdict: 'passed', gate: null }))).toEqual({
            result: 'ok',
        });
        expect(await store.writeFinishPass(c.id, c.leaseToken, pass(c, { gate: 'lint' }))).toEqual({ result: 'ok' });
        expect(await roundsOf(c)).toBe(2);
        expect(await rowsOf(c.id)).toBe(3);
    });

    it('is idempotent on the pass id: a replay changes nothing', async () => {
        const c = await claimed();
        const failed = pass(c);
        await store.writeFinishPass(c.id, c.leaseToken, failed);
        expect(await store.writeFinishPass(c.id, c.leaseToken, failed)).toEqual({ result: 'ok' });
        expect(await store.writeFinishPass(c.id, c.leaseToken, { ...failed, verdict: 'passed' })).toEqual({
            result: 'ok',
        });
        expect(await rowsOf(c.id)).toBe(1);
        expect(await roundsOf(c)).toBe(1);
    });

    it('refuses a write and a read under a lease that was lost, and stores nothing', async () => {
        const c = await claimed();
        expect(await store.writeFinishPass(c.id, randomUUID(), pass(c))).toEqual({ result: 'lost' });
        expect(await store.readFinishRounds(c.id, randomUUID())).toEqual({ result: 'lost' });
        const next = await takeOver(c);
        expect(await store.writeFinishPass(c.id, c.leaseToken, pass(c))).toEqual({ result: 'lost' });
        expect(await store.readFinishRounds(c.id, c.leaseToken)).toEqual({ result: 'lost' });
        expect(await rowsOf(c.id)).toBe(0);
        expect(await roundsOf(next)).toBe(0);
    });

    it('answers the recorded verdict of a known pass id, with the round a failed one holds, and null for an unknown one', async () => {
        const c = await claimed();
        const first = pass(c);
        const green = pass(c, { verdict: 'passed', gate: null });
        const second = pass(c, { gate: 'lint' });
        for (const each of [first, green, second]) await store.writeFinishPass(c.id, c.leaseToken, each);

        expect(await store.readFinishRounds(c.id, c.leaseToken, first.passId)).toEqual({
            result: 'ok',
            failedRounds: 2,
            pass: { verdict: 'failed', round: 1 },
        });
        expect(await store.readFinishRounds(c.id, c.leaseToken, second.passId)).toEqual({
            result: 'ok',
            failedRounds: 2,
            pass: { verdict: 'failed', round: 2 },
        });
        expect(await store.readFinishRounds(c.id, c.leaseToken, green.passId)).toEqual({
            result: 'ok',
            failedRounds: 2,
            pass: { verdict: 'passed' },
        });
        expect(await store.readFinishRounds(c.id, c.leaseToken, randomUUID())).toEqual({
            result: 'ok',
            failedRounds: 2,
            pass: null,
        });
    });

    it('answers a recorded pass id to a takeover, and to no lease that was lost', async () => {
        const c = await claimed();
        const failed = pass(c);
        await store.writeFinishPass(c.id, c.leaseToken, failed);
        const next = await takeOver(c);
        expect(await store.readFinishRounds(c.id, c.leaseToken, failed.passId)).toEqual({ result: 'lost' });
        expect(await store.readFinishRounds(next.id, next.leaseToken, failed.passId)).toEqual({
            result: 'ok',
            failedRounds: 1,
            pass: { verdict: 'failed', round: 1 },
        });
        expect(await other.readFinishRounds(c.id, next.leaseToken, failed.passId)).toEqual({ result: 'missing' });
    });

    it('counts the rounds of every claim of the job row: a takeover reads what its predecessor spent', async () => {
        const c = await claimed();
        await store.writeFinishPass(c.id, c.leaseToken, pass(c));
        const next = await takeOver(c);
        expect(next.claimSeq).toBeGreaterThan(c.claimSeq);
        expect(await roundsOf(next)).toBe(1);
        // The takeover resumes the run it took over and spends its next round on it.
        await store.writeFinishPass(next.id, next.leaseToken, pass(next, { runClaimSeq: c.claimSeq }));
        expect(await roundsOf(next)).toBe(2);
    });

    it('never counts another row of the thread', async () => {
        const c = await claimed();
        await store.writeFinishPass(c.id, c.leaseToken, pass(c));
        await store.complete(c.id, c.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const ref = await store.createFollowUp(c.id, 'and now the next step', null);
        if (typeof ref === 'string') throw new Error(`createFollowUp refused: ${ref}`);
        const follow = await store.claim(WORKER, LEASE_SECONDS);
        expect(follow?.id).toBe(ref.id);
        expect(await roundsOf(follow!)).toBe(0);
    });

    it('answers missing for an unknown job and conflict for a run claim the job never reached', async () => {
        const c = await claimed();
        expect(await store.writeFinishPass(randomUUID(), randomUUID(), pass(c))).toEqual({ result: 'missing' });
        expect(await store.readFinishRounds(randomUUID(), randomUUID())).toEqual({ result: 'missing' });
        for (const runClaimSeq of [c.claimSeq + 1, 0]) {
            expect(await store.writeFinishPass(c.id, c.leaseToken, pass(c, { runClaimSeq }))).toEqual({
                result: 'conflict',
            });
        }
        expect(await rowsOf(c.id)).toBe(0);
    });

    it('is removed with its thread', async () => {
        const c = await claimed();
        await store.writeFinishPass(c.id, c.leaseToken, pass(c));
        await sql`delete from job where root_job_id = ${c.id}`;
        expect(await rowsOf(c.id)).toBe(0);
    });

    it('reads and writes nothing across organizations', async () => {
        const c = await claimed();
        await store.writeFinishPass(c.id, c.leaseToken, pass(c));
        expect(await other.readFinishRounds(c.id, c.leaseToken)).toEqual({ result: 'missing' });
        expect(await other.writeFinishPass(c.id, c.leaseToken, pass(c))).toEqual({ result: 'missing' });
        expect(await rowsOf(c.id)).toBe(1);
    });

    it('binds the request role by the org policy: the org’s store writes and reads, another org’s session sees no row', async () => {
        const c = await claimed();
        const scoped = createJobStore({ sql: orgSql(requestPool, ORG), orgId: ORG });
        expect(await scoped.writeFinishPass(c.id, c.leaseToken, pass(c))).toEqual({ result: 'ok' });
        expect(await roundsOf(c, scoped)).toBe(1);

        const visible = (orgId: string) => orgSql(requestPool, orgId)<{ n: number }[]>`
            select count(*)::int as n from job_finish_pass where job_id = ${c.id}`;
        expect((await visible(ORG))[0]!.n).toBe(1);
        expect((await visible(OTHER_ORG))[0]!.n).toBe(0);
    });
});
