import { randomUUID } from 'node:crypto';
import { notificationEventOf } from '@factory-ai/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { craftJob, testOrg } from './fixtures.js';

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
    occurred_at: Date;
}

const events = (id: string, org = ORG) =>
    sql<EventRow[]>`
        select id, kind, org_id, job_id, root_job_id, repo, workflow, command, reason, occurred_at
        from notification_event where org_id = ${org} and job_id = ${id} order by kind
    `;

const expectedId = async (id: string, kind: string): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`select md5(${id}::text || '/' || ${kind})::uuid as id`;
    return row!.id;
};

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

    it('events are scoped to the job’s org', async () => {
        const id = await craftJob({ sql, org: OTHER_ORG, author: '' }, { author: null, status: 'running' });
        await sql`update job set status = 'succeeded', finished_at = now() where org_id = ${OTHER_ORG} and id = ${id}`;
        expect(await events(id, ORG)).toHaveLength(0);
        expect(await events(id, OTHER_ORG)).toMatchObject([{ org_id: OTHER_ORG, kind: 'task.ready' }]);
    });
});
