import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { expireLease, testOrg } from './fixtures.js';
import { type LaneRig, REASONS, interruptionsOf, laneRig } from './lane-rows.js';
import { useTestDb } from './harness.js';

/**
 * The board rows of the docker lane's node-disruption phase, cases a, b and d: a driver lost
 * mid-run costs the task an interruption, never an attempt, and the job still succeeds with the first
 * runner's output. The lane keeps the runners, the supervisors, the output naming the container and the
 * driver's log.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });
let rig: LaneRig;

beforeAll(() => {
    if (enabled) rig = laneRig(db.sql, ORG);
});

describe.skipIf(!enabled)('the node-disruption phase rows — database', () => {
    it('a. a hard kill: the next claim adopts the run; the attempt is refunded, one interruption records the expiry', async () => {
        const id = await rig.lastAttempt();
        await rig.claim();
        await expireLease(rig.sql, id);

        const adopter = await rig.claim();
        expect(adopter).toMatchObject({ id, attempts: 1, maxAttempts: 1, claimSeq: 2 });
        expect(
            await rig.store.interrupt(id, adopter.leaseToken, { reason: REASONS.adopted, release: false, claimSeq: 1 })
        ).toEqual({ result: 'ok', status: 'running' });
        await rig.store.complete(id, adopter.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ran in c0ffee' });

        const row = (await rig.store.get(id))!;
        expect(row.status).toBe('succeeded');
        expect(row.output).toContain('ran in c0ffee');
        expect(row.attempts).toBe(1);
        expect(interruptionsOf(row)).toBe(`1|1|${REASONS.expired}`);
    });

    it('b. a handover: the drained run is queued at once with one interruption; its adoption is the same one, attempt refunded', async () => {
        const id = await rig.lastAttempt();
        const first = await rig.claim();
        expect(await rig.store.interrupt(id, first.leaseToken, { reason: REASONS.drained, release: true })).toEqual({
            result: 'ok',
            status: 'queued',
        });
        const handed = (await rig.store.get(id))!;
        expect(handed.status).toBe('queued');
        expect(interruptionsOf(handed)).toBe(`1|1|${REASONS.drained}`);

        const adopter = await rig.claim();
        await rig.store.interrupt(id, adopter.leaseToken, { reason: REASONS.adopted, release: false, claimSeq: 1 });
        await rig.store.complete(id, adopter.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ran in c0ffee' });

        const row = (await rig.store.get(id))!;
        expect(row.status).toBe('succeeded');
        expect(row.attempts).toBe(1);
        expect(interruptionsOf(row)).toBe(`1|1|${REASONS.drained}`);
    });

    it('d. lost together: the replacement resumes the lost session, spends no attempt, and adopts nothing', async () => {
        const id = await rig.lastAttempt();
        const first = await rig.claim();
        const session = randomUUID();
        await rig.store.session(id, first.leaseToken, session);
        await expireLease(rig.sql, id);

        const replacement = await rig.claim();
        expect(replacement).toMatchObject({ id, attempts: 1, claimSeq: 2, resumeSessionId: session });
        await rig.store.complete(id, replacement.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: `resumed ${session} from ${session}`,
        });

        const row = (await rig.store.get(id))!;
        expect(row.status).toBe('succeeded');
        expect(row.attempts).toBe(1);
        expect(interruptionsOf(row)).toBe(`1|1|${REASONS.expired}`);
        expect(row.sessionId).toBe(session);
        expect(row.output).toContain(`resumed ${session} from ${session}`);
    });
});
