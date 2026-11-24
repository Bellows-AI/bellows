import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { loadDriverConfig } from '../src/config.js';
import { createSupervisedGateManager } from '../src/gate-manager.js';
import { ARTIFACT_LIMIT, REPORT_BYTE_LIMIT } from '../src/runner.js';
import type { StepResult } from '../src/supervisor-contract.js';

const KEY = '55555555-5555-4555-8555-555555555555/factory';
const JOB = {
    id: '55555555-5555-4555-8555-555555555555',
    leaseToken: '22222222-2222-4222-8222-222222222222',
} as BoardJob;
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** The real manager over a runner that answers one scripted step. */
async function runWith(step: Partial<StepResult>) {
    const manager = createSupervisedGateManager({
        config: loadDriverConfig({}),
        runner: { runGate: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, ...step }) },
    });
    await manager.acquire(KEY, 'node:24', '', { job: JOB });
    return manager.runGate(KEY, 'test', 'npm test');
}

describe("the gate manager keeps a run's whole output", () => {
    const failures = ' FAIL  web/test/a.test.ts > case\n × case\n';
    const stacks = 'Error: Timeout calling "onTaskUpdate"\n    at frame\n'.repeat(2000);
    const summary = ' Test Files  1 failed | 9 passed (10)\n';

    it('answers a failed run with its failure lines first and carries the whole log beside them', async () => {
        const stdout = `${failures}${stacks}${summary}`;
        const run = await runWith({ exitCode: 1, stdout });

        expect(bytes(run.output)).toBeLessThanOrEqual(REPORT_BYTE_LIMIT);
        expect(run.output).toContain('FAIL  web/test/a.test.ts');
        expect(run.output).toContain('Test Files  1 failed');
        expect(run.fullOutput).toBe(stdout.trim());
        expect(run.fullTruncated).toBeUndefined();
    });

    it('tail-keeps the whole log at the artifact limit and says the head is gone', async () => {
        const run = await runWith({ exitCode: 1, stdout: `${failures}${'x'.repeat(ARTIFACT_LIMIT * 2)}tail` });

        expect(bytes(run.fullOutput ?? '')).toBeLessThanOrEqual(ARTIFACT_LIMIT);
        expect(run.fullOutput?.endsWith('tail')).toBe(true);
        expect(run.fullTruncated).toBe(true);
    });

    it('keeps the plain tail of a passed run and of a timed-out one without failure lines', async () => {
        const passed = await runWith({ stdout: `${'noise\n'.repeat(5000)}done` });
        expect(passed.output.endsWith('done')).toBe(true);
        const timedOut = await runWith({ exitCode: null, stdout: '', timedOut: true });
        expect(timedOut.exitCode).toBe(124);
        expect(timedOut.output).toContain('gate killed after');
    });
});
