import { describe, expect, it } from 'vitest';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/** BEL-174: the thread root's frozen execution user rides on every detail read, so the task page can say who must act. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('exec-alice');
const db = useTestDb({ orgs: [ORG], users: [ALICE] });

describe.skipIf(!enabled)('job view execution user', () => {
    it('get() and thread() name the root execution user on every member', async () => {
        const store = createJobStore({ sql: db.sql, orgId: ORG });
        const created = await store.create('do the work', ALICE.id, { repo: 'acme/app', executor: null });
        if (typeof created === 'string') throw new Error(created);
        const expected = expect.objectContaining({ id: ALICE.id, login: ALICE.login });
        expect((await store.get(created.id))?.executionUser).toEqual(expected);
        const thread = await store.thread(created.id);
        expect(thread?.length).toBeGreaterThan(0);
        for (const member of thread ?? []) expect(member.executionUser).toEqual(expected);
    });

    it('list reads answer null', async () => {
        const store = createJobStore({ sql: db.sql, orgId: ORG });
        await store.create('queued one', ALICE.id, { repo: 'acme/app', executor: null });
        const jobs = await store.list({ status: 'queued', limit: 5 });
        expect(jobs.length).toBeGreaterThan(0);
        for (const job of jobs) expect(job.executionUser).toBeNull();
    });
});
