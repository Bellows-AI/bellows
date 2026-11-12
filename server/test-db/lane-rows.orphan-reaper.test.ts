import { beforeAll, describe, expect, it } from 'vitest';
import { expireLease, testOrg } from './fixtures.js';
import { type LaneRig, laneRig } from './lane-rows.js';
import { useTestDb } from './harness.js';

/**
 * The board row of the docker lane's orphan-reaper phase: a job whose driver was killed and whose lease has
 * expired settles `stopped` in place when the stop arrives, with no driver alive to honour it.
 * The lane keeps the fleet, the reaper and the network, which only a daemon shows.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });
let rig: LaneRig;

beforeAll(() => {
    if (enabled) rig = laneRig(db.sql, ORG);
});

describe.skipIf(!enabled)('the orphan-reaper phase rows — database', () => {
    it('settles a crashed job stopped once its lease has expired, with no driver alive', async () => {
        const id = await rig.lastAttempt();
        await rig.claim();

        // Still leased: the stop is only requested, the driver being alive to honour it.
        expect(await rig.store.stop(id, null)).toMatchObject({ result: 'requested' });
        expect(await rig.store.get(id)).toMatchObject({ status: 'running' });

        await expireLease(rig.sql, id);
        expect(await rig.store.stop(id, null)).toEqual({ result: 'stopped' });
        const row = await rig.store.get(id);
        expect(row).toMatchObject({ status: 'stopped' });
        expect(row?.finishedAt).toBeTruthy();
    });
});
