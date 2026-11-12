import { beforeAll, describe, expect, it } from 'vitest';
import { expireLease, testOrg } from './fixtures.js';
import { type LaneRig, REASONS, interruptionsOf, laneRig } from './lane-rows.js';
import { useTestDb } from './harness.js';

/**
 * The board rows every case of the docker lane's driver-kill phase shares (`dk_settled`): a
 * driver that vanishes at any step costs the task an interruption, never the task. The next claim finishes
 * it once, the killed attempt is refunded, and one interruption records claim 1. The lane keeps what ran
 * from outside: the barriers, the origin's push log, the stub's PR list, the supervisors and containers.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });
let rig: LaneRig;

beforeAll(() => {
    if (enabled) rig = laneRig(db.sql, ORG);
});

// k1 (setup), k2 (agent), k4 (gates) and k5 (publish) lose the driver to a kill: the lease expires.
const KILLED = ['k1', 'k2', 'k4', 'k5'] as const;

describe.skipIf(!enabled)('the driver-kill phase rows — database', () => {
    it.each(KILLED)(
        '%s: a killed driver is one interruption for claim 1; the next claim finishes the task, refunded',
        async () => {
            const id = await rig.lastAttempt();
            await rig.claim();
            await expireLease(rig.sql, id);

            const next = await rig.claim();
            expect(next).toMatchObject({ id, attempts: 1, claimSeq: 2 });
            await rig.store.complete(id, next.leaseToken, {
                status: 'succeeded',
                exitCode: 0,
                output: 'ran in c0ffee',
            });

            const row = (await rig.store.get(id))!;
            expect(row.status).toBe('succeeded');
            expect(row.attempts).toBe(1);
            expect(interruptionsOf(row)).toBe(`1|1|${REASONS.expired}`);
        }
    );

    it('k2 and k4: taking the running agent over records no interruption of its own', async () => {
        const id = await rig.lastAttempt();
        await rig.claim();
        await expireLease(rig.sql, id);
        const next = await rig.claim();
        await rig.store.interrupt(id, next.leaseToken, { reason: REASONS.tookOver, release: false, claimSeq: 1 });
        await rig.store.complete(id, next.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ran in c0ffee' });

        const row = (await rig.store.get(id))!;
        expect(row.attempts).toBe(1);
        expect(interruptionsOf(row)).toBe(`1|1|${REASONS.expired}`);
    });

    it('k2d: a drained driver hands the run back queued with one interruption, and the next claim finishes it, refunded', async () => {
        const id = await rig.lastAttempt();
        const first = await rig.claim();
        await rig.store.interrupt(id, first.leaseToken, { reason: REASONS.drained, release: true });
        const handed = (await rig.store.get(id))!;
        expect(handed.status).toBe('queued');
        expect(interruptionsOf(handed)).toBe(`1|1|${REASONS.drained}`);

        const next = await rig.claim();
        await rig.store.interrupt(id, next.leaseToken, { reason: REASONS.tookOver, release: false, claimSeq: 1 });
        await rig.store.complete(id, next.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ran in c0ffee' });

        const row = (await rig.store.get(id))!;
        expect(row.status).toBe('succeeded');
        expect(row.attempts).toBe(1);
        expect(interruptionsOf(row)).toBe(`1|1|${REASONS.drained}`);
    });
});
