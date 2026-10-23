import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { expireLease, mustCreate, testOrg } from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;

const ORG = testOrg();
const SESSION = randomUUID();
/** A lease long enough that nothing in this suite outlives it by accident. */
const LEASE_SECONDS = 300;

const db = useTestDb({ orgs: [ORG] });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

const claimed = async (): Promise<{ id: string; leaseToken: string }> => {
    const { id } = await mustCreate(store.create('echo hi', null, { repo: null, executor: null }));
    const claim = await store.claim('w1', LEASE_SECONDS);
    if (claim?.id !== id) throw new Error('claim refused');
    return { id, leaseToken: claim.leaseToken };
};

/** The row version: any update, even one writing the values already there, moves it. */
const version = async (id: string): Promise<string> => {
    const rows = await sql<{ xmin: string }[]>`select xmin::text as xmin from job where id = ${id}`;
    return rows[0]?.xmin ?? '';
};

// The opencode reporter re-posts its session every sample for the whole run (server/src/routes/ingest.ts):
// the report writes only a session the row does not already carry, and answers for the lease either way.
describe.skipIf(!enabled)('the session report', () => {
    it('answers ok to a repeated identical report and leaves the row untouched', async () => {
        const { id, leaseToken } = await claimed();
        expect(await store.session(id, leaseToken, SESSION)).toBe('ok');
        const before = await version(id);

        expect(await store.session(id, leaseToken, SESSION)).toBe('ok');

        expect(await version(id)).toBe(before);
        expect((await store.get(id))?.sessionId).toBe(SESSION);
    });

    it('still writes a changed session', async () => {
        const { id, leaseToken } = await claimed();
        expect(await store.session(id, leaseToken, SESSION)).toBe('ok');
        const before = await version(id);
        const next = randomUUID();

        expect(await store.session(id, leaseToken, next)).toBe('ok');

        expect(await version(id)).not.toBe(before);
        expect((await store.get(id))?.sessionId).toBe(next);
    });

    it('answers lost to an identical report from a superseded lease, and missing for an absent job', async () => {
        const { id, leaseToken } = await claimed();
        expect(await store.session(id, leaseToken, SESSION)).toBe('ok');
        await expireLease(sql, id);
        // The takeover keeps the lost attempt's session: the stale report now matches the row.
        expect(await store.claim('w2', LEASE_SECONDS)).toMatchObject({ id, resumeSessionId: SESSION });

        expect(await store.session(id, leaseToken, SESSION)).toBe('lost');
        expect(await store.session(randomUUID(), leaseToken, SESSION)).toBe('missing');
    });
});
