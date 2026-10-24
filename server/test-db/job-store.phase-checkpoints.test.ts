import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { expireLease, testOrg } from './fixtures.js';

/**
 * Issue #829 (G6): the post-run phases of an attempt — gates, post-run helpers, publish — leave a
 * phase checkpoint on the board under the attempt's lease, so the driver that adopts or takes over
 * the run resumes after the last phase that finished instead of re-running every one.
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

const phasesOf = async (id: string): Promise<string[]> =>
    (await sql<{ phase: string }[]>`select phase from job_phase_checkpoint where job_id = ${id} order by phase`).map(
        (r) => r.phase
    );

describe.skipIf(!enabled)('phase checkpoints', () => {
    it('round-trips a checkpoint under the lease', async () => {
        const c = await claimed();
        const result = { verdict: 'passed', output: 'ok' };
        expect(
            await store.writePhaseCheckpoint(c.id, c.leaseToken, {
                runClaimSeq: c.claimSeq,
                phase: 'gates',
                tree: 'h:2',
                result,
            })
        ).toEqual({ result: 'ok' });
        expect(await store.readPhaseCheckpoints(c.id, c.leaseToken, c.claimSeq)).toEqual({
            result: 'ok',
            checkpoints: [{ phase: 'gates', claimSeq: c.claimSeq, tree: 'h:2', result }],
        });
    });

    it('stores a null tree', async () => {
        const c = await claimed();
        await store.writePhaseCheckpoint(c.id, c.leaseToken, {
            runClaimSeq: c.claimSeq,
            phase: 'post',
            tree: null,
            result: null,
        });
        expect(await store.readPhaseCheckpoints(c.id, c.leaseToken, c.claimSeq)).toEqual({
            result: 'ok',
            checkpoints: [{ phase: 'post', claimSeq: c.claimSeq, tree: null, result: null }],
        });
    });

    it('refuses a stale lease token and stores nothing', async () => {
        const c = await claimed();
        expect(
            await store.writePhaseCheckpoint(c.id, randomUUID(), {
                runClaimSeq: c.claimSeq,
                phase: 'gates',
                tree: 'h:2',
                result: {},
            })
        ).toEqual({ result: 'lost' });
        expect(await phasesOf(c.id)).toEqual([]);
    });

    it('answers missing for an unknown job', async () => {
        expect(
            await store.writePhaseCheckpoint(randomUUID(), randomUUID(), {
                runClaimSeq: 1,
                phase: 'gates',
                tree: null,
                result: {},
            })
        ).toEqual({ result: 'missing' });
        expect(await store.readPhaseCheckpoints(randomUUID(), randomUUID(), 1)).toEqual({ result: 'missing' });
    });

    it('rewriting an earlier phase replaces it and drops the later phases of the same run', async () => {
        const c = await claimed();
        const write = (phase: 'gates' | 'post' | 'publish', result: unknown) =>
            store.writePhaseCheckpoint(c.id, c.leaseToken, { runClaimSeq: c.claimSeq, phase, tree: 'h:2', result });
        await write('gates', { n: 1 });
        await write('post', { n: 1 });
        await write('publish', { n: 1 });
        await write('gates', { n: 2 });
        expect(await store.readPhaseCheckpoints(c.id, c.leaseToken, c.claimSeq)).toEqual({
            result: 'ok',
            checkpoints: [{ phase: 'gates', claimSeq: c.claimSeq, tree: 'h:2', result: { n: 2 } }],
        });
    });

    it('keeps the setup checkpoint when a later phase is written, and reads it first (issue #917)', async () => {
        const c = await claimed();
        const write = (phase: 'setup' | 'gates', result: unknown) =>
            store.writePhaseCheckpoint(c.id, c.leaseToken, { runClaimSeq: c.claimSeq, phase, tree: null, result });
        const failure = { exitCode: 7, output: 'npm ERR!' };
        await write('gates', { n: 1 });
        await write('setup', { failure });
        await write('gates', { n: 2 });
        expect(await store.readPhaseCheckpoints(c.id, c.leaseToken, c.claimSeq)).toMatchObject({
            result: 'ok',
            checkpoints: [{ phase: 'setup', result: { failure } }, { phase: 'gates' }],
        });
    });

    it('keeps the checkpoints of another run of the same job', async () => {
        const c = await claimed();
        await sql`update job set claim_seq = claim_seq + 1 where id = ${c.id}`;
        const earlier = c.claimSeq;
        const later = c.claimSeq + 1;
        await store.writePhaseCheckpoint(c.id, c.leaseToken, {
            runClaimSeq: earlier,
            phase: 'publish',
            tree: null,
            result: { ok: true },
        });
        await store.writePhaseCheckpoint(c.id, c.leaseToken, {
            runClaimSeq: later,
            phase: 'gates',
            tree: 'h:3',
            result: {},
        });
        const read = await store.readPhaseCheckpoints(c.id, c.leaseToken, earlier);
        expect(read).toMatchObject({ result: 'ok', checkpoints: [{ phase: 'publish' }] });
    });

    it('refuses to read under a stale token', async () => {
        const c = await claimed();
        expect(await store.readPhaseCheckpoints(c.id, randomUUID(), c.claimSeq)).toEqual({ result: 'lost' });
    });

    it('refuses a run claim sequence above the claim or below one', async () => {
        const c = await claimed();
        for (const runClaimSeq of [c.claimSeq + 1, 0]) {
            expect(
                await store.writePhaseCheckpoint(c.id, c.leaseToken, {
                    runClaimSeq,
                    phase: 'gates',
                    tree: null,
                    result: {},
                })
            ).toEqual({ result: 'conflict' });
        }
        expect(await phasesOf(c.id)).toEqual([]);
    });

    it('refuses a lapsed-and-retaken lease: the old token is lost', async () => {
        const c = await claimed();
        await expireLease(sql, c.id);
        const next = await store.claim(WORKER, LEASE_SECONDS);
        expect(next?.id).toBe(c.id);
        expect(
            await store.writePhaseCheckpoint(c.id, c.leaseToken, {
                runClaimSeq: c.claimSeq,
                phase: 'gates',
                tree: null,
                result: {},
            })
        ).toEqual({ result: 'lost' });
    });

    it('is removed with its job', async () => {
        const c = await claimed();
        await store.writePhaseCheckpoint(c.id, c.leaseToken, {
            runClaimSeq: c.claimSeq,
            phase: 'gates',
            tree: null,
            result: {},
        });
        await sql`delete from job where id = ${c.id}`;
        expect(await phasesOf(c.id)).toEqual([]);
    });

    it('reads nothing across organizations', async () => {
        const c = await claimed();
        await store.writePhaseCheckpoint(c.id, c.leaseToken, {
            runClaimSeq: c.claimSeq,
            phase: 'gates',
            tree: null,
            result: {},
        });
        expect(await other.readPhaseCheckpoints(c.id, c.leaseToken, c.claimSeq)).toEqual({ result: 'missing' });
    });
});
