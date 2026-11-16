import { describe, expect, it } from 'vitest';
import { createJobStore, REPEATED_DAEMON_LOSS_NOTE } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';

/**
 * A docker class's daemon lost under a failed gate is handed back flagged `daemonLoss` beside
 * `nodeLoss`: refunded outside the poison budget — but only twice in a row. From the third
 * consecutive dockerd loss on, the entry is recorded without `nodeLoss` and unrefunded, so it spends
 * an attempt and the ordinary interruption budget, and its reason names the repeated loss. Any other
 * interruption between two dockerd losses breaks the run.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORGS = [testOrg(), testOrg(), testOrg()];
const db = useTestDb({ orgs: ORGS });

/** A store of its own org per case: each claim below can only take the job the case queued. */
async function queued(org: string): Promise<{ store: JobStore; id: string }> {
    const store = createJobStore({ sql: db.sql, orgId: org });
    const job = await store.create('build the image', null, { repo: null, executor: null });
    if (typeof job === 'string') throw new Error(job);
    return { store, id: job.id };
}

async function claimed(store: JobStore): Promise<string> {
    const c = await store.claim('worker-1', 60);
    if (!c) throw new Error('nothing was claimable');
    return c.leaseToken;
}

const daemonLost = {
    reason: 'the docker daemon was lost under the gates',
    release: true,
    nodeLoss: true,
    daemonLoss: true,
};
const drained = { reason: 'the driver was drained', release: true, nodeLoss: true };

describe.skipIf(!enabled)('consecutive dockerd losses are bounded — database', () => {
    it('refunds two in a row, then spends an attempt and the poison budget from the third on', async () => {
        const { store, id } = await queued(ORGS[0]!);
        for (let round = 0; round < 4; round += 1) {
            expect(await store.interrupt(id, await claimed(store), daemonLost)).toEqual({
                result: 'ok',
                status: 'queued',
            });
        }

        const row = (await store.get(id))!;
        // Two refunded, then two that each spent an attempt.
        expect(row.attempts).toBe(2);
        expect(row.interruptions.map((i) => [i.daemonLoss, i.nodeLoss ?? false, i.refunded])).toEqual([
            [true, true, true],
            [true, true, true],
            [true, false, false],
            [true, false, false],
        ]);
        expect(row.interruptions[2]!.reason).toBe(`${daemonLost.reason}${REPEATED_DAEMON_LOSS_NOTE}`);
    });

    it('starts the count again after any other interruption: loss, drain, loss is refunded', async () => {
        const { store, id } = await queued(ORGS[1]!);
        await store.interrupt(id, await claimed(store), daemonLost);
        await store.interrupt(id, await claimed(store), drained);
        await store.interrupt(id, await claimed(store), daemonLost);

        const row = (await store.get(id))!;
        expect(row.attempts).toBe(0);
        expect(row.interruptions.every((i) => i.refunded === true && i.nodeLoss === true)).toBe(true);
        expect(row.interruptions.map((i) => i.reason)).not.toContain(
            `${daemonLost.reason}${REPEATED_DAEMON_LOSS_NOTE}`
        );
    });

    it('refuses the third in a row once the poison budget is spent, as any ordinary interruption', async () => {
        const { store, id } = await queued(ORGS[2]!);
        await store.interrupt(id, await claimed(store), daemonLost);
        await store.interrupt(id, await claimed(store), daemonLost);
        // Spend the poison budget with ordinary entries, then end with two dockerd losses in a row again.
        const at = new Date().toISOString();
        await db.sql`update job set interruptions = (
            select jsonb_agg(jsonb_build_object('reason', 'gone', 'at', ${at}::text, 'refunded', true))
            from generate_series(1, 5)
        ) || interruptions where id = ${id}`;

        expect(await store.interrupt(id, await claimed(store), daemonLost)).toEqual({ result: 'exhausted' });
    });
});
