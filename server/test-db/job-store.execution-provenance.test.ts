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
    adopts_claim_seq: string | null;
    resumed: boolean;
    created_at: Date;
    ended_at: Date | null;
    origin: string;
    removed_at: Date | null;
    updated_at: Date;
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
            { claim_seq: String(first.claimSeq), session_id: session, origin: 'reported' },
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
        // Only the first claim's own report is on record; the fresh claim inherits nothing.
        expect((await sessions(id)).map((r) => r.claim_seq)).toEqual([String(first.claimSeq)]);

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

    const reviewingStore = () =>
        createJobStore({
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

    it('resolves a named review to its requesting job and root, and a lost reviewer resumes its session', async () => {
        const reviewStore = reviewingStore();
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
        expect(await sessions(review.id)).toMatchObject([
            { session_id: session, origin: 'reported' },
            { session_id: session, origin: 'inferred_at_claim' },
        ]);
    });

    it('resolves the requesting root of a review asked by a follow-up caller', async () => {
        const reviewStore = reviewingStore();
        const rootId = (await mustCreate(reviewStore.create('ship it', null, { repo: 'acme/web', executor: null }))).id;
        const first = (await reviewStore.claim(WORKER, LEASE_SECONDS))!;
        await reviewStore.session(rootId, first.leaseToken, randomUUID());
        await reviewStore.complete(rootId, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const followUp = await reviewStore.createFollowUp(rootId, 'and one more', null);
        if (typeof followUp === 'string') throw new Error(followUp);
        const caller = (await reviewStore.claim(WORKER, LEASE_SECONDS))!;
        const request = { key: 'sec-2', profile: 'security', revision: 'abc', ref: reviewRefOf(followUp.id, 'sec-2') };

        const asked = await reviewStore.requestReview(followUp.id, caller.leaseToken, request);
        if (!('claim' in asked) || !asked.claim) throw new Error(`no review claim: ${asked.result}`);

        const [row] = await executions(asked.claim.id);
        expect(row).toMatchObject({ requesting_job_id: followUp.id, requesting_root_job_id: rootId });
        expect(followUp.id).not.toBe(rootId);
    });

    it('survives removal of the job: no foreign key cascades into provenance', async () => {
        const id = await queue();
        await claim();
        await sql`delete from job where org_id = ${ORG} and root_job_id = ${id}`;

        expect(await executions(id)).toHaveLength(1);
    });

    describe('session reports', () => {
        const lastSeen = (jobId: string) =>
            sql<{ last_seen_at: Date; first_seen_at: Date; agent: string | null }[]>`
                select first_seen_at, last_seen_at, agent from job_execution_session
                where org_id = ${ORG} and job_id = ${jobId}`;

        it('records a reported session once per execution: a repeat only advances last_seen', async () => {
            const id = await queue();
            const c = await claim();
            const session = randomUUID();

            expect(await store.session(id, c.leaseToken, session)).toBe('ok');
            const [before] = await lastSeen(id);
            expect(await store.session(id, c.leaseToken, session)).toBe('ok');

            expect(await sessions(id)).toEqual([
                { claim_seq: String(c.claimSeq), session_id: session, origin: 'reported' },
            ]);
            const [after] = await lastSeen(id);
            expect(after?.first_seen_at).toEqual(before?.first_seen_at);
            expect(after!.last_seen_at.getTime()).toBeGreaterThanOrEqual(before!.last_seen_at.getTime());
        });

        it('records nothing for a null report and keeps history when the pointer is cleared', async () => {
            const id = await queue();
            const c = await claim();
            expect(await store.session(id, c.leaseToken, null)).toBe('ok');
            expect(await sessions(id)).toEqual([]);
            expect((await executions(id))[0]?.launch).toBe('requested');

            const session = randomUUID();
            await store.session(id, c.leaseToken, session);
            expect(await store.session(id, c.leaseToken, null)).toBe('ok');

            expect(await sessions(id)).toEqual([
                { claim_seq: String(c.claimSeq), session_id: session, origin: 'reported' },
            ]);
            const [job] = await sql<{ session_id: string | null }[]>`select session_id from job where id = ${id}`;
            expect(job?.session_id).toBeNull();
        });

        it('keeps a replaced session as history beside the new one', async () => {
            const id = await queue();
            const c = await claim();
            const [a, b] = [randomUUID(), randomUUID()];
            await store.session(id, c.leaseToken, a);
            await store.session(id, c.leaseToken, b);

            expect((await sessions(id)).map((r) => r.session_id).sort()).toEqual([a, b].sort());
        });

        it('lets a stale lease neither mutate the current execution nor its pointer', async () => {
            const id = await queue();
            const first = await claim();
            await expireLease(sql, id);
            const second = await claim();
            const stale = randomUUID();

            expect(await store.session(id, first.leaseToken, stale)).toBe('lost');

            expect(await sessions(id)).toEqual([]);
            expect((await executions(id)).map((r) => r.launch)).toEqual(['unknown', 'requested']);
            const [job] = await sql<{ session_id: string | null }[]>`select session_id from job where id = ${id}`;
            expect(job?.session_id).toBeNull();
            expect(second.claimSeq).toBe(first.claimSeq + 1);
        });

        it('upgrades the inferred association of a resumed claim to reported, without a second row', async () => {
            const id = await queue();
            const first = await claim();
            const session = randomUUID();
            await store.session(id, first.leaseToken, session);
            await expireLease(sql, id);
            const second = await claim();

            await store.session(id, second.leaseToken, session);

            const rows = (await sessions(id)).filter((r) => r.claim_seq === String(second.claimSeq));
            expect(rows).toEqual([{ claim_seq: String(second.claimSeq), session_id: session, origin: 'reported' }]);
        });

        it('keeps the launch requested for a pre-launch report, a refused clear included', async () => {
            const id = await queue();
            const c = await claim();
            await store.session(id, c.leaseToken, randomUUID(), { agent: 'claude-code' });
            expect((await executions(id))[0]?.launch).toBe('requested');

            await store.session(id, c.leaseToken, null);
            expect((await executions(id))[0]?.launch).toBe('requested');
        });

        it('marks the launch observed on post-launch evidence and never downgrades it', async () => {
            const id = await queue();
            const c = await claim();
            await store.session(id, c.leaseToken, randomUUID(), { observed: true });
            expect((await executions(id))[0]?.launch).toBe('observed');

            await store.session(id, c.leaseToken, randomUUID(), { observed: true });
            expect((await executions(id))[0]?.launch).toBe('observed');
        });

        it('fills the telemetry agent once a report names it and keeps the first name', async () => {
            const id = await queue();
            const c = await claim();
            const session = randomUUID();
            await store.session(id, c.leaseToken, session);
            expect((await executions(id))[0]?.agent).toBeNull();

            await store.session(id, c.leaseToken, session, { agent: 'claude-code' });
            await store.session(id, c.leaseToken, session, { agent: 'opencode' });

            expect((await executions(id))[0]?.agent).toBe('claude-code');
            expect((await lastSeen(id))[0]?.agent).toBe('claude-code');
        });

        it('leaves the execution row untouched by a repeat report that changes nothing', async () => {
            const id = await queue();
            const c = await claim();
            const session = randomUUID();
            const evidence = { agent: 'opencode', observed: true };
            await store.session(id, c.leaseToken, session, evidence);
            const [before] = await executions(id);

            await store.session(id, c.leaseToken, session, evidence);

            expect((await executions(id))[0]?.updated_at).toEqual(before?.updated_at);
        });
    });
    describe('launch transitions', () => {
        const launches = async (jobId: string) =>
            (await executions(jobId)).map((r) => [
                Number(r.claim_seq),
                r.launch,
                r.adopts_claim_seq === null ? null : Number(r.adopts_claim_seq),
            ]);
        const forceLaunch = (jobId: string, seq: number, to: string) =>
            sql`update job_execution set launch = ${to},
                    adopts_claim_seq = case when ${to}::text = 'adopted' then claim_seq - 1 else adopts_claim_seq end
                where org_id = ${ORG} and job_id = ${jobId} and claim_seq = ${seq}`;
        const adopt = (jobId: string, lease: string, claimSeq: number) =>
            store.interrupt(jobId, lease, {
                reason: `adopted the runner of claim ${claimSeq}`,
                release: false,
                claimSeq,
            });

        it('refuses in storage every move that is not forward', async () => {
            const legal: [string, string][] = [
                ['requested', 'observed'],
                ['requested', 'refused'],
                ['requested', 'unknown'],
                ['requested', 'adopted'],
                ['unknown', 'observed'],
            ];
            const illegal: [string, string][] = [
                ['observed', 'requested'],
                ['observed', 'unknown'],
                ['observed', 'refused'],
                ['refused', 'requested'],
                ['refused', 'observed'],
                ['refused', 'unknown'],
                ['unknown', 'requested'],
                ['unknown', 'refused'],
            ];
            const reach = async (from: string, jobId: string, seq: number) => {
                // Walk the legal graph to `from`, so each case starts from a state storage allows.
                const path: Record<string, string[]> = {
                    requested: [],
                    observed: ['observed'],
                    refused: ['refused'],
                    unknown: ['unknown'],
                };
                for (const step of path[from] ?? []) await forceLaunch(jobId, seq, step);
            };
            for (const [from, to] of legal) {
                const id = await queue();
                const c = await claim();
                await reach(from, id, c.claimSeq);
                await forceLaunch(id, c.claimSeq, to);
                expect((await executions(id))[0]?.launch).toBe(to);
            }
            for (const [from, to] of illegal) {
                const id = await queue();
                const c = await claim();
                await reach(from, id, c.claimSeq);
                await expect(forceLaunch(id, c.claimSeq, to), `${from} -> ${to}`).rejects.toMatchObject({
                    constraint_name: 'job_execution_launch_transition',
                });
                expect((await executions(id))[0]?.launch).toBe(from);
            }
        });

        it('enforces adopts_claim_seq below the claim, set once, on adopted rows only', async () => {
            const id = await queue();
            const c = await claim();
            const adoptsAt = (seq: number | null, launch: string) =>
                sql`update job_execution set launch = ${launch}, adopts_claim_seq = ${seq}
                    where org_id = ${ORG} and job_id = ${id} and claim_seq = ${c.claimSeq}`;

            await expect(adoptsAt(c.claimSeq, 'adopted')).rejects.toMatchObject({
                constraint_name: 'job_execution_adopts_earlier',
            });
            await expect(adoptsAt(null, 'adopted')).rejects.toMatchObject({
                constraint_name: 'job_execution_adopted_link',
            });
            await expect(adoptsAt(c.claimSeq - 1, 'observed')).rejects.toMatchObject({
                constraint_name: 'job_execution_adopted_link',
            });
            await sql`update job_execution set launch = 'adopted', adopts_claim_seq = 0
                      where org_id = ${ORG} and job_id = ${id}`;
            await expect(adoptsAt(0, 'observed')).rejects.toBeTruthy();
            await expect(
                sql`update job_execution set adopts_claim_seq = null where job_id = ${id}`
            ).rejects.toBeTruthy();
        });

        it('turns a claim whose lease expired without evidence into unknown, and keeps observed', async () => {
            const lost = await queue();
            const first = await claim();
            await store.session(lost, first.leaseToken, randomUUID());
            await expireLease(sql, lost);
            const second = await claim();
            expect(await launches(lost)).toEqual([
                [first.claimSeq, 'unknown', null],
                [second.claimSeq, 'requested', null],
            ]);

            const seen = await queue();
            const a = await claim();
            await store.session(seen, a.leaseToken, randomUUID(), { observed: true });
            await expireLease(sql, seen);
            const b = await claim();
            expect(await launches(seen)).toEqual([
                [a.claimSeq, 'observed', null],
                [b.claimSeq, 'requested', null],
            ]);
        });

        it('fences a superseded claim out: its late evidence moves nothing', async () => {
            const id = await queue();
            const first = await claim();
            await expireLease(sql, id);
            await claim();
            expect((await executions(id))[0]?.launch).toBe('unknown');

            // The stale claim's own report is fenced out: nothing about it moves.
            expect(await store.session(id, first.leaseToken, randomUUID(), { observed: true })).toBe('lost');
            expect((await executions(id))[0]?.launch).toBe('unknown');
        });

        it('records a released attempt as unknown', async () => {
            const drained = await queue();
            const a = await claim();
            await store.interrupt(drained, a.leaseToken, { reason: 'the driver was drained', release: true });
            expect(await launches(drained)).toEqual([[a.claimSeq, 'unknown', null]]);
        });

        it('records a refused start as refused, and a later claim does not rewrite it', async () => {
            const refused = await queue();
            const b = await claim();
            expect(
                await store.interrupt(refused, b.leaseToken, {
                    reason: 'the runner reports the container never started',
                    release: true,
                    refused: true,
                })
            ).toEqual({ result: 'ok', status: 'queued' });
            expect(await launches(refused)).toEqual([[b.claimSeq, 'refused', null]]);

            // The next claim of a refused start does not rewrite it.
            const again = await claim();
            expect(await launches(refused)).toEqual([
                [b.claimSeq, 'refused', null],
                [again.claimSeq, 'requested', null],
            ]);
        });

        it('keeps observed when a launched attempt is released, even flagged refused', async () => {
            const id = await queue();
            const c = await claim();
            await store.session(id, c.leaseToken, randomUUID(), { observed: true });
            await store.interrupt(id, c.leaseToken, { reason: 'evicted', release: true, refused: true });
            expect(await launches(id)).toEqual([[c.claimSeq, 'observed', null]]);
        });

        it('leaves launch alone when the interruption budget refuses the release', async () => {
            const id = await queue();
            const c = await claim();
            await spendInterruptionBudget(sql, id);
            expect(
                await store.interrupt(id, c.leaseToken, { reason: 'evicted', release: true, refused: true })
            ).toEqual({ result: 'exhausted' });
            expect(await launches(id)).toEqual([[c.claimSeq, 'requested', null]]);
        });

        it('settles a verdict with no launch evidence as unknown, which a report after the settle cannot move', async () => {
            const id = await queue();
            const c = await claim();
            await store.complete(id, c.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
            expect(await launches(id)).toEqual([[c.claimSeq, 'unknown', null]]);

            // Reports are fenced to a running lease: a sample after the verdict proves nothing here.
            await store.session(id, c.leaseToken, randomUUID(), { observed: true });
            expect(await launches(id)).toEqual([[c.claimSeq, 'unknown', null]]);
        });

        it('settles a stopped attempt as unknown', async () => {
            const stopped = await queue();
            const a = await claim();
            await store.stop(stopped, null);
            await store.suspend(stopped, a.leaseToken);
            expect(await launches(stopped)).toEqual([[a.claimSeq, 'unknown', null]]);
        });

        it('links an adopting claim to the original and creates no execution', async () => {
            const id = await queue();
            const original = await claim();
            await expireLease(sql, id);
            const adopter = await claim();

            expect(await adopt(id, adopter.leaseToken, original.claimSeq)).toEqual({ result: 'ok', status: 'running' });

            expect(await launches(id)).toEqual([
                [original.claimSeq, 'unknown', null],
                [adopter.claimSeq, 'adopted', original.claimSeq],
            ]);
            // Adoption writes no session association and no further execution row.
            expect(await sessions(id)).toEqual([]);
        });

        it('adopts idempotently: a repeated adoption changes nothing and refunds once', async () => {
            const id = await queue();
            const original = await claim();
            await expireLease(sql, id);
            const adopter = await claim();
            await adopt(id, adopter.leaseToken, original.claimSeq);
            const [before] =
                await sql`select * from job_execution where job_id = ${id} and claim_seq = ${adopter.claimSeq}`;

            expect(await adopt(id, adopter.leaseToken, original.claimSeq)).toEqual({ result: 'ok', status: 'running' });

            const [after] =
                await sql`select * from job_execution where job_id = ${id} and claim_seq = ${adopter.claimSeq}`;
            expect(after).toEqual(before);
            expect(await executions(id)).toHaveLength(2);
        });

        it('never marks an adopting claim observed, whichever report follows', async () => {
            const id = await queue();
            const original = await claim();
            await expireLease(sql, id);
            const adopter = await claim();
            await adopt(id, adopter.leaseToken, original.claimSeq);

            await store.session(id, adopter.leaseToken, randomUUID(), { observed: true });

            expect((await launches(id))[1]).toEqual([adopter.claimSeq, 'adopted', original.claimSeq]);
        });

        it('keeps an observed original observed when its adopter links to it', async () => {
            const id = await queue();
            const original = await claim();
            await store.session(id, original.leaseToken, randomUUID(), { observed: true });
            await expireLease(sql, id);
            const adopter = await claim();
            await adopt(id, adopter.leaseToken, original.claimSeq);
            expect(await launches(id)).toEqual([
                [original.claimSeq, 'observed', null],
                [adopter.claimSeq, 'adopted', original.claimSeq],
            ]);
        });

        it('records an adoption naming a claim not before its own, without failing the recovery', async () => {
            const id = await queue();
            const c = await claim();

            expect(await adopt(id, c.leaseToken, c.claimSeq)).toEqual({ result: 'ok', status: 'running' });

            expect(await launches(id)).toEqual([[c.claimSeq, 'requested', null]]);
            expect((await store.get(id))?.interruptions).toHaveLength(1);
        });

        describe('claim end', () => {
            const ends = async (jobId: string) =>
                (await executions(jobId)).map((r) => ({
                    seq: Number(r.claim_seq),
                    ended: r.ended_at,
                    start: r.created_at,
                }));

            it('stays open while the claim is live', async () => {
                const id = await queue();
                await claim();
                expect((await ends(id))[0]?.ended).toBeNull();
            });

            it.each([
                [
                    'a verdict',
                    async (id: string, lease: string) =>
                        store.complete(id, lease, { status: 'succeeded', exitCode: 0, output: '' }),
                ],
                [
                    'a release',
                    async (id: string, lease: string) =>
                        store.interrupt(id, lease, { reason: 'evicted', release: true }),
                ],
                [
                    'a suspend after a stop',
                    async (id: string, lease: string) => {
                        await store.stop(id, null);
                        return store.suspend(id, lease);
                    },
                ],
            ])('stamps the end once with %s, never before the start', async (_name, end) => {
                const id = await queue();
                const c = await claim();
                await end(id, c.leaseToken);
                const [first] = await ends(id);
                expect(first?.ended).toBeInstanceOf(Date);
                expect(first!.ended!.getTime()).toBeGreaterThanOrEqual(first!.start.getTime());

                await end(id, c.leaseToken);
                expect((await ends(id))[0]?.ended).toEqual(first?.ended);
            });

            it('ends a lost lease at the claim that supersedes it, and gives the adopter its own start', async () => {
                const id = await queue();
                const original = await claim();
                await expireLease(sql, id);
                const adopter = await claim();
                await adopt(id, adopter.leaseToken, original.claimSeq);

                const [a, b] = await ends(id);
                expect(a?.ended).toBeInstanceOf(Date);
                expect(b?.ended).toBeNull();
                expect(b!.start.getTime()).toBeGreaterThanOrEqual(a!.ended!.getTime());
                expect(b!.start.getTime()).toBeGreaterThanOrEqual(a!.start.getTime());
            });

            it('lets a stale lease end nothing', async () => {
                const id = await queue();
                const first = await claim();
                await expireLease(sql, id);
                await claim();
                const before = await ends(id);
                await store.interrupt(id, first.leaseToken, { reason: 'late', release: true });
                await store.complete(id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: '' });
                expect(await ends(id)).toEqual(before);
                expect(before[1]?.ended).toBeNull();
            });

            it('never stamps an end before the claim started, whatever the clock of the ending transaction', async () => {
                const id = await queue();
                const c = await claim();
                await sql`update job_execution set created_at = now() + interval '1 hour' where job_id = ${id}`;
                await store.interrupt(id, c.leaseToken, { reason: 'evicted', release: true });
                const [row] = await sql<{ ok: boolean }[]>`
                    select ended_at >= created_at as ok from job_execution where job_id = ${id}`;
                expect(row?.ok).toBe(true);
            });

            it('refuses in storage to move or precede an end', async () => {
                const id = await queue();
                const c = await claim();
                await expect(
                    sql`update job_execution set ended_at = created_at - interval '1 second' where job_id = ${id}`
                ).rejects.toMatchObject({ constraint_name: 'job_execution_ended_after_start' });
                await store.interrupt(id, c.leaseToken, { reason: 'evicted', release: true });
                await expect(sql`update job_execution set ended_at = now() where job_id = ${id}`).rejects.toMatchObject(
                    {
                        constraint_name: 'job_execution_launch_transition',
                    }
                );
            });
        });

        it('commits a launch outcome with the operation that proves it, or neither', async () => {
            const id = await queue();
            const c = await claim();
            await expect(
                sql.begin(async (tx) => {
                    await tx`update job set status = 'queued', started_at = null, lease_token = null where id = ${id}`;
                    expect(
                        (await tx`select launch from job_execution where job_id = ${id}`).map((r) => r.launch)
                    ).toEqual(['unknown']);
                    throw new Error('the commit never happened');
                })
            ).rejects.toThrow('never happened');

            expect(await launches(id)).toEqual([[c.claimSeq, 'requested', null]]);
            expect(await store.get(id)).toMatchObject({ status: 'running' });
        });

        it('converges under repeated recovery: no invented execution, no lost association', async () => {
            const id = await queue();
            const first = await claim();
            const session = randomUUID();
            await store.session(id, first.leaseToken, session);
            let last = first;
            for (let round = 0; round < 3; round++) {
                await expireLease(sql, id);
                last = await claim();
                await adopt(id, last.leaseToken, last.claimSeq - 1);
                await adopt(id, last.leaseToken, last.claimSeq - 1);
            }
            const rows = await launches(id);
            expect(rows.map((r) => r[0])).toEqual([1, 2, 3, 4].map((n) => first.claimSeq + n - 1));
            expect(rows.map((r) => r[1])).toEqual(['unknown', 'adopted', 'adopted', 'adopted']);
            expect(rows.map((r) => r[2])).toEqual(
                [null, 1, 2, 3].map((n) => (n === null ? null : first.claimSeq + n - 1))
            );
            expect((await sessions(id)).filter((r) => r.origin === 'reported')).toHaveLength(1);
        });
    });
});
