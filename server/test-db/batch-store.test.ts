import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { resolveBatchPlan, validateBatchPlan, type BatchPlan, type ResolvedBatchPlan } from '@factory-ai/core';
import { createBatchStore, type BatchStartInput, type BatchStore } from '../src/db/batches/batch-store.js';
import { IdempotencyKeyReusedError } from '../src/db/jobs/job-store-idempotency.js';
import { useTestDb } from './harness.js';
import { testOrg, testUser } from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);

const ORG = testOrg();
const OTHER_ORG = testOrg();
const ALICE_USER = testUser('alice');
const ALICE = ALICE_USER.id;

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [ALICE_USER] });

let sql: Sql;
let store: BatchStore;
let otherStore: BatchStore;

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createBatchStore({ sql, orgId: ORG });
    otherStore = createBatchStore({ sql, orgId: OTHER_ORG });
});

const task = (key: string, extra: Record<string, unknown> = {}) => ({
    key,
    objective: `do ${key}`,
    acceptance: 'it works',
    verification: 'npm test',
    ...extra,
});

function parsed(raw: Record<string, unknown>): BatchPlan {
    const result = validateBatchPlan(raw);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.plan;
}

const twoRepoPlan = (title = 'Two repos') =>
    parsed({
        planVersion: 1,
        title,
        targets: [
            { key: 'web', repo: 'acme/web' },
            { key: 'api', repo: 'acme/api', branch: 'release' },
        ],
        defaultTarget: 'web',
        executor: 'claude',
        executorScope: 'org',
        policy: 'automerge',
        concurrency: 3,
        stages: [
            {
                key: 'one',
                tasks: [
                    task('a'),
                    task('b', { target: 'api', required: false, executor: 'mine', executorScope: 'user' }),
                ],
            },
            {
                key: 'two',
                policy: 'human',
                tasks: [task('c', { completion: { kind: 'accepted', condition: 'QA signs off' } })],
            },
        ],
    });

const singlePlan = (title = 'One repo') =>
    parsed({
        planVersion: 1,
        title,
        targets: [{ key: 'web', repo: 'acme/web' }],
        defaultTarget: 'web',
        stages: [{ key: 'one', tasks: [task('a'), task('b')] }],
    });

const defaults = { 'acme/web': 'main', 'acme/api': 'main' };
const resolved = (plan: BatchPlan): ResolvedBatchPlan => resolveBatchPlan(plan, defaults);

/** Freezes the draft's first version with `plan` resolved, as alice unless `extra` says otherwise. */
const freeze = (id: string, plan: BatchPlan, extra: Partial<BatchStartInput> = {}, target: BatchStore = store) =>
    target.start({ id, version: 1, plan: resolved(plan), startedBy: ALICE, ...extra });

async function jobId(org = ORG): Promise<string> {
    // A root job is its own thread root (022: root_job_id is not null).
    const id = randomUUID();
    await sql`insert into job (org_id, id, command, root_job_id) values (${org}, ${id}, 'echo', ${id})`;
    return id;
}

describe.skipIf(!enabled)('the batch store', () => {
    it('round-trips a two-repository draft: targets and task assignments exactly', async () => {
        const plan = twoRepoPlan();
        const { id, version } = await store.create(plan, ALICE);
        expect(version).toBe(1);

        const record = await store.get(id);
        expect(record).toMatchObject({ id, status: 'draft', version: 1, createdBy: ALICE, startedAt: null });
        expect(record!.plan).toEqual(plan);
        expect(record!.tasks.map((state) => [state.key, state.stage, state.execution, state.pr, state.gate])).toEqual([
            ['a', 'one', 'pending', 'none', 'open'],
            ['b', 'one', 'pending', 'none', 'open'],
            ['c', 'two', 'pending', 'none', 'open'],
        ]);
        expect(record!.tasks.every((state) => state.waitReason === null && state.rootJobId === null)).toBe(true);
        expect((await store.list()).map((summary) => [summary.id, summary.taskCount])).toEqual([[id, 3]]);
    });

    it('scopes every read and write to the org', async () => {
        const { id } = await store.create(singlePlan(), ALICE);
        expect(await otherStore.get(id)).toBeNull();
        expect(await otherStore.list()).toEqual([]);
        expect(await otherStore.replace(id, 1, singlePlan('Hijack'))).toEqual({ result: 'missing' });
        expect(await freeze(id, singlePlan(), { startedBy: null }, otherStore)).toEqual({ result: 'missing' });
        expect((await store.get(id))!.plan.title).toBe('One repo');
    });

    it('refuses a task target from another batch or another org (the composite key)', async () => {
        const first = await store.create(singlePlan('First'), ALICE);
        const second = await store.create(
            parsed({
                planVersion: 1,
                title: 'Second',
                targets: [{ key: 'other', repo: 'acme/other' }],
                defaultTarget: 'other',
                stages: [{ key: 'one', tasks: [task('z')] }],
            }),
            ALICE
        );
        // Task `a` of the first batch pointed at the second batch's target key.
        await expect(
            sql`update batch_task set target_key = 'other' where org_id = ${ORG} and batch_id = ${first.id} and key = 'a'`
        ).rejects.toThrow(/batch_task_target_fk/);
        // And an org-crossing reference: the other org has no such batch to hold the target.
        await expect(
            sql`update batch_task set org_id = ${OTHER_ORG} where org_id = ${ORG} and batch_id = ${second.id}`
        ).rejects.toThrow();
    });

    it('lets one thread back one task, and one task keep one thread', async () => {
        const { id } = await store.create(singlePlan(), ALICE);
        const thread = await jobId();
        const other = await jobId();
        await sql`update batch_task set root_job_id = ${thread} where org_id = ${ORG} and batch_id = ${id} and key = 'a'`;

        await expect(
            sql`update batch_task set root_job_id = ${thread} where org_id = ${ORG} and batch_id = ${id} and key = 'b'`
        ).rejects.toThrow(/batch_task_root_uk/);
        await expect(
            sql`update batch_task set root_job_id = ${other} where org_id = ${ORG} and batch_id = ${id} and key = 'a'`
        ).rejects.toThrow(/already has a thread/);

        // Removing the thread unbinds the task rather than blocking the removal.
        await sql`delete from job where org_id = ${ORG} and id = ${thread}`;
        const [row] = await sql<{ root_job_id: string | null }[]>`
            select root_job_id from batch_task where org_id = ${ORG} and batch_id = ${id} and key = 'a'
        `;
        expect(row!.root_job_id).toBeNull();
    });

    it('refuses a thread of another org', async () => {
        const { id } = await store.create(singlePlan(), ALICE);
        const foreign = await jobId(OTHER_ORG);
        await expect(
            sql`update batch_task set root_job_id = ${foreign} where org_id = ${ORG} and batch_id = ${id} and key = 'a'`
        ).rejects.toThrow(/batch_task_root_fk/);
    });

    it('replaces a draft whole, and refuses a stale version without changing it', async () => {
        const { id } = await store.create(singlePlan(), ALICE);
        expect(await store.replace(id, 1, twoRepoPlan('Replaced'))).toEqual({ result: 'ok', version: 2 });
        expect((await store.get(id))!.plan).toEqual(twoRepoPlan('Replaced'));

        expect(await store.replace(id, 1, singlePlan('Stale'))).toEqual({ result: 'stale', version: 2 });
        expect((await store.get(id))!.plan.title).toBe('Replaced');
    });

    it('freezes the resolved plan: explicit branches, targets, stage policies and executors', async () => {
        const { id } = await store.create(twoRepoPlan(), ALICE);
        expect(await freeze(id, twoRepoPlan())).toEqual({ result: 'ok' });

        const record = (await store.get(id))!;
        expect(record).toMatchObject({ status: 'running', version: 1, startedBy: ALICE });
        expect(record.startedAt).not.toBeNull();
        expect(record.plan.targets).toEqual([
            { key: 'web', repo: 'acme/web', branch: 'main' },
            { key: 'api', repo: 'acme/api', branch: 'release' },
        ]);
        expect(record.plan.stages.map((stage) => stage.policy)).toEqual(['automerge', 'human']);
        expect(
            record.plan.stages.flatMap((stage) =>
                stage.tasks.map((t) => [t.key, t.target, t.executor, t.executorScope])
            )
        ).toEqual([
            ['a', 'web', 'claude', 'org'],
            ['b', 'api', 'mine', 'user'],
            ['c', 'web', 'claude', 'org'],
        ]);
        const jobs = await sql`select 1 from job where org_id = ${ORG}`;
        expect(jobs).toHaveLength(0);
    });

    it('answers a second start, and an edit after start, as started', async () => {
        const { id } = await store.create(singlePlan(), ALICE);
        await freeze(id, singlePlan());
        expect(await freeze(id, singlePlan())).toEqual({ result: 'started' });
        expect(await store.replace(id, 1, singlePlan('Late'))).toEqual({ result: 'started' });
    });

    it('refuses writes to a started plan, and keeps the runtime columns writable', async () => {
        const { id } = await store.create(singlePlan(), ALICE);
        await freeze(id, singlePlan());
        const where = sql`org_id = ${ORG} and batch_id = ${id}`;

        await expect(sql`update batch_task set objective = 'rewritten' where ${where} and key = 'a'`).rejects.toThrow(
            /immutable/
        );
        await expect(sql`update batch_task set target_key = null where ${where} and key = 'a'`).rejects.toThrow(
            /immutable/
        );
        await expect(sql`delete from batch_task where ${where} and key = 'a'`).rejects.toThrow(/immutable/);
        await expect(sql`update batch_target set branch = 'other' where ${where}`).rejects.toThrow(/immutable/);
        await expect(sql`delete from batch_target where ${where}`).rejects.toThrow(/immutable/);
        await expect(sql`update batch_stage set policy = 'automerge' where ${where}`).rejects.toThrow(/immutable/);
        await expect(
            sql`insert into batch_stage (org_id, batch_id, key, position) values (${ORG}, ${id}, 'extra', 9)`
        ).rejects.toThrow(/immutable/);
        await expect(sql`update batch set title = 'x' where org_id = ${ORG} and id = ${id}`).rejects.toThrow(
            /immutable/
        );
        await expect(sql`update batch_task set executor_scope = 'org' where ${where} and key = 'a'`).rejects.toThrow(
            /immutable/
        );
        await expect(sql`update batch set executor_scope = 'org' where org_id = ${ORG} and id = ${id}`).rejects.toThrow(
            /immutable/
        );

        await sql`update batch_task set execution = 'running', gate = 'passed' where ${where} and key = 'a'`;
        const [row] = await sql<{ execution: string; gate: string }[]>`
            select execution, gate from batch_task where ${where} and key = 'a'
        `;
        expect(row).toEqual({ execution: 'running', gate: 'passed' });
    });

    it('freezes no scope beside no executor: a task left to the claim default has none', async () => {
        const { id } = await store.create(singlePlan(), ALICE);
        await freeze(id, singlePlan());
        const [row] = await sql<{ executor: string | null; executor_scope: string }[]>`
            select executor, executor_scope from batch_task where org_id = ${ORG} and batch_id = ${id} and key = 'a'
        `;
        expect(row).toEqual({ executor: null, executor_scope: null });
        expect((await store.get(id))!.plan.stages[0]!.tasks[0]).not.toHaveProperty('executorScope');
    });

    it('refuses an executor scope outside the pair at the column', async () => {
        const { id } = await store.create(singlePlan(), ALICE);
        await expect(
            sql`update batch_task set executor_scope = 'team' where org_id = ${ORG} and batch_id = ${id} and key = 'a'`
        ).rejects.toThrow(/batch_task_executor_scope_ck/);
    });

    it('refuses to reach started with an unresolved plan', async () => {
        const { id } = await store.create(singlePlan(), ALICE);
        await expect(
            sql`update batch set status = 'started', started_at = now() where org_id = ${ORG} and id = ${id}`
        ).rejects.toThrow(/unresolved/);
    });

    it('lets a concurrent start and PUT at one version produce exactly one winner', async () => {
        for (let round = 0; round < 8; round += 1) {
            const draft = singlePlan(`Round ${round}`);
            const { id } = await store.create(draft, ALICE);
            const edited = singlePlan(`Edited ${round}`);
            const [started, replaced] = await Promise.all([freeze(id, draft), store.replace(id, 1, edited)]);

            const record = (await store.get(id))!;
            if (started.result === 'ok') {
                expect(replaced).toEqual({ result: 'started' });
                expect(record.status).toBe('running');
                expect(record.plan.title).toBe(draft.title);
                expect(record.version).toBe(1);
            } else {
                expect(started).toEqual({ result: 'stale', version: 2 });
                expect(replaced).toEqual({ result: 'ok', version: 2 });
                expect(record.status).toBe('draft');
                expect(record.plan.title).toBe(edited.title);
            }
        }
    });

    it('lets two concurrent starts at one version produce exactly one start', async () => {
        const { id } = await store.create(singlePlan(), ALICE);
        const results = await Promise.all([freeze(id, singlePlan()), freeze(id, singlePlan())]);
        expect(results.map((r) => r.result).sort()).toEqual(['ok', 'started']);
    });

    describe('Idempotency-Key', () => {
        const create = (key: string, fingerprint = 'fp-1') => ({
            operation: 'batch-create' as const,
            key,
            fingerprint,
        });

        it('replays a create, serializing concurrent duplicates into one batch', async () => {
            const [first, second] = await Promise.all([
                store.create(singlePlan(), ALICE, create('create-key-0001')),
                store.create(singlePlan(), ALICE, create('create-key-0001')),
            ]);
            expect(second.id).toBe(first.id);
            expect([first.replayed, second.replayed].filter(Boolean)).toHaveLength(1);
            expect(await store.list()).toHaveLength(1);
        });

        it('refuses the key for a different request, and scopes it to the caller', async () => {
            await store.create(singlePlan(), ALICE, create('create-key-0002'));
            await expect(store.create(singlePlan(), ALICE, create('create-key-0002', 'fp-2'))).rejects.toThrow(
                IdempotencyKeyReusedError
            );
            const bobs = await store.create(singlePlan(), null, create('create-key-0002', 'fp-2'));
            expect(bobs.replayed).toBeUndefined();
        });

        it('replays a start after it has started', async () => {
            const { id } = await store.create(singlePlan(), ALICE);
            const key = { operation: 'batch-start' as const, key: 'start-key-0001', fingerprint: 'fp-start' };
            await freeze(id, singlePlan(), { idempotency: key });
            expect(await store.replayOfStart(ALICE, key)).toBe(id);
            expect(await freeze(id, singlePlan(), { idempotency: key })).toEqual({
                result: 'ok',
                replayed: true,
            });
        });
    });
});
