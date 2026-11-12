import { beforeAll, describe, expect, it } from 'vitest';
import { testOrg } from './fixtures.js';
import { type LaneRig, laneRig } from './lane-rows.js';
import { useTestDb } from './harness.js';

/**
 * The board row of the docker lane's run-deadline phase: a run past its budget is failed with
 * the driver's timeout note and publishes nothing. The lane keeps the supervisor, its report and the proof
 * that the supervisor, not the docker backstop, ended the run.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });
let rig: LaneRig;

beforeAll(() => {
    if (enabled) rig = laneRig(db.sql, ORG);
});

describe.skipIf(!enabled)('the run-deadline phase rows — database', () => {
    it('settles a run past its budget failed, its output carrying the timeout note and no publish line', async () => {
        const id = await rig.lastAttempt();
        const claim = await rig.claim();
        await rig.store.complete(id, claim.leaseToken, {
            status: 'failed',
            exitCode: 1,
            output: '[driver] killed after 20000ms',
        });

        const row = (await rig.store.get(id))!;
        expect(row.status).toBe('failed');
        expect(row.output).toContain('[driver] killed after 20000ms');
        expect(row.output).not.toContain('[driver] published');
    });
});
