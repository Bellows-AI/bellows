import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { loadDriverConfig } from '../src/config.js';
import { createSupervisedGateManager } from '../src/gate-manager.js';
import type { StepResult } from '../src/supervisor-contract.js';
import { captureSpans } from './fixtures/lifecycle-spans.js';

/**
 * One gate run as telemetry: a `gate.run` span naming the gate with the structured result as attributes, and the
 * observer (`DriverMetrics.gate`) told the gate, how it ended, how long it took and the guest's resources. Both
 * executors share the manager, so this is the parity pin.
 */
const KEY = '55555555-5555-4555-8555-555555555555/factory';
const JOB = {
    id: '55555555-5555-4555-8555-555555555555',
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
} as BoardJob;
const SAMPLES =
    't=100 cpu=100,0,100,700,50,0,0,50 load=0.5 mem=3000000/4096000 throttled=2,1000\n' +
    't=110 cpu=200,0,200,800,100,0,0,100 load=2.5 mem=1000000/4096000 throttled=5,4000\n';

const spans = captureSpans();

const run = async (answer: Partial<StepResult>, observed: unknown[][]) => {
    const manager = createSupervisedGateManager({
        config: loadDriverConfig({}),
        runner: { runGate: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, ...answer }) },
        observe: (...args) => observed.push(args),
    });
    await manager.acquire(KEY, 'node:24', '', { job: JOB });
    return manager.runGate(KEY, 'test', 'npm test');
};

describe('gate telemetry', () => {
    it('opens a gate.run span with the structured result and tells the observer the resources', async () => {
        const observed: unknown[][] = [];
        await run(
            {
                exitCode: 1,
                report: {
                    sections: {
                        tests: {
                            failures: [{ file: 'a.test.ts', test: 'adds', message: 'boom' }],
                            files: [{ file: 'a.test.ts', ms: 900 }],
                        },
                        selection: { mode: 'all', reason: 'a shared file changed' },
                    },
                    resources: SAMPLES,
                },
            },
            observed
        );

        const [span] = spans.getFinishedSpans().filter((s) => s.name === 'gate.run');
        expect(span?.attributes).toMatchObject({
            'bellows.gate.name': 'test',
            'bellows.gate.outcome': 'failed',
            'bellows.gate.exit_code': 1,
            'bellows.gate.failed_tests': 1,
            'bellows.gate.selection.mode': 'all',
            'bellows.gate.slowest.ms': 900,
            'bellows.gate.cpu.user_pct': 25,
            'bellows.gate.cpu.iowait_pct': 12.5,
            'bellows.gate.cpu.steal_pct': 12.5,
            'bellows.gate.throttled_ms': 3,
            'bellows.gate.load.max': 2.5,
            'bellows.gate.memory.available_min_mb': 977,
        });
        expect(observed).toHaveLength(1);
        expect(observed[0]?.slice(0, 2)).toEqual(['test', 'failed']);
        expect((observed[0]?.[3] as { samples: number } | undefined)?.samples).toBe(2);
    });

    it('labels a gate killed at its deadline timeout, and a passing one with no report records only its duration', async () => {
        const observed: unknown[][] = [];
        await run({ exitCode: null, timedOut: true }, observed);
        await run({}, observed);
        expect(observed.map((o) => o.slice(0, 2))).toEqual([
            ['test', 'timeout'],
            ['test', 'passed'],
        ]);
        expect(observed[1]?.[3]).toBeUndefined();
    });
});
