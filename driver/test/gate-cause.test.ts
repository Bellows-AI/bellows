import { describe, expect, it } from 'vitest';
import { gateCauseOf } from '../src/gate-cause.js';
import { causeOf, ledgerOf } from '../src/loop-ledger.js';

/** vitest's tail after 80 `[vitest-worker]` timeouts: every test passed, the runner still exited 1. */
const WORKER_TIMEOUTS = [
    ' Test Files  412 passed (412)',
    '      Tests  5603 passed (5603)',
    '     Errors  80 errors',
    '   Duration  1204.55s',
].join('\n');
const FAILING_ASSERTION = [
    ' FAIL  core/test/metrics.test.ts > sums',
    'AssertionError: expected 3 to be 4',
    ' Test Files  1 failed | 411 passed (412)',
    '      Tests  1 failed | 5602 passed (5603)',
].join('\n');
const FILE_FAILED_TO_LOAD = [' Test Files  1 failed | 411 passed (412)', '      Tests  5603 passed (5603)'].join('\n');

/** The exits both gate managers report: the docker manager's execFile kill and the kubernetes deadline. */
const GATE_TIMEOUT_EXIT = 124;
const GATE_KILLED_EXIT = 137;
const GATE_CONTAINER_GONE_EXIT = 125;

describe('gateCauseOf (issue #653)', () => {
    it.each([
        ['worker timeouts with every test passed', 1, WORKER_TIMEOUTS],
        ['the same, coloured by a TTY', 1, WORKER_TIMEOUTS.replaceAll('passed', '\u001b[32mpassed\u001b[39m')],
        ['the gate timing out', GATE_TIMEOUT_EXIT, '[driver] gate killed after 1800000ms'],
        ['an OOM or throttle kill', GATE_KILLED_EXIT, FAILING_ASSERTION],
        ['an environment that could not run the gate', GATE_CONTAINER_GONE_EXIT, 'no such container'],
    ])('names %s an environment fault', (_name, exitCode, output) => {
        expect(gateCauseOf({ exitCode, output })).toBe('environment');
    });

    it.each([
        ['a failing assertion', 1, FAILING_ASSERTION],
        ['a test file that failed to load', 1, FILE_FAILED_TO_LOAD],
        ['output with no test summary', 1, 'error TS2322: Type string is not assignable to type number'],
        ['a lint failure', 2, 'src/a.ts:1:1 lint/style/useConst'],
    ])('keeps %s a verification failure', (_name, exitCode, output) => {
        expect(gateCauseOf({ exitCode, output })).toBe('verification');
    });

    it('reaches the verdict through the ledger the same way for either executor', () => {
        const gate = (exitCode: number, output: string) =>
            causeOf(
                ledgerOf({
                    outcome: { exitCode: 0, output: '', timedOut: false, started: true },
                    failure: { name: 'tests', exitCode, output },
                    deadServices: [],
                    helperFailure: null,
                    published: null,
                })
            );
        expect(gate(1, WORKER_TIMEOUTS)).toBe('environment');
        expect(gate(1, FAILING_ASSERTION)).toBe('verification');
    });
});
