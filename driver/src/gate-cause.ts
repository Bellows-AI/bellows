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
const ERRORS = /^\s*Errors\s+(\d+) errors?\b/;
const WORKER_TIMEOUT = /\[vitest-worker\]: Timeout calling/g;

/**
 * Whether vitest's summary says every test and file passed, and every error it counted is its own
 * worker timing out under load (`[vitest-worker]: Timeout calling …`). Any other non-zero exit with
 * every test passed — an unhandled error the diff throws, a coverage threshold, a command chained
 * after the suite — is the change's, so it stays `verification`.
 */
function onlyWorkerTimeouts(output: string): boolean {
    const lines = output.replace(ANSI, '').split('\n');
    const summary = lines.filter((line) => SUMMARY_LINE.test(line));
    const tests = summary.find((line) => /^\s*Tests\s/.test(line));
    if (tests === undefined || !PASSED.test(tests) || summary.some((line) => FAILED.test(line))) return false;
    const errors = lines.map((line) => ERRORS.exec(line)).find((match) => match !== null);
    if (!errors) return false;
    return (output.match(WORKER_TIMEOUT)?.length ?? 0) >= Number(errors[1]);
}

/**
 * The `failure_cause` of a failed declared gate (issue #653). `environment` when the exit or the
 * output shows the environment, not the diff, failed the gate; `verification` otherwise, so a
 * genuine failing assertion is still repaired. Core's `batch-recovery.ts` decides what each
 * cause means; this package depends on nothing, so the signals live here.
 */
export function gateCauseOf(failure: { exitCode: number; output: string }): FailureCause {
    if (ENVIRONMENT_EXITS.includes(failure.exitCode)) return 'environment';
    return onlyWorkerTimeouts(failure.output) ? 'environment' : 'verification';
}
