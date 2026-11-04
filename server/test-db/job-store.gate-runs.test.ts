import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { GateRunWrite } from '../src/db/jobs/job-store-gate-runs.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { expireLease, testOrg } from './fixtures.js';

/**
 * Issue #983: every gate execution leaves a row on the board under the attempt's lease — a `running`
 * row before it starts, the terminal one after — so a completion pass, possibly another driver's after
 * a takeover, can tell a verified pass from a stale one. The lease fences both the write and the read;
 * the row is only ever replaced `running` -> terminal, so a replayed write is a no-op.
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

const row = (c: Claim, over: Partial<GateRunWrite> = {}): GateRunWrite => ({
    runClaimSeq: c.claimSeq,
    executionId: randomUUID(),
    gate: 'test',
    identity: 'a'.repeat(64),
    filtered: false,
    source: 'adhoc',
    outcome: 'running',
    exitCode: null,
    treeBefore: 'h:1',
    treeAfter: null,
    mutatedSince: null,
    startedAt: '2026-10-26T10:00:00.000Z',
    finishedAt: null,
    ...over,
});
const passed = (c: Claim, running: GateRunWrite, over: Partial<GateRunWrite> = {}): GateRunWrite => ({
    ...running,
    runClaimSeq: c.claimSeq,
    outcome: 'passed',
    exitCode: 0,
    treeAfter: 'h:1',
    mutatedSince: false,
    finishedAt: '2026-10-26T10:01:00.000Z',
    ...over,
});

const read = async (c: Claim, on: JobStore = store) => {
    const answer = await on.readGateRuns(c.id, c.leaseToken);
    if (answer.result !== 'ok') throw new Error(`read answered ${answer.result}`);
    return answer.runs;
};
const countOf = async (id: string): Promise<number> =>
    Number((await sql<{ n: string }[]>`select count(*) as n from job_gate_run where job_id = ${id}`)[0]!.n);

describe.skipIf(!enabled)('gate runs', () => {
    it('stores a running row and replaces it with its terminal row: one row per execution', async () => {
        const c = await claimed();
        const running = row(c);
        expect(await store.writeGateRun(c.id, c.leaseToken, running)).toEqual({ result: 'ok' });
        expect(await read(c)).toEqual([{ ...running, claimSeq: c.claimSeq }]);

        const done = passed(c, running);
        expect(await store.writeGateRun(c.id, c.leaseToken, done)).toEqual({ result: 'ok' });
        expect(await countOf(c.id)).toBe(1);
        expect(await read(c)).toEqual([{ ...done, claimSeq: c.claimSeq }]);
    });

    it('is idempotent on a duplicate execution id: a replay changes nothing', async () => {
        const c = await claimed();
        const running = row(c);
        const done = passed(c, running);
        await store.writeGateRun(c.id, c.leaseToken, running);
        await store.writeGateRun(c.id, c.leaseToken, running);
        await store.writeGateRun(c.id, c.leaseToken, done);
        // A late running replay never reverts a terminal row, and a second terminal row never overwrites the first.
        await store.writeGateRun(c.id, c.leaseToken, running);
        await store.writeGateRun(c.id, c.leaseToken, { ...done, outcome: 'failed', exitCode: 1 });
        expect(await countOf(c.id)).toBe(1);
        expect(await read(c)).toEqual([{ ...done, claimSeq: c.claimSeq }]);
    });

    it('stores a terminal row that had no running row, and every outcome', async () => {
        const c = await claimed();
        for (const outcome of ['not_started', 'setup_failed', 'incomplete', 'failed'] as const) {
            const written = row(c, { gate: outcome, outcome, finishedAt: '2026-10-26T10:01:00.000Z' });
            expect(await store.writeGateRun(c.id, c.leaseToken, written)).toEqual({ result: 'ok' });
        }
        expect((await read(c)).map((r) => [r.gate, r.outcome])).toEqual([
            ['not_started', 'not_started'],
            ['setup_failed', 'setup_failed'],
            ['incomplete', 'incomplete'],
            ['failed', 'failed'],
        ]);
    });

    it('answers the latest row per gate, oldest gate first, whatever the scope of the row', async () => {
        const c = await claimed();
        const first = row(c);
        const lint = row(c, { gate: 'lint' });
        const second = row(c, { filtered: true });
        for (const r of [first, lint, second]) await store.writeGateRun(c.id, c.leaseToken, r);
        await store.writeGateRun(c.id, c.leaseToken, passed(c, first));

        const runs = await read(c);
        // `test`'s latest row is the later execution (a filtered one), not the earlier one that finished last.
        expect(runs.map((r) => [r.gate, r.executionId, r.filtered])).toEqual([
            ['lint', lint.executionId, false],
            ['test', second.executionId, true],
        ]);
    });

    it('rows of an earlier claim of the same job are part of the thread', async () => {
        const c = await claimed();
        const mine = row(c);
        await store.writeGateRun(c.id, c.leaseToken, mine);
        await expireLease(sql, c.id);
        const next = await store.claim(WORKER, LEASE_SECONDS);
        expect(next?.id).toBe(c.id);
        expect(next!.claimSeq).toBeGreaterThan(c.claimSeq);
        expect(await read(next!)).toEqual([{ ...mine, claimSeq: c.claimSeq }]);
    });

    /** Finishes `c` and chains a follow-up on its thread, claimed. */
    const followUpOf = async (c: Claim, on: JobStore = store): Promise<Claim> => {
        await on.complete(c.id, c.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const ref = await on.createFollowUp(c.id, 'and now the next step', null);
        if (typeof ref === 'string') throw new Error(`createFollowUp refused: ${ref}`);
        const next = await on.claim(WORKER, LEASE_SECONDS);
        if (next?.id !== ref.id) throw new Error('the follow-up was not the claim');
        return next;
    };

    it('a follow-up reads its parent’s latest pass of each gate', async () => {
        const c = await claimed();
        const done = passed(c, row(c), { source: 'completion' });
        await store.writeGateRun(c.id, c.leaseToken, done);
        const follow = await followUpOf(c);

        expect(await read(follow)).toEqual([{ ...done, claimSeq: c.claimSeq }]);
    });

    it('the follow-up’s own later row of a gate beats its parent’s, and the read is oldest first', async () => {
        const c = await claimed();
        const parentTest = passed(c, row(c, { gate: 'test' }));
        const parentLint = passed(c, row(c, { gate: 'lint' }));
        await store.writeGateRun(c.id, c.leaseToken, parentTest);
        await store.writeGateRun(c.id, c.leaseToken, parentLint);
        const follow = await followUpOf(c);
        const ownTest = row(follow, { gate: 'test', outcome: 'failed', exitCode: 1 });
        await store.writeGateRun(follow.id, follow.leaseToken, ownTest);

        expect((await read(follow)).map((r) => [r.gate, r.executionId])).toEqual([
            ['lint', parentLint.executionId],
            ['test', ownTest.executionId],
        ]);
    });

    it('never reads another thread’s rows', async () => {
        const first = await claimed();
        await store.writeGateRun(first.id, first.leaseToken, passed(first, row(first)));
        const second = await claimed();

        expect(await store.readGateRuns(second.id, second.leaseToken)).toEqual({ result: 'ok', runs: [] });
    });

    it('refuses a write under a lease that was lost, and stores nothing', async () => {
        const c = await claimed();
        expect(await store.writeGateRun(c.id, randomUUID(), row(c))).toEqual({ result: 'lost' });
        await expireLease(sql, c.id);
        const next = await store.claim(WORKER, LEASE_SECONDS);
        expect(next?.id).toBe(c.id);
        expect(await store.writeGateRun(c.id, c.leaseToken, row(c))).toEqual({ result: 'lost' });
        expect(await countOf(c.id)).toBe(0);
    });

    it('fences the read by the lease too', async () => {
        const c = await claimed();
        await store.writeGateRun(c.id, c.leaseToken, row(c));
        expect(await store.readGateRuns(c.id, randomUUID())).toEqual({ result: 'lost' });
        // The next holder reads the former holder's rows under its own lease, for the run they belong to.
        await expireLease(sql, c.id);
        const next = await store.claim(WORKER, LEASE_SECONDS);
        expect(next?.id).toBe(c.id);
        const seen = await store.readGateRuns(c.id, next!.leaseToken);
        expect(seen.result === 'ok' && seen.runs).toHaveLength(1);
    });

    it('answers missing for an unknown job and conflict for a run claim the job never reached', async () => {
        const c = await claimed();
        expect(await store.writeGateRun(randomUUID(), randomUUID(), row(c))).toEqual({ result: 'missing' });
        expect(await store.readGateRuns(randomUUID(), randomUUID())).toEqual({ result: 'missing' });
        for (const runClaimSeq of [c.claimSeq + 1, 0]) {
            expect(await store.writeGateRun(c.id, c.leaseToken, row(c, { runClaimSeq }))).toEqual({
                result: 'conflict',
            });
        }
        expect(await countOf(c.id)).toBe(0);
    });

    it('reads and writes nothing across organizations', async () => {
        const c = await claimed();
        await store.writeGateRun(c.id, c.leaseToken, row(c));
        expect(await other.readGateRuns(c.id, c.leaseToken)).toEqual({ result: 'missing' });
        expect(await other.writeGateRun(c.id, c.leaseToken, row(c))).toEqual({ result: 'missing' });
        expect(await countOf(c.id)).toBe(1);
    });

    it('is removed with its job', async () => {
        const c = await claimed();
        await store.writeGateRun(c.id, c.leaseToken, row(c));
        await sql`delete from job where id = ${c.id}`;
        expect(await countOf(c.id)).toBe(0);
    });
});
