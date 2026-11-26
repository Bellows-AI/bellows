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

    it('names every failing file when more than the artifact limit of stacks follows the failure list', async () => {
        const files = ['web/test/a.test.ts', 'core/test/b.test.ts', 'server/test/c.test.ts'];
        const list = files.map((file) => ` FAIL  ${file} > suite > case\n × case 12ms\n`).join('');
        const noise = 'Error: Timeout calling "onTaskUpdate"\n    at frame (node:internal/x:1:1)\n'.repeat(12_000);
        expect(bytes(noise)).toBeGreaterThan(ARTIFACT_LIMIT);
        const run = await runWith({ exitCode: 1, stdout: `${list}${noise}${summary}` });

        // The stored log keeps its tail, so the names are gone from it; the answer's excerpt was taken before the cut.
        expect(run.fullOutput).not.toContain(files[0]);
        for (const file of files) expect(run.output).toContain(file);
        expect(run.output).toContain('Test Files  1 failed');
        expect(bytes(run.output)).toBeLessThanOrEqual(REPORT_BYTE_LIMIT);
    });

    it('builds the excerpt from the lines the supervisor read off a file its own cut already shortened', async () => {
        const files = ['web/test/a.test.ts', 'core/test/b.test.ts'];
        const failureLines = [
            ...files.map((file) => ` FAIL  ${file} > case`),
            ' Test Files  2 failed | 9 passed (11)',
        ].join('\n');
        // What the answer's tail holds once more than the step cap of stacks followed the list.
        const run = await runWith({ exitCode: 1, stdout: stacks.repeat(20), failureLines });

        for (const file of files) expect(run.output).toContain(file);
        expect(run.output).toContain('Test Files  2 failed');
        expect(bytes(run.output)).toBeLessThanOrEqual(REPORT_BYTE_LIMIT);
    });

    it("reads the supervisor's own cut as a cut log, whatever the size of what is left", async () => {
        const cut = await runWith({ exitCode: 0, stdout: 'a short tail', outputCut: true });
        expect(cut.fullOutput).toBe('a short tail');
        expect(cut.fullTruncated).toBe(true);
        const whole = await runWith({ exitCode: 0, stdout: 'a short tail' });
        expect(whole.fullTruncated).toBeUndefined();
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
        expect(timedOut.timedOut).toBe(true);
        expect(timedOut.output).toContain('gate killed after');
        expect(passed).not.toHaveProperty('timedOut');
    });
});
