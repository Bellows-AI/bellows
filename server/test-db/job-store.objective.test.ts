import { randomUUID } from 'node:crypto';
import { OBJECTIVE_MODE } from '@factory-ai/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, GateReport, JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { expireLease, testConnection, testOrg } from './fixtures.js';

/**
 * Issue 543: a task created without a workflow is OBJECTIVE mode — an ordinary claimable job with
 * no workflow snapshot, node, successor or wait. The mode is stored on the root row and inherited
 * by every follow-up and retry.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const WORKER = 'worker-1';
const db = useTestDb({ orgs: [ORG], max: 8 });

let sql: Sql;
let store: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

const failedGate: GateReport[] = [{ name: 'test', status: 'failed', exitCode: 1, output: 'red' }];

async function queueObjective(command = 'scaffold the project'): Promise<string> {
    const created = await store.create(command, null, { repo: null, executor: null });
    if (typeof created === 'string') throw new Error(created);
    return created.id;
}

const redGate = (output = 'red'): GateReport[] => [{ name: 'test', status: 'failed', exitCode: 1, output }];

/** Claims the queued row and settles it as a run that failed on its declared gate. */
async function failOnGate(
    over: { failureKind?: 'gate' | 'blocked' | 'services'; output?: string } = {}
): Promise<Claim> {
    const claimed = await claim();
    await store.gates(claimed.id, claimed.leaseToken, redGate(over.output));
    await store.complete(claimed.id, claimed.leaseToken, {
        status: 'failed',
        exitCode: 1,
        output: 'red',
        failureKind: over.failureKind ?? 'gate',
    });
    return claimed;
}

const claim = async (): Promise<Claim> => {
    const claimed = (await store.claim(WORKER, 60)) as Claim | null;
    expect(claimed).not.toBeNull();
    return claimed!;
};

const modesOf = async (): Promise<{ mode: string; workflow_node: string | null }[]> =>
    sql`select mode, workflow_node from job order by created_at, id`;

describe.skipIf(!enabled)('objective mode — database', () => {
    it('creates a plain claimable row: mode objective, no workflow columns', async () => {
        const id = await queueObjective();
        const [row] = await sql<
            {
                mode: string;
                workflow_id: string | null;
                workflow_name: string | null;
                workflow_node: string | null;
                workflow_snapshot: unknown;
                workflow_params: unknown;
            }[]
        >`select mode, workflow_id, workflow_name, workflow_node, workflow_snapshot, workflow_params
          from job where id = ${id}`;
        expect(row).toEqual({
            mode: OBJECTIVE_MODE,
            workflow_id: null,
            workflow_name: null,
            workflow_node: null,
            workflow_snapshot: null,
            workflow_params: null,
        });
        expect((await store.get(id))?.mode).toBe(OBJECTIVE_MODE);
    });

    it('claims with no publish key and an objective master prompt', async () => {
        await queueObjective();
        const claimed = await claim();
        expect('publish' in claimed && claimed.publish !== undefined).toBe(false);
        expect(claimed.masterPrompt).toContain('- Mode: objective');
    });

    it.each([
        ['succeeded', { status: 'succeeded' as const, exitCode: 0, output: 'done' }],
        ['failed', { status: 'failed' as const, exitCode: 1, output: 'stuck', failureKind: 'blocked' as const }],
    ])('a %s verdict leaves a one-row thread — no successor, no wait', async (status, verdict) => {
        const root = await queueObjective();
        const claimed = await claim();
        await store.complete(claimed.id, claimed.leaseToken, verdict);
        const rows = (await store.thread(root))!;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe(status);
        expect(rows[0]!.mode).toBe(OBJECTIVE_MODE);
    });

    it('marking done stamps doneAt and keeps the run status', async () => {
        const root = await queueObjective();
        const claimed = await claim();
        await store.complete(claimed.id, claimed.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const done = await store.markDone(root, null);
        expect(done).toMatchObject({ status: 'succeeded' });
        const [head] = (await store.thread(root))!;
        expect(head!.status).toBe('succeeded');
        expect(head!.doneAt).not.toBeNull();
    });

    it('a follow-up inherits the objective mode', async () => {
        const root = await queueObjective();
        const claimed = await claim();
        await store.complete(claimed.id, claimed.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const followUp = await store.createFollowUp(root, 'now add tests', null);
        if (typeof followUp === 'string') throw new Error(`follow-up refused: ${followUp}`);
        expect(await modesOf()).toEqual([
            { mode: OBJECTIVE_MODE, workflow_node: null },
            { mode: OBJECTIVE_MODE, workflow_node: null },
        ]);
    });

    it('issue 550: survives a dead worker and a red gate on one row, then settles succeeded under the final evidence', async () => {
        const root = await queueObjective();
        const first = await claim();
        await expireLease(sql, first.id);

        // The dead worker's lease is reclaimed in place: same row, fresh token, the expiry its
        // interruption rather than a spent attempt.
        const second = await claim();
        expect(second).toMatchObject({ id: first.id, attempts: 1, claimSeq: 2 });
        expect(second.leaseToken).not.toBe(first.leaseToken);

        // The red gate fails the run and the board queues nothing; the member's follow-up continues the thread.
        await store.gates(second.id, second.leaseToken, failedGate);
        await store.complete(second.id, second.leaseToken, {
            status: 'failed',
            exitCode: 1,
            output: 'red',
            failureKind: 'gate',
        });
        const repair = await store.createFollowUp(root, 'fix the failing test', null);
        if (typeof repair === 'string') throw new Error(`follow-up refused: ${repair}`);
        const third = await claim();
        expect(third.id).toBe(repair.id);
        await store.gates(third.id, third.leaseToken, [{ name: 'test', status: 'passed', exitCode: 0, output: 'ok' }]);
        await store.complete(third.id, third.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });

        const rows = (await store.thread(root))!;
        expect(rows.map((row) => row.status).sort()).toEqual(['failed', 'succeeded']);
        expect(rows.every((row) => row.mode === OBJECTIVE_MODE)).toBe(true);
    });

    it('a retry inherits the objective mode', async () => {
        const root = await queueObjective();
        const claimed = await claim();
        await store.complete(claimed.id, claimed.leaseToken, {
            status: 'failed',
            exitCode: 1,
            output: 'boom',
            failureKind: 'runner_error',
        });
        const retry = await store.createRetry(root, null);
        if (typeof retry === 'string') throw new Error(`retry refused: ${retry}`);
        expect(await modesOf()).toEqual([
            { mode: OBJECTIVE_MODE, workflow_node: null },
            { mode: OBJECTIVE_MODE, workflow_node: null },
        ]);
    });

    it('refuses an objective row carrying a workflow node (job_mode_node_ck)', async () => {
        await expect(
            sql`insert into job (org_id, id, root_job_id, command, mode, workflow_node)
                select ${ORG}, x, x, 'x', 'objective', 'task' from (select gen_random_uuid() as x) s`
        ).rejects.toMatchObject({ constraint_name: 'job_mode_node_ck' });
    });

    it('refuses an unknown mode (job_mode_ck)', async () => {
        await expect(
            sql`insert into job (org_id, id, root_job_id, command, mode)
                select ${ORG}, x, x, 'x', 'freeform' from (select gen_random_uuid() as x) s`
        ).rejects.toMatchObject({ constraint_name: 'job_mode_ck' });
    });

    describe('a red gate is repaired inside the run, never by a new row', () => {
        it('a failed gate queues no job', async () => {
            const root = await queueObjective();
            const first = await failOnGate({ output: 'expected 1 to equal 2' });
            const rows = (await store.thread(root))!;
            expect(rows.map((row) => [row.id, row.status])).toEqual([[first.id, 'failed']]);
            expect(await store.claim(WORKER, 60)).toBeNull();
        });

        it('a capped run ends failed with no follow-up row', async () => {
            const root = await queueObjective();
            const claimed = await claim();
            for (let pass = 0; pass < 3; pass++) {
                const written = await store.writeFinishPass(claimed.id, claimed.leaseToken, {
                    passId: randomUUID(),
                    runClaimSeq: claimed.claimSeq,
                    verdict: 'failed',
                    gate: 'test',
                });
                expect(written).toEqual({ result: 'ok' });
            }
            expect(await store.readFinishRounds(claimed.id, claimed.leaseToken)).toEqual({
                result: 'ok',
                failedRounds: 3,
            });
            await store.gates(claimed.id, claimed.leaseToken, redGate());
            await store.complete(claimed.id, claimed.leaseToken, {
                status: 'failed',
                exitCode: 1,
                output: 'red',
                failureKind: 'gate',
            });
            const rows = (await store.thread(root))!;
            expect(rows.map((row) => [row.id, row.status])).toEqual([[claimed.id, 'failed']]);
            expect(await store.claim(WORKER, 60)).toBeNull();
        });

        it('freezes the cap from the executor at launch: a later edit changes nothing', async () => {
            await sql`
                insert into executor_profile (org_id, user_id, name, type, config, gate_fix_rounds, position, provider_connection_id)
                values (${ORG}, null, 'strict', 'claude-code', '{}'::jsonb, 0, 0, ${await testConnection(sql, ORG)})`;
            const created = await store.create('scaffold', null, {
                repo: null,
                executor: 'strict',
                executorScope: 'org',
            });
            if (typeof created === 'string') throw new Error(created);
            await sql`update executor_profile set gate_fix_rounds = 5 where name = 'strict'`;
            const [root] = await sql<{ gate_fix_rounds: number | null }[]>`
                select gate_fix_rounds from job where id = ${created.id}`;
            expect(root!.gate_fix_rounds).toBe(0);
            await failOnGate();
            expect((await store.thread(created.id))!).toHaveLength(1);
        });

        it.each(['blocked', 'services'] as const)('rests on a %s failure', async (failureKind) => {
            const root = await queueObjective();
            await failOnGate({ failureKind });
            expect((await store.thread(root))!).toHaveLength(1);
        });

        it('rests once the thread is marked done', async () => {
            const root = await queueObjective();
            const claimed = await claim();
            await store.gates(claimed.id, claimed.leaseToken, redGate());
            await sql`update job set done_at = now() where id = ${root}`;
            await store.complete(claimed.id, claimed.leaseToken, {
                status: 'failed',
                exitCode: 1,
                output: 'red',
                failureKind: 'gate',
            });
            expect((await store.thread(root))!).toHaveLength(1);
        });
    });
});
