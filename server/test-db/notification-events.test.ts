import { randomUUID } from 'node:crypto';
import { notificationEventOf } from '@factory-ai/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { sweepRuntimeWakes } from '../src/db/workflows/workflow-blocks/runtime.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import type { WorkflowDefinition } from '../src/db/workflows/workflow-schema.js';
import { craftJob, mustCreate, testOrg } from './fixtures.js';

/**
 * BEL-128: every committed job.status change to a settled verdict records one durable
 * notification_event in the same transaction (succeeded → task.ready, failed/dead → task.blocked),
 * judged on the status the transaction commits, never on the statement's NEW row.
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

async function queue(command = 'do the thing', repo: string | null = null): Promise<string> {
    const job = await store.create(command, null, { repo, executor: null });
    if (typeof job === 'string') throw new Error(job);
    return job.id;
}

const claim = async (): Promise<Claim> => {
    const c = await store.claim(WORKER, LEASE_SECONDS);
    if (!c) throw new Error('nothing was claimable');
    return c;
};

const age = (id: string) => sql`update job set lease_expires_at = now() where org_id = ${ORG} and id = ${id}`;

const succeeded = { status: 'succeeded', exitCode: 0, output: 'done' } as const;

interface EventRow {
    id: string;
    kind: string;
    org_id: string;
    job_id: string;
    root_job_id: string;
    repo: string | null;
    workflow: string | null;
    command: string;
    reason: string | null;
    pr_url: string | null;
    occurred_at: Date;
}

const events = (id: string, org = ORG) =>
    sql<EventRow[]>`
        select id, kind, org_id, job_id, root_job_id, repo, workflow, command, reason, pr_url, occurred_at
        from notification_event where org_id = ${org} and job_id = ${id} order by kind
    `;

const expectedId = async (id: string, kind: string): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`select md5(${id}::text || '/' || ${kind})::uuid as id`;
    return row!.id;
};

/** Every column job_review_ck requires, so the row is a named-profile review of a caller. */
const asReview = (id: string) => sql`
    update job set review_of = ${randomUUID()}, review_key = 'k', review_profile = 'security',
        review_spec = '{}'::jsonb, review_revision = 'rev', review_ref = 'ref'
    where org_id = ${ORG} and id = ${id}
`;

describe.skipIf(!enabled)('notification events — database', () => {
    it('a succeeded verdict emits one task.ready', async () => {
        const id = await queue('ship the thing');
        const c = await claim();
        await store.complete(id, c.leaseToken, succeeded);

        const rows = await events(id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            id: await expectedId(id, 'task.ready'),
            kind: 'task.ready',
            org_id: ORG,
            job_id: id,
            root_job_id: id,
            reason: null,
            pr_url: null,
            command: 'ship the thing',
        });
    });

    it('a failed verdict emits one task.blocked carrying the failure kind', async () => {
        const id = await queue();
        const c = await claim();
        await store.complete(id, c.leaseToken, { status: 'failed', exitCode: 1, output: 'no', failureKind: 'timeout' });

        const rows = await events(id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'task.blocked', reason: 'timeout' });
    });

    it('a replayed identical complete emits nothing more (no-op settle)', async () => {
        const id = await queue();
        const c = await claim();
        await store.complete(id, c.leaseToken, succeeded);
        await store.complete(id, c.leaseToken, succeeded);
        expect(await events(id)).toHaveLength(1);
    });

    it('a complete under a stale token emits nothing', async () => {
        const id = await queue();
        await claim();
        expect(await store.complete(id, randomUUID(), succeeded)).toEqual({ result: 'lost' });
        expect(await events(id)).toHaveLength(0);
    });

    it('two concurrent identical completes emit once', async () => {
        const id = await queue();
        const c = await claim();
        await Promise.all([store.complete(id, c.leaseToken, succeeded), store.complete(id, c.leaseToken, succeeded)]);
        expect(await events(id)).toHaveLength(1);
    });

    it('a policy refusal emits one task.blocked and no task.ready', async () => {
        const gated = createJobStore({
            sql,
            orgId: ORG,
            plan: {
                readFor: async () => ({
                    config: null,
                    services: [],
                    revision: null,
                    error: null,
                    policy: { gates: true },
                }),
            },
        });
        const created = await gated.create('ship it', null, { repo: 'acme/web', executor: null });
        if (typeof created === 'string') throw new Error(created);
        const c = await gated.claim(WORKER, LEASE_SECONDS);
        expect(c?.id).toBe(created.id);
        await gated.complete(created.id, c!.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'ok',
            evidence: null,
        });

        const rows = await events(created.id);
        expect(rows.map((r) => r.kind)).toEqual(['task.blocked']);
        expect(rows[0]!.reason).toBe('policy');
    });

    it('a job retired dead emits one task.blocked', async () => {
        const id = await queue();
        await claim();
        await sql`update job set attempts = max_attempts where org_id = ${ORG} and id = ${id}`;
        await sql`update job set interruptions = (
            select coalesce(jsonb_agg(jsonb_build_object('at', now(), 'reason', 'lost', 'claimSeq', n)), '[]'::jsonb)
            from generate_series(1, 10) n) where org_id = ${ORG} and id = ${id}`;
        await age(id);
        expect(await store.claim(WORKER, 60)).toBeNull();
        expect(await store.get(id)).toMatchObject({ status: 'dead' });

        const rows = await events(id);
        expect(rows.map((r) => r.kind)).toEqual(['task.blocked']);
        expect(rows[0]!.reason).toBe('dead');
    });

    it('an interruption hand-back (running→queued) and the re-claim emit nothing', async () => {
        const id = await queue();
        const c = await claim();
        expect(await store.interrupt(id, c.leaseToken, { reason: 'node drained', release: true })).toMatchObject({
            result: 'ok',
        });
        expect(await store.get(id)).toMatchObject({ status: 'queued' });
        await claim();
        expect(await events(id)).toHaveLength(0);
    });

    it('a takeover of a running row (status stays running) emits nothing', async () => {
        const id = await queue();
        await claim();
        await age(id);
        const second = await claim();
        expect(second.id).toBe(id);
        expect(await store.get(id)).toMatchObject({ status: 'running' });
        expect(await events(id)).toHaveLength(0);
    });

    it('stop emits nothing: queued→stopped and running→stopped', async () => {
        const queued = await queue();
        expect(await store.stop(queued, null)).toBeDefined();
        expect(await store.get(queued)).toMatchObject({ status: 'stopped' });

        const running = await queue();
        const c = await claim();
        expect(c.id).toBe(running);
        await store.stop(running, null);
        await store.interrupt(running, c.leaseToken, { reason: 'stop', release: true });
        expect(await store.get(running)).toMatchObject({ status: 'stopped' });

        expect(await events(queued)).toHaveLength(0);
        expect(await events(running)).toHaveLength(0);
    });

    it('a write that keeps the status emits nothing', async () => {
        const id = await craftJob({ sql, org: ORG, author: '' }, { author: null, status: 'succeeded' });
        await sql`update job set status = status, output = 'x' where org_id = ${ORG} and id = ${id}`;
        expect(await events(id)).toHaveLength(0);
    });

    it('snapshots the raw command, repo and workflow name', async () => {
        const command = '  first line  \nsecond';
        const id = await queue(command, 'acme/widgets');
        await sql`update job set workflow_name = 'my-flow' where org_id = ${ORG} and id = ${id}`;
        const c = await claim();
        await store.session(id, c.leaseToken, randomUUID());
        await store.complete(id, c.leaseToken, succeeded);

        const [row] = await events(id);
        expect(row).toMatchObject({ command, repo: 'acme/widgets', workflow: 'my-flow' });
        expect(
            notificationEventOf(
                {
                    id: row!.id,
                    kind: 'task.ready',
                    orgId: row!.org_id,
                    jobId: row!.job_id,
                    rootJobId: row!.root_job_id,
                    repo: row!.repo,
                    workflow: row!.workflow,
                    command: row!.command,
                    reason: row!.reason,
                    prUrl: row!.pr_url,
                    occurredAt: row!.occurred_at.toISOString(),
                },
                'https://factory.example.com'
            )
        ).toMatchObject({ title: 'first line', link: `https://factory.example.com/tasks/${id}` });

        // A follow-up copies the name without a workflow definition; the snapshot stays the name.
        const followUp = await store.createFollowUp(id, 'adjust it', null);
        if (typeof followUp === 'string') throw new Error(followUp);
        await store.markDone(id, null);
        const f = await claim();
        expect(f.id).toBe(followUp.id);
        await store.complete(f.id, f.leaseToken, succeeded);
        const [followRow] = await events(followUp.id);
        expect(followRow).toMatchObject({ workflow: 'my-flow', root_job_id: id, repo: 'acme/widgets' });
    });

    it('a task with no workflow name and no repo carries nulls', async () => {
        const id = await queue();
        const c = await claim();
        await store.complete(id, c.leaseToken, succeeded);
        expect((await events(id))[0]).toMatchObject({ repo: null, workflow: null });
    });

    it('an event survives the task’s removal', async () => {
        const id = await queue('remove me');
        const c = await claim();
        await store.complete(id, c.leaseToken, succeeded);
        expect(await store.removeThread(id, null)).toMatchObject({ result: 'ok' });
        expect(await store.get(id)).toBeNull();

        const rows = await events(id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ command: 'remove me' });
    });

    it('a succeeded verdict carries the thread’s PR link', async () => {
        const REPO = 'acme/web';
        const prs = createPrLifecycleStore({ sql, orgId: ORG });
        const publishing = createJobStore({ sql, orgId: ORG, prs });
        const created = await publishing.create('ship it', null, { repo: REPO, executor: null });
        if (typeof created === 'string') throw new Error(created);
        const c = await publishing.claim(WORKER, LEASE_SECONDS);
        expect(c?.id).toBe(created.id);
        const prUrl = `https://github.com/${REPO}/pull/7`;
        await publishing.complete(created.id, c!.leaseToken, {
            ...succeeded,
            publication: { repo: REPO, prNumber: 7, prUrl, headBranch: `factory/${created.id}`, baseBranch: 'main' },
        });

        const rows = await events(created.id);
        expect(rows.map((r) => r.kind)).toEqual(['task.ready']);
        expect(rows[0]!.pr_url).toBe(prUrl);
    });

    it('a succeeded review job emits nothing', async () => {
        const id = await craftJob({ sql, org: ORG, author: '' }, { author: null, status: 'running' });
        await asReview(id);
        await sql`update job set status = 'succeeded', finished_at = now() where org_id = ${ORG} and id = ${id}`;
        expect(await events(id)).toHaveLength(0);
    });

    it('a node whose verdict queued its successor in the same transaction emits nothing', async () => {
        const root = await craftJob(
            { sql, org: ORG, author: '' },
            { author: null, status: 'running', createdMinutesAgo: 1 }
        );
        const successor = randomUUID();
        await sql.begin(async (tx) => {
            await tx`insert into job (org_id, id, command, status, parent_job_id, root_job_id)
                values (${ORG}, ${successor}, 'next node', 'queued', ${root}, ${root})`;
            await tx`update job set status = 'succeeded', finished_at = now() where org_id = ${ORG} and id = ${root}`;
        });
        expect(await events(root)).toHaveLength(0);
        expect(await events(successor)).toHaveLength(0);
    });

    it('a head closed done in the settle’s transaction emits nothing', async () => {
        const id = await craftJob({ sql, org: ORG, author: '' }, { author: null, status: 'running' });
        await sql`update job set status = 'succeeded', finished_at = now(), done_at = now()
            where org_id = ${ORG} and id = ${id}`;
        expect(await events(id)).toHaveLength(0);
    });

    it('a succeeded head parked on an open PR wait still emits task.ready', async () => {
        const root = await craftJob({ sql, org: ORG, author: '' }, { author: null, status: 'running' });
        await sql.begin(async (tx) => {
            await tx`insert into workflow_wait (org_id, root_job_id, reason, repo, pr_number)
                values (${ORG}, ${root}, 'review', 'acme/widgets', 1)`;
            await tx`update job set status = 'succeeded', finished_at = now() where org_id = ${ORG} and id = ${root}`;
        });
        expect((await events(root)).map((r) => r.kind)).toEqual(['task.ready']);
    });

    it('a follow-up’s success is its own task.ready and the root’s stays one', async () => {
        const root = await queue();
        await store.complete(root, (await claim()).leaseToken, succeeded);
        const followUp = await store.createFollowUp(root, 'again', null);
        if (typeof followUp === 'string' || !('id' in followUp)) throw new Error('no follow-up');
        await store.complete(followUp.id, (await claim()).leaseToken, succeeded);

        const rootRows = await events(root);
        expect(rootRows.map((r) => r.kind)).toEqual(['task.ready']);
        const followRows = await events(followUp.id);
        expect(followRows.map((r) => r.kind)).toEqual(['task.ready']);
        expect(followRows[0]!.id).toBe(await expectedId(followUp.id, 'task.ready'));
        expect(followRows[0]!.id).not.toBe(rootRows[0]!.id);
    });

    it('a re-settle after a takeover emits one task.ready', async () => {
        const id = await queue();
        const first = await claim();
        await age(id);
        const second = await claim();
        expect(second.id).toBe(id);
        expect(await store.complete(id, second.leaseToken, succeeded)).toMatchObject({ result: 'ok' });
        expect(await store.complete(id, first.leaseToken, succeeded)).toEqual({ result: 'lost' });
        await store.complete(id, second.leaseToken, succeeded);
        expect((await events(id)).map((r) => r.kind)).toEqual(['task.ready']);
    });

    it('a failed non-head (its verdict queued a successor) emits nothing', async () => {
        const root = await craftJob(
            { sql, org: ORG, author: '' },
            { author: null, status: 'running', createdMinutesAgo: 1 }
        );
        const successor = randomUUID();
        await sql.begin(async (tx) => {
            await tx`insert into job (org_id, id, command, status, parent_job_id, root_job_id)
                values (${ORG}, ${successor}, 'next node', 'queued', ${root}, ${root})`;
            await tx`update job set status = 'failed', finished_at = now() where org_id = ${ORG} and id = ${root}`;
        });
        expect(await events(root)).toHaveLength(0);
        expect(await events(successor)).toHaveLength(0);
    });

    it('a failed review job emits nothing', async () => {
        const review = await craftJob({ sql, org: ORG, author: '' }, { author: null, status: 'running' });
        await asReview(review);
        await sql`update job set status = 'failed', finished_at = now() where org_id = ${ORG} and id = ${review}`;
        expect(await events(review)).toHaveLength(0);
    });

    it('a head closed done emits no task.blocked', async () => {
        const id = await craftJob({ sql, org: ORG, author: '' }, { author: null, status: 'running' });
        await sql`update job set status = 'failed', finished_at = now(), done_at = now()
            where org_id = ${ORG} and id = ${id}`;
        expect(await events(id)).toHaveLength(0);
    });

    it('a gate failure’s reason carries its cause', async () => {
        const id = await queue();
        const c = await claim();
        await store.complete(id, c.leaseToken, {
            status: 'failed',
            exitCode: 1,
            output: 'no',
            failureKind: 'gate',
            failureCause: 'verification',
        });
        expect((await events(id))[0]).toMatchObject({ kind: 'task.blocked', reason: 'gate:verification' });
    });

    it('an interrupted run resumed by a re-claim and then failed emits exactly one task.blocked', async () => {
        const id = await queue();
        const first = await claim();
        await age(id);
        const second = await claim();
        expect(second.id).toBe(id);
        await store.complete(id, second.leaseToken, {
            status: 'failed',
            exitCode: 1,
            output: 'no',
            failureKind: 'timeout',
        });
        await store.complete(id, first.leaseToken, {
            status: 'failed',
            exitCode: 1,
            output: 'no',
            failureKind: 'timeout',
        });
        expect((await events(id)).map((r) => r.kind)).toEqual(['task.blocked']);
    });

    describe('workflow threads', () => {
        const flow = (edges: WorkflowDefinition['edges']): WorkflowDefinition => ({
            entry: 'work',
            params: [],
            nodes: [
                { name: 'work', kind: 'agent', session: 'fresh', prompt: 'work' },
                { name: 'repair', kind: 'agent', session: 'fresh', prompt: 'repair' },
            ],
            edges,
        });
        const queueFlow = async (definition: WorkflowDefinition): Promise<string> => {
            const job = await mustCreate(
                store.create('run the flow', null, {
                    repo: null,
                    executor: null,
                    workflow: {
                        id: randomUUID(),
                        name: 'flow',
                        node: definition.entry,
                        snapshot: definition,
                        params: {},
                    },
                })
            );
            return job.id;
        };

        it('a failure whose failed edge queues a successor emits nothing', async () => {
            const root = await queueFlow(flow([{ from: 'work', to: 'repair', when: 'failed' }]));
            const c = await claim();
            await store.complete(root, c.leaseToken, { status: 'failed', exitCode: 1, output: 'no' });
            expect(await events(root)).toHaveLength(0);
            const rows = await sql<{ id: string }[]>`
                select id from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'repair'`;
            expect(rows).toHaveLength(1);
            expect(await events(rows[0]!.id)).toHaveLength(0);
        });

        it('a step that reports itself blocked emits one task.blocked', async () => {
            const root = await queueFlow(flow([{ from: 'work', to: 'repair', when: 'succeeded' }]));
            const c = await claim();
            await store.complete(root, c.leaseToken, {
                status: 'failed',
                exitCode: 1,
                output: 'no',
                failureKind: 'blocked',
            });
            const rows = await events(root);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ kind: 'task.blocked', reason: 'blocked' });
        });

        it('a failed step with no matching edge emits one task.blocked', async () => {
            const root = await queueFlow(flow([{ from: 'work', to: 'repair', when: 'succeeded' }]));
            const c = await claim();
            await store.complete(root, c.leaseToken, { status: 'failed', exitCode: 1, output: 'no' });
            expect((await events(root)).map((r) => r.kind)).toEqual(['task.blocked']);
        });
    });

    it('a failed wait node whose failed edge re-parks emits nothing', async () => {
        const REPO = 'acme/widgets';
        const definition: WorkflowDefinition = {
            entry: 'verify',
            params: [],
            nodes: [
                { name: 'verify', kind: 'agent', session: 'fresh', publish: true, prompt: 'verify' },
                {
                    name: 'review',
                    kind: 'agent',
                    session: 'fresh',
                    prompt: 'react to review',
                    runtime: { runtime: 'pr-delivery-wait', block: 'fake/test-block', params: {} },
                },
            ],
            edges: [
                { from: 'verify', to: 'review', when: 'succeeded' },
                { from: 'review', to: 'review', when: 'failed', max: 3 },
            ],
        };
        const prs = createPrLifecycleStore({ sql, orgId: ORG });
        const waiting = createJobStore({ sql, orgId: ORG, prs });
        const root = (
            await mustCreate(
                waiting.create('start the thread', null, {
                    repo: REPO,
                    executor: null,
                    workflow: { id: randomUUID(), name: 'park', node: 'verify', snapshot: definition, params: {} },
                })
            )
        ).id;
        const first = await waiting.claim(WORKER, LEASE_SECONDS);
        await waiting.complete(root, first!.leaseToken, {
            ...succeeded,
            publication: {
                repo: REPO,
                prNumber: 11,
                prUrl: `https://github.com/${REPO}/pull/11`,
                headBranch: `factory/${root}`,
                baseBranch: 'main',
            },
        });
        await prs.recordDelivery({
            deliveryId: randomUUID(),
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 11,
        });
        await sweepRuntimeWakes({ sql, orgId: ORG, prs });
        const woken = await waiting.claim(WORKER, LEASE_SECONDS);
        const [node] = await sql<
            { workflow_node: string }[]
        >`select workflow_node from job where org_id = ${ORG} and id = ${woken!.id}`;
        expect(node!.workflow_node).toBe('review');

        await waiting.complete(woken!.id, woken!.leaseToken, { status: 'failed', exitCode: 1, output: 'no' });

        const parked = await sql`select 1 from workflow_round where org_id = ${ORG} and root_job_id = ${root}
            and workflow_node = 'review' and woken_at is null`;
        expect(parked).toHaveLength(1);
        expect(await events(woken!.id)).toHaveLength(0);
    });

    describe('a failure under a durable wait', () => {
        const parkUnderWait = async (cancelled: boolean): Promise<string> => {
            const root = await craftJob({ sql, org: ORG, author: '' }, { author: null, status: 'running' });
            await sql.begin(async (tx) => {
                await tx`insert into workflow_wait (org_id, root_job_id, reason, repo, pr_number, cancelled_at)
                    values (${ORG}, ${root}, 'wait', 'acme/widgets', 1, ${cancelled ? new Date() : null})`;
                await tx`insert into workflow_round (org_id, root_job_id, workflow_node, round, repo, pr_number, command, parent_job_id)
                    values (${ORG}, ${root}, 'wait', 1, 'acme/widgets', 1, 'continue', ${root})`;
                await tx`update job set status = 'failed', finished_at = now() where org_id = ${ORG} and id = ${root}`;
            });
            return root;
        };

        it('a failure that re-parks its thread into an open wait emits nothing', async () => {
            expect(await events(await parkUnderWait(false))).toHaveLength(0);
        });

        it('a failure under a cancelled wait still emits task.blocked', async () => {
            expect((await events(await parkUnderWait(true))).map((r) => r.kind)).toEqual(['task.blocked']);
        });
    });

    it('events are scoped to the job’s org', async () => {
        const id = await craftJob({ sql, org: OTHER_ORG, author: '' }, { author: null, status: 'running' });
        await sql`update job set status = 'succeeded', finished_at = now() where org_id = ${OTHER_ORG} and id = ${id}`;
        expect(await events(id, ORG)).toHaveLength(0);
        expect(await events(id, OTHER_ORG)).toMatchObject([{ org_id: OTHER_ORG, kind: 'task.ready' }]);
    });
});
