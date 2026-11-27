import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, GateReport, JobStore } from '../src/db/jobs/job-store-types.js';
import { INTERP_TAIL_LIMIT, TRUNCATION_MARKER } from '../src/db/workflows/workflow-schema.js';
import { useTestDb } from './harness.js';
import { mustCreate, testOrg } from './fixtures.js';

/** A follow-up after a gate-failed run carries the failed gate's report; `lastGateReports` serves `factory-gate --last`. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const LEASE_SECONDS = 300;
const db = useTestDb({ max: 8, orgs: [ORG] });

let sql: Sql;
let store: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

const gate = (name: string, status: GateReport['status'], output: string | null, exitCode = 1): GateReport => ({
    name,
    status,
    exitCode: status === 'passed' ? 0 : exitCode,
    output,
});

/**
 * A task whose first run finishes with `reports` stored; returns the root id.
 */
async function finishRun(command: string, reports: GateReport[], failed: boolean): Promise<string> {
    const { id } = await mustCreate(store.create(command, null, { repo: null, executor: null }));
    const claim = (await store.claim('w1', LEASE_SECONDS)) as Claim;
    await store.session(id, claim.leaseToken, randomUUID());
    await store.gates(id, claim.leaseToken, reports);
    await store.complete(id, claim.leaseToken, {
        status: failed ? 'failed' : 'succeeded',
        exitCode: failed ? 1 : 0,
        output: null,
        ...(failed ? { failureKind: 'gate' as const } : {}),
    });
    return id;
}

async function claimFollowUp(parent: string, command: string): Promise<Claim> {
    const followUp = await store.createFollowUp(parent, command, null);
    if (typeof followUp === 'string') throw new Error(`createFollowUp refused: ${followUp}`);
    const claim = (await store.claim('w1', LEASE_SECONDS)) as Claim;
    expect(claim.id).toBe(followUp.id);
    return claim;
}

describe.skipIf(!enabled)('a follow-up after a gate-failed run — database', () => {
    it("delivers each failed gate's name, exit code and output after the person's words", async () => {
        const parent = await finishRun(
            'build it',
            [gate('lint', 'passed', 'lint ok'), gate('test:db', 'failed', 'FAIL fixture missing payload fields', 3)],
            true
        );

        const claim = await claimFollowUp(parent, 'gate failed');

        expect(claim.command.startsWith('gate failed')).toBe(true);
        expect(claim.command).toContain('test:db');
        expect(claim.command).toContain('exit code 3');
        expect(claim.command).toContain('FAIL fixture missing payload fields');
        expect(claim.command).not.toContain('lint ok');
    });

    it('bounds a failed gate output', async () => {
        const long = 'x'.repeat(INTERP_TAIL_LIMIT + 500);
        const parent = await finishRun('build it', [gate('test', 'failed', long)], true);

        const { command } = await claimFollowUp(parent, 'fix tests');

        // An output that names no failure keeps its end, marked where its start was cut.
        const marker = `${TRUNCATION_MARKER.trimStart()}\n`;
        expect(command).toContain(marker + 'x'.repeat(INTERP_TAIL_LIMIT - marker.length));
        expect(command).not.toContain('x'.repeat(INTERP_TAIL_LIMIT - marker.length + 1));
    });

    it('adds nothing when every gate passed', async () => {
        const parent = await finishRun('build it', [gate('test', 'passed', 'all green')], false);

        const { command } = await claimFollowUp(parent, 'tweak the copy');

        expect(command).toBe('tweak the copy');
    });

    it('adds nothing when the run stored no gate report', async () => {
        const { id } = await mustCreate(store.create('build it', null, { repo: null, executor: null }));
        const first = (await store.claim('w1', LEASE_SECONDS)) as Claim;
        await store.session(id, first.leaseToken, randomUUID());
        await store.complete(id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });

        const { command } = await claimFollowUp(id, 'tweak the copy');

        expect(command).toBe('tweak the copy');
    });
});

describe.skipIf(!enabled)('the thread’s last gate reports on the claim — database', () => {
    it('carries the latest passed or failed report per gate, whatever the gate timeout', async () => {
        const parent = await finishRun(
            'build it',
            [
                gate('test', 'failed', 'first run red'),
                gate('lint', 'skipped', null),
                gate('typecheck', 'pending', null),
            ],
            true
        );
        const followUp = await claimFollowUp(parent, 'try again');
        await store.gates(followUp.id, followUp.leaseToken, [gate('test', 'passed', 'second run green', 0)]);
        await store.complete(followUp.id, followUp.leaseToken, { status: 'succeeded', exitCode: 0, output: null });

        const third = await claimFollowUp(followUp.id, 'once more');

        expect(third.lastGateReports).toEqual([
            { name: 'test', status: 'passed', exitCode: 0, output: 'second run green' },
        ]);
    });

    it('is empty for a thread that never stored a report', async () => {
        const { id } = await mustCreate(store.create('fresh', null, { repo: null, executor: null }));
        const first = (await store.claim('w1', LEASE_SECONDS)) as Claim;
        expect(first.id).toBe(id);

        expect(first.lastGateReports).toEqual([]);
    });
});
