import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { nullAuthorThread, type ThreadJob } from '../../e2e/fixtures/threads.js';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';

/**
 * The thread fixtures the e2e specs and the web DOM tests render through a mocked thread route
 * (`e2e/fixtures/threads.ts`) are held to the board here: seeded for real, the thread read the
 * route serves (`GET /api/jobs/:id/thread` sends `store.thread(id)` as JSON) answers the fixture
 * back, field for field.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const ORG = 'thread-fixture-org';
const db = useTestDb({ orgs: [ORG] });

let sql: Sql;
let store: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

/** Every job column the thread read serves back, except the actor ids: only an actor-free fixture seeds verbatim. */
async function seedThread(jobs: readonly ThreadJob[]): Promise<void> {
    for (const job of jobs) {
        await sql`
            insert into job (org_id, id, root_job_id, parent_job_id, command, status, attempts, max_attempts,
                             claimed_by, session_id, repo, executor, workflow_name, workflow_node, mode, exit_code,
                             output, summary, gates, runtime, wall_clock_ms, agent_turns, done_at,
                             cancel_requested_at, created_at, started_at, finished_at)
            values (${ORG}, ${job.id}, ${job.rootJobId}, ${job.followUpTo}, ${job.command}, ${job.status},
                    ${job.attempts}, ${job.maxAttempts}, ${job.claimedBy}, ${job.sessionId}, ${job.repo},
                    ${job.executor}, ${job.workflowName}, ${job.workflowNode}, ${job.mode}, ${job.exitCode},
                    ${job.output}, ${job.summary}, ${job.gates ? sql.json(job.gates as never) : null},
                    ${job.runtime ? sql.json(job.runtime as never) : null}, ${job.wallClockMs},
                    ${job.agentTurns}, ${job.doneAt}, ${job.cancelRequestedAt}, ${job.createdAt}, ${job.startedAt},
                    ${job.finishedAt})
        `;
    }
}

describe.skipIf(!enabled)('the shared thread fixtures', () => {
    it('are the board’s own thread payload', async () => {
        await seedThread(nullAuthorThread);
        const served = JSON.parse(JSON.stringify(await store.thread(nullAuthorThread[0]!.id)));
        expect(served).toEqual(nullAuthorThread);
    });
});
