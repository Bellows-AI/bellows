import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { reviewRefOf } from '../src/db/jobs/job-store-reviews.js';
import type { Claim, JobStore, ReviewerSpec } from '../src/db/jobs/job-store-types.js';
import { createWorkflowStore } from '../src/db/workflows/workflow-store.js';
import type { WorkflowDefinition } from '../src/db/workflows/workflow-schema.js';
import { useTestDb } from './harness.js';
import { expireLease, mustCreate, spendInterruptionBudget, testOrg } from './fixtures.js';

/**
 * Issue #845: every claim leaves a durable `job_execution` row, written in the claim's own
 * transaction, and a session the claim resumes is recorded as the board's inference.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const WORKER = 'worker-1';
const LEASE_SECONDS = 300;
const db = useTestDb({ orgs: [ORG] });

const SECURITY: ReviewerSpec = {
    name: 'security',
    instructions: 'Look for leaks.',
    timeoutMinutes: 7,
    connections: [],
};

let sql: Sql;
let store: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

interface ExecutionRow {
    claim_seq: string;
    root_job_id: string;
    requesting_job_id: string | null;
    requesting_root_job_id: string | null;
    author_id: string | null;
    repo: string | null;
    executor: string | null;
    agent: string | null;
    launch: string;
    resumed: boolean;
    origin: string;
    removed_at: Date | null;
}

const executions = (jobId: string) =>
    sql<ExecutionRow[]>`select * from job_execution where org_id = ${ORG} and job_id = ${jobId} order by claim_seq`;

const sessions = (jobId: string) =>
    sql<{ claim_seq: string; session_id: string; origin: string }[]>`
        select claim_seq, session_id, origin from job_execution_session
        where org_id = ${ORG} and job_id = ${jobId} order by claim_seq, session_id`;

const queue = async (command = 'do the thing', target = { repo: 'acme/web', executor: null as string | null }) =>
    (await mustCreate(store.create(command, null, target))).id;

const claim = async (): Promise<Claim> => {
    const c = await store.claim(WORKER, LEASE_SECONDS);
    if (!c) throw new Error('nothing was claimable');
    return c;
};

describe.skipIf(!enabled)('execution provenance — database', () => {
    it('records one requested execution per claim, with attribution and no session', async () => {
        const id = await queue();
        const first = await claim();

        const rows = await executions(id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            claim_seq: String(first.claimSeq),
            root_job_id: id,
            requesting_job_id: null,
            repo: 'acme/web',
            agent: null,
            launch: 'requested',
            resumed: false,
            origin: 'claim',
            removed_at: null,
        });
        expect(await sessions(id)).toEqual([]);
    });

    it('records an infrastructure-recovered claim on its own row, resuming the retained session as inferred', async () => {
        const id = await queue();
        const first = await claim();
        const session = randomUUID();
        await store.session(id, first.leaseToken, session);
        await expireLease(sql, id);

        const second = await claim();

        expect(second.claimSeq).toBe(first.claimSeq + 1);
        const rows = await executions(id);
        expect(rows.map((r) => [Number(r.claim_seq), r.resumed])).toEqual([
            [first.claimSeq, false],
            [second.claimSeq, true],
        ]);
        expect(await sessions(id)).toEqual([
            { claim_seq: String(second.claimSeq), session_id: session, origin: 'inferred_at_claim' },
        ]);
    });

    it('records an explicit retry fresh: no inherited session', async () => {
        const id = await queue();
        const first = await claim();
        await store.session(id, first.leaseToken, randomUUID());
        // The interruption budget spent, the lost attempt is a failed attempt: the reclaim starts fresh.
        await spendInterruptionBudget(sql, id);
        await expireLease(sql, id);

        const second = await claim();

        expect(second.resumeSessionId ?? null).toBeNull();
        const rows = await executions(id);
        expect(rows[1]).toMatchObject({ claim_seq: String(second.claimSeq), resumed: false });
        expect(await sessions(id)).toEqual([]);

        // A retry row is a new job: its own execution, no session.
        await store.complete(id, second.leaseToken, { status: 'failed', exitCode: 1, output: 'x' });
        const retry = await store.createRetry(id, null);
        if (typeof retry === 'string') throw new Error(retry);
        await claim();
        expect(await executions(retry.id)).toMatchObject([{ resumed: false }]);
        expect(await sessions(retry.id)).toEqual([]);
    });

    it('records a follow-up as resuming the parent session', async () => {
        const id = await queue();
        const first = await claim();
        const session = randomUUID();
        await store.session(id, first.leaseToken, session);
        await store.complete(id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const followUp = await store.createFollowUp(id, 'and one more', null);
        if (typeof followUp === 'string') throw new Error(followUp);

        await claim();

        expect(await executions(followUp.id)).toMatchObject([{ root_job_id: id, resumed: true }]);
        expect(await sessions(followUp.id)).toMatchObject([{ session_id: session, origin: 'inferred_at_claim' }]);
    });

    it('records a workflow resume node with the primary session and a fresh node with none', async () => {
        const definition: WorkflowDefinition = {
            entry: 'implement',
            params: [],
            nodes: [
                { name: 'implement', kind: 'agent', session: 'resume', prompt: 'implement' },
                { name: 'review', kind: 'agent', session: 'fresh', prompt: 'review' },
                { name: 'fix', kind: 'agent', session: 'resume', prompt: 'fix: {{review.output}}' },
            ],
            edges: [
                { from: 'implement', to: 'review', when: 'succeeded' },
                { from: 'review', to: 'fix', when: { marker: 'VERDICT: BLOCKERS' } },
            ],
        } as WorkflowDefinition;
        const workflows = createWorkflowStore({ sql, orgId: ORG });
        const created = await workflows.create({ name: 'walk', scope: { kind: 'org' }, definition, createdBy: null });
        const root = await mustCreate(
            store.create('fix it', null, {
                repo: null,
                executor: null,
                workflow: {
                    id: (created as { id: string }).id,
                    name: 'walk',
                    node: 'implement',
                    snapshot: definition,
                    params: {},
                },
            })
        );
        const session = randomUUID();
        const implement = await claim();
        await store.session(implement.id, implement.leaseToken, session);
        await store.complete(implement.id, implement.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });
        const review = await claim();
        await store.complete(review.id, review.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'VERDICT: BLOCKERS',
        });
        const fix = await claim();

        expect(await sessions(review.id)).toEqual([]);
        expect(await sessions(fix.id)).toMatchObject([{ session_id: session, origin: 'inferred_at_claim' }]);
        expect((await executions(fix.id))[0]).toMatchObject({ root_job_id: root.id, resumed: true });
    });

    it('resolves a named review to its requesting job and root, and a lost reviewer resumes its session', async () => {
        const reviewStore = createJobStore({
            sql,
            orgId: ORG,
            plan: {
                readFor: async () => ({
                    config: null,
                    error: null,
                    services: [],
                    revision: null,
                    reviewers: [SECURITY],
                }),
            },
        });
        const callerId = (await mustCreate(reviewStore.create('ship it', null, { repo: 'acme/web', executor: null })))
            .id;
        const caller = (await reviewStore.claim(WORKER, LEASE_SECONDS))!;
        const request = { key: 'sec-1', profile: 'security', revision: 'abc', ref: reviewRefOf(callerId, 'sec-1') };

        const asked = await reviewStore.requestReview(callerId, caller.leaseToken, request);
        if (!('claim' in asked) || !asked.claim) throw new Error(`no review claim: ${asked.result}`);
        const review = asked.claim;
        expect(await executions(review.id)).toMatchObject([
            {
                requesting_job_id: callerId,
                requesting_root_job_id: callerId,
                root_job_id: review.id,
                launch: 'requested',
            },
        ]);

        // The same caller claim asking again is handed the same claim: nothing is recorded twice.
        await reviewStore.requestReview(callerId, caller.leaseToken, request);
        expect(await executions(review.id)).toHaveLength(1);

        // The reviewer reports a session; the caller is claimed again and asks the same key: the
        // re-leased review resumes that session.
        const session = randomUUID();
        await reviewStore.session(review.id, review.leaseToken, session);
        await expireLease(sql, callerId);
        const again = (await reviewStore.claim(WORKER, LEASE_SECONDS))!;
        await reviewStore.requestReview(callerId, again.leaseToken, request);
        const rows = await executions(review.id);
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({ resumed: true, requesting_job_id: callerId });
        expect(await sessions(review.id)).toMatchObject([{ session_id: session, origin: 'inferred_at_claim' }]);
    });

    it('survives removal of the job: no foreign key cascades into provenance', async () => {
        const id = await queue();
        await claim();
        await sql`delete from job where org_id = ${ORG} and root_job_id = ${id}`;

        expect(await executions(id)).toHaveLength(1);
    });
});
