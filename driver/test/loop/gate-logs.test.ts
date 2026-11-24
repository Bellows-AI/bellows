import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { ARTIFACT_LIMIT } from '../../src/runner.js';
import { drive, gatedJob, ok, stubBoard, stubGateStack, stubRunner } from '../fixtures/loop-stubs.js';

const REPORT_BUDGET = 16384;
const bytes = (text: string | null): number => Buffer.byteLength(text ?? '', 'utf8');

/** A vitest log: the failure list first, then RPC-timeout stacks that push it out of any tail, then the summary. */
const suiteLog = (files: string[]): string =>
    [
        ...files.map((file) => ` FAIL  ${file} > suite > case`),
        ...files.map(() => ' × case 12ms'),
        ...Array.from(
            { length: 19 },
            (_, i) => `Error: Timeout calling "onTaskUpdate" ${i}\n${'    at frame (node:internal/x:1:1)\n'.repeat(60)}`
        ),
        ` Test Files  ${files.length} failed | 677 passed (717)`,
        '      Tests  4 failed | 9000 passed',
    ].join('\n');

/** The report entry's recorded run: the board's wire type does not name it, the driver sends it. */
const executionIdOf = (entry: object): string => (entry as { executionId: string }).executionId;

const FILES = ['web/test/a.test.ts', 'core/test/b.test.ts', 'server/test/c.test.ts'];

const jobWith = (names: string[]): BoardJob => ({
    ...gatedJob(1),
    gates: { image: 'node:24', gates: names.map((name) => ({ name, command: `run ${name}` })) },
});

// The gate's whole output is a log stream of the run, its stored excerpt names what failed, and the report stays bounded:
// the driver's loop is the same under both executors, so each is driven through it.
describe.each(['docker', 'kubernetes'])('a gate run keeps its whole output (%s executor)', (executor) => {
    it('stores the full log as a stream and a failure-first excerpt in the report', async () => {
        const log = suiteLog(FILES);
        expect(bytes(log)).toBeGreaterThan(REPORT_BUDGET);
        const board = stubBoard([jobWith(['test', 'lint'])]);
        const stack = stubGateStack({ test: 1 }, { fullOutputs: { test: log } });

        await drive({ ...board, runner: stubRunner(async () => ok()), gates: stack.gates }, { EXECUTOR: executor });

        const reported = board.board.gatesReported.at(-1)!.results.find((gate) => gate.name === 'test')!;
        expect(reported.status).toBe('failed');
        for (const file of FILES) expect(reported.output).toContain(file);
        expect(reported.output).toContain('Test Files  3 failed | 677 passed (717)');
        expect(bytes(reported.output)).toBeLessThanOrEqual(REPORT_BUDGET);

        const stream = `gate-test-${executionIdOf(reported)}`;
        const stored = board.board.artifactChunks.filter((chunk) => chunk.stream === stream);
        expect(stored.map((chunk) => chunk.text).join('')).toBe(log);
        expect(board.board.artifactManifests).toContainEqual(expect.objectContaining({ stream, state: 'complete' }));
    });

    it('names every failing file in the report when stacks past the artifact limit follow the failure list', async () => {
        const noise = 'Error: Timeout calling "onTaskUpdate"\n    at frame (node:internal/x:1:1)\n'.repeat(12_000);
        const log = suiteLog(FILES).replace(/Error: Timeout[\s\S]*(?= Test Files)/, noise);
        expect(bytes(noise)).toBeGreaterThan(ARTIFACT_LIMIT);
        const board = stubBoard([jobWith(['test'])]);
        const stack = stubGateStack({ test: 1 }, { fullOutputs: { test: log } });

        await drive({ ...board, runner: stubRunner(async () => ok()), gates: stack.gates }, { EXECUTOR: executor });

        const reported = board.board.gatesReported.at(-1)!.results[0]!;
        for (const file of FILES) expect(reported.output).toContain(file);
        const stored = board.board.artifactChunks.map((chunk) => chunk.text).join('');
        expect(bytes(stored)).toBeLessThanOrEqual(ARTIFACT_LIMIT);
        expect(stored).not.toContain(FILES[0]);
    });

    it('reads a stored run back by its execution id, as `factory-gate --last --full` does', async () => {
        const log = suiteLog(FILES);
        const board = stubBoard([jobWith(['test'])]);
        const stack = stubGateStack({ test: 1 }, { fullOutputs: { test: log } });

        await drive({ ...board, runner: stubRunner(async () => ok()), gates: stack.gates }, { EXECUTOR: executor });

        const executionId = executionIdOf(board.board.gatesReported.at(-1)!.results[0]!);
        const claim = stack.stack.claims[0]!;
        await expect(claim.readGateLog!(executionId, new AbortController().signal)).resolves.toEqual({
            text: log,
            truncated: false,
            cause: null,
        });
    });

    it('keeps the report inside its body budget with 16 verbose gates, the failed one getting the larger share', async () => {
        const names = Array.from({ length: 16 }, (_, i) => `gate-${i}`);
        const board = stubBoard([jobWith(names)]);
        const stack = stubGateStack({ 'gate-9': 1 }, { fullOutputs: { 'gate-9': suiteLog(FILES) } });

        await drive({ ...board, runner: stubRunner(async () => ok()), gates: stack.gates }, { EXECUTOR: executor });

        const results = board.board.gatesReported.at(-1)!.results;
        const total = results.reduce((n, gate) => n + bytes(gate.output), 0);
        expect(total).toBeLessThanOrEqual(REPORT_BUDGET);
        const failed = results.find((gate) => gate.status === 'failed')!;
        const passed = results.find((gate) => gate.status === 'passed')!;
        expect(bytes(failed.output)).toBeGreaterThan(bytes(passed.output) * 4);
        for (const file of FILES) expect(failed.output).toContain(file);
    });
});

describe('gate stream names', () => {
    it('fold a gate name to key-segment characters and end in the execution id', async () => {
        const { gateStreamName } = await import('../../src/artifact-upload.js');
        const id = '77777777-7777-4777-8777-777777777777';
        expect(gateStreamName('test:db / slow', id)).toBe(`gate-test_db___slow-${id}`);
        expect(gateStreamName('x'.repeat(200), id)).toMatch(/^gate-x{64}-7777/);
        expect(gateStreamName('lint', id)).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
    });
});
