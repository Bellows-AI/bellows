import { describe, expect, it } from 'vitest';
import { gateCauseOf } from '../src/gate-cause.js';
import { causeOf, ledgerOf } from '../src/loop/loop-ledger.js';

const WORKER_TIMEOUT_ERROR = 'Error: [vitest-worker]: Timeout calling "onTaskUpdate" with "[]"';
const passedSummary = (errors: number) =>
    [
        ' Test Files  412 passed (412)',
        '      Tests  5603 passed (5603)',
        `     Errors  ${errors} error${errors === 1 ? '' : 's'}`,
        '   Duration  1204.55s',
    ].join('\n');
/** vitest after two `[vitest-worker]` timeouts: every test passed, the runner still exited 1. */
const WORKER_TIMEOUTS = [WORKER_TIMEOUT_ERROR, WORKER_TIMEOUT_ERROR, passedSummary(2)].join('\n');
/** Every test passed, but the diff's code threw outside a test: the change's fault. */
const UNHANDLED_ERROR = [
    'Unhandled Rejection',
    'TypeError: Cannot read properties of undefined',
    passedSummary(1),
].join('\n');
/** One worker timeout beside an error the diff threw: not only the environment. */
const MIXED_ERRORS = [WORKER_TIMEOUT_ERROR, 'TypeError: Cannot read properties of undefined', passedSummary(2)].join(
    '\n'
);
const COVERAGE_THRESHOLD = [
    ' Test Files  412 passed (412)',
    '      Tests  5603 passed (5603)',
    'ERROR: Coverage for lines (71.2%) does not meet global threshold (80%)',
].join('\n');
/** `npm test && npm run lint`: the suite passed, the lint after it failed. */
const CHAINED_LINT = [' Test Files  412 passed (412)', '      Tests  5603 passed (5603)', 'lint/style/useConst'].join(
    '\n'
);
const FAILING_ASSERTION = [
    ' FAIL  core/test/metrics.test.ts > sums',
    'AssertionError: expected 3 to be 4',
    ' Test Files  1 failed | 411 passed (412)',
    '      Tests  1 failed | 5602 passed (5603)',
].join('\n');
const FILE_FAILED_TO_LOAD = [' Test Files  1 failed | 411 passed (412)', '      Tests  5603 passed (5603)'].join('\n');
/** npm writing a package cache on an NFS volume another client changed under it (issue #789). */
const NPM_STALE_HANDLE = [
    'added 935 packages in 3m',
    'npm error code UNKNOWN',
    'npm error syscall write',
    'npm error errno -116',
    'npm error UNKNOWN: unknown error, write',
].join('\n');
/** A failing test whose name mentions the error code: the name is not the environment. */
const ASSERTION_NAMING_ESTALE = FAILING_ASSERTION.replace('> sums', '> retries on ESTALE');
const ASSERTION_NAMING_THE_PHRASE = FAILING_ASSERTION.replace('> sums', '> reports a stale file handle');

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
        ['npm hitting a stale NFS file handle', 140, NPM_STALE_HANDLE],
        ['the kernel reporting a stale file handle', 1, "cp: cannot stat 'x': Stale file handle"],
        ["node's ESTALE error", 1, "Error: ESTALE: stale file handle, open '/w/.npm/_cacache/x'"],
        [
            'a stale handle under TTY colour',
            1,
            NPM_STALE_HANDLE.replaceAll('npm error', '\u001b[31mnpm error\u001b[39m'),
        ],
    ])('names %s an environment fault', (_name, exitCode, output) => {
        expect(gateCauseOf({ exitCode, output })).toBe('environment');
    });

    it.each([
        ['a failing assertion', 1, FAILING_ASSERTION],
        ['a test file that failed to load', 1, FILE_FAILED_TO_LOAD],
        ['output with no test summary', 1, 'error TS2322: Type string is not assignable to type number'],
        ['a lint failure', 2, 'src/a.ts:1:1 lint/style/useConst'],
        ['an unhandled error with every test passed', 1, UNHANDLED_ERROR],
        ['a worker timeout beside an unhandled error', 1, MIXED_ERRORS],
        ['a coverage threshold miss with every test passed', 1, COVERAGE_THRESHOLD],
        ['a command chained after a passing suite', 1, CHAINED_LINT],
        ['a failing test whose name mentions ESTALE', 1, ASSERTION_NAMING_ESTALE],
        ["a failing test whose name carries the kernel's phrase", 1, ASSERTION_NAMING_THE_PHRASE],
        ['an errno that only starts with -116', 1, 'npm error errno -1160'],
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
