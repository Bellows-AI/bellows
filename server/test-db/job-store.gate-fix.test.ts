import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { Claim, GateReport, JobStore } from '../src/db/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { GATE_FIX_NODE, gateFixTarget } from './gate-fix-workflow.js';
import { useTestDb } from './harness.js';
import { expireLease } from './fixtures.js';

/** The default gate-fix workflow against the store: the red-gate walk, Stop and reclaim races. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = 'test-org';
const WORKER = 'worker-1';
const db = useTestDb({ orgs: [ORG], max: 8 });

let sql: Sql;
let store: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG, prs: createPrLifecycleStore({ sql, orgId: ORG }) });
});

const failedGate = (output: string): GateReport[] => [{ name: 'test', status: 'failed', exitCode: 1, output }];

async function queueDefault(rounds = 3): Promise<string> {
    const job = await store.create('do the thing', null, {
        repo: null,
        executor: null,
        workflow: gateFixTarget(rounds),
    });
    if (typeof job === 'string') throw new Error(job);
    return job.id;
}

const claim = async (): Promise<Claim> => {
    const c = (await store.claim(WORKER, 60)) as Claim;
    expect(c).not.toBeNull();
    return c;
};
const queuedGateFix = async (root: string) =>
    (await store.thread(root))!.filter((r) => r.workflowNode === GATE_FIX_NODE && r.status === 'queued');
const failGates = async (c: Claim, output: string) => {
    await store.gates(c.id, c.leaseToken, failedGate(output));
    await store.complete(c.id, c.leaseToken, {
        status: 'failed',
        exitCode: 1,
        output: null,
        failureKind: 'gate',
        treeChanged: true,
    });
};

const redGate: GateReport[] = [{ name: 'test', status: 'failed', exitCode: 1, output: 'attempt 1 red' }];

/** Issue #427 (G2): the verdict transaction against a Stop stamp no heartbeat has delivered yet. */
describe.skipIf(!enabled)('a verdict racing a Stop — database', () => {
    // A Stop stamped on a running row loses to a verdict that lands before the next beat:
    // complete() clears cancel_requested_at and must not walk the graph for it.
    it('a verdict racing a Stop does not queue the next workflow row', async () => {
        const root = await queueDefault();
        const c = await claim();
        await store.gates(c.id, c.leaseToken, failedGate('red'));
        const stop = await store.stop(c.id, null);
        expect(stop).toMatchObject({ result: 'requested' });
        await store.complete(c.id, c.leaseToken, {
            status: 'failed',
            exitCode: 1,
            output: null,
            failureKind: 'gate',
            treeChanged: true,
        });
        expect(await queuedGateFix(root)).toHaveLength(0);
    });
});

/** The verdict transaction reads the stored gate report: a red gate walks the graph into gate-fix. */
describe.skipIf(!enabled)('a red gate verdict — database', () => {
    it('queues exactly one gate-fix row', async () => {
        const root = await queueDefault(5);
        const task = await claim();
        await failGates(task, 'red');
        expect(await queuedGateFix(root)).toHaveLength(1);
    });
});

/** A reclaimed attempt never inherits the previous attempt's gate report (#428). */
describe.skipIf(!enabled)('claim: a reclaimed attempt starts without gates', () => {
    it("does not inherit the previous attempt's gate failure", async () => {
        const rounds = 3;
        const created = await store.create('do the thing', null, {
            repo: null,
            executor: null,
            workflow: gateFixTarget(rounds),
        });
        if (typeof created === 'string') throw new Error(created);

        const first = (await store.claim(WORKER, 60)) as Claim;
        await store.gates(first.id, first.leaseToken, redGate);
        // The first worker dies mid-run: its lease expires (aged in SQL, never slept).
        await expireLease(sql, first.id);
        const second = (await store.claim(WORKER, 60)) as Claim;
        expect(second.id).toBe(first.id);

        await store.complete(second.id, second.leaseToken, {
            status: 'failed',
            exitCode: 124,
            output: 'timed out',
            failureKind: 'timeout',
        });
        const gateFixes = (await store.thread(created.id))!.filter((r) => r.workflowNode === GATE_FIX_NODE);
        expect(gateFixes).toHaveLength(0);
    });
});
