import type { FailureCause } from './board.js';
import { CONTAINER_GONE } from './exec-codes.js';
import { KILLED_EXIT_CODE } from './k8s-kill.js';
import { TIMEOUT_EXIT_CODE } from './k8s-transport.js';

/**
 * Exits that say the environment ended the gate, not its assertions: the gate's own timeout (124),
 * a SIGKILL from the OOM killer or the platform (137), and a gate that could not be run at all
 * (docker's "container not there", 125). The docker and kubernetes managers report the same codes.
 */
const ENVIRONMENT_EXITS: readonly number[] = [TIMEOUT_EXIT_CODE, KILLED_EXIT_CODE, CONTAINER_GONE];

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colour codes
const ANSI = /\u001b\[[0-9;]*m/g;
const SUMMARY_LINE = /^\s*(Tests|Test Files)\s/;
const PASSED = /\b\d+ passed\b/;
const FAILED = /\b\d+ failed\b/;

/**
 * Whether vitest's summary says every test and file passed — so a non-zero exit came from the
 * runner (worker timeouts, `Errors N`), not an assertion. The summary is the last thing printed,
 * so it survives the tail the board keeps even when the errors above it do not.
 */
function everyTestPassed(output: string): boolean {
    const summary = output
        .replace(ANSI, '')
        .split('\n')
        .filter((line) => SUMMARY_LINE.test(line));
    const tests = summary.find((line) => /^\s*Tests\s/.test(line));
    return tests !== undefined && PASSED.test(tests) && !summary.some((line) => FAILED.test(line));
}

/**
 * The `failure_cause` of a failed declared gate (issue #653). `environment` when the exit or the
 * output shows the environment, not the diff, failed the gate; `verification` otherwise, so a
 * genuine failing assertion is still repaired. Core's `batch-recovery.ts` decides what each
 * cause means; this package depends on nothing, so the signals live here.
 */
export function gateCauseOf(failure: { exitCode: number; output: string }): FailureCause {
    if (ENVIRONMENT_EXITS.includes(failure.exitCode)) return 'environment';
    return everyTestPassed(failure.output) ? 'environment' : 'verification';
}
