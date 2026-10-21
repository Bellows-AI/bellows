import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';

/**
 * Issue #829 (G7): a reclaim group's cleanup intent is the acquisition token on its task_reclaim
 * row (075). The reaper asks which acquisition tokens the board still holds: a row is held from its
 * acquisition until the ack deletes it or a re-acquisition mints a new token.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const WORKER = 'worker-1';
const LEASE_SECONDS = 300;
const db = useTestDb({ max: 4, orgs: [ORG, OTHER_ORG] });

let sql: Sql;
let store: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

const enqueue = async (org: string, root = randomUUID()): Promise<string> => {
    await sql`insert into task_reclaim (org_id, root_job_id) values (${org}, ${root})`;
    return root;
};

describe.skipIf(!enabled)('reclaimHolds — database', () => {
    it('answers the acquisition token of a root whose reclaim was claimed', async () => {
        const root = await enqueue(ORG);
        const acquired = await store.claimReclaim(WORKER, LEASE_SECONDS);
        expect(acquired).toMatchObject({ rootJobId: root });
        expect(await store.reclaimHolds([acquired!.token])).toEqual([acquired!.token]);
    });

    it('answers a follow-up member’s verdict reclaim by its token, never by the member id', async () => {
        const root = await enqueue(ORG);
        const member = randomUUID();
        const acquired = await store.claimReclaim(WORKER, LEASE_SECONDS);
        expect(acquired).toMatchObject({ rootJobId: root });
        expect(await store.reclaimHolds([acquired!.token, member])).toEqual([acquired!.token]);
    });

    it('answers only the new token once an expired row is re-acquired', async () => {
        const root = await enqueue(ORG);
        const first = await store.claimReclaim(WORKER, LEASE_SECONDS);
        await sql`update task_reclaim set lease_expires_at = now() where org_id = ${ORG} and root_job_id = ${root}`;
        const second = await store.claimReclaim(WORKER, LEASE_SECONDS);
        expect(second!.token).not.toBe(first!.token);
        expect(await store.reclaimHolds([first!.token, second!.token])).toEqual([second!.token]);
    });

    it('still holds an expired row nobody has re-acquired', async () => {
        const root = await enqueue(ORG);
        const acquired = await store.claimReclaim(WORKER, LEASE_SECONDS);
        await sql`update task_reclaim set lease_expires_at = now() where org_id = ${ORG} and root_job_id = ${root}`;
        expect(await store.reclaimHolds([acquired!.token])).toEqual([acquired!.token]);
    });

    it('answers nothing for an unacquired row, an acked row, or a root never queued', async () => {
        await enqueue(ORG);
        const acked = await enqueue(ORG);
        await sql`update task_reclaim set created_at = now() - interval '1 hour' where org_id = ${ORG} and root_job_id = ${acked}`;
        const first = await store.claimReclaim(WORKER, LEASE_SECONDS);
        expect(first).toMatchObject({ rootJobId: acked });
        expect(await store.ackReclaim(first!.id, first!.token)).toBe('ok');
        expect(await store.reclaimHolds([first!.token, randomUUID()])).toEqual([]);
    });

    it("answers nothing for another org's row", async () => {
        const root = await enqueue(OTHER_ORG);
        const other = createJobStore({ sql, orgId: OTHER_ORG });
        const acquired = await other.claimReclaim(WORKER, LEASE_SECONDS);
        expect(acquired).toMatchObject({ rootJobId: root });
        expect(await store.reclaimHolds([acquired!.token])).toEqual([]);
    });
});
