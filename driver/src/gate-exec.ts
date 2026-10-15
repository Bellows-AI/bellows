import { gateExecArgs } from './docker.js';
import { CONTAINER_GONE } from './exec-codes.js';
import type { GateRun } from './gates.js';
import { reportTail } from './runner.js';

/** execFile's own code when a child's output outgrew `maxBuffer` — the child is killed. */
const STDIO_MAXBUFFER_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
/** A passing suite can be verbose; execFile's 1 MiB default is far below what one prints. */
const GATE_OUTPUT_MAX_BUFFER_BYTES = 268_435_456;
/** What a gate whose output outgrew the buffer reports: a verdict, not a missing container. */
const OUTPUT_OVERFLOW_EXIT_CODE = 1;

export type ExecDocker = (
    args: string[],
    options?: { timeout?: number; maxBuffer?: number; signal?: AbortSignal }
) => Promise<{ stdout: string; stderr: string }>;

interface DockerExecError {
    killed?: boolean;
    code?: number | string;
    stdout?: string;
    stderr?: string;
    message?: string;
}

/**
 * Turns a failed `docker exec` into either a gate verdict (timeout, or the command's own exit
 * code) or a rejection carrying CONTAINER_GONE — the harness-vs-verdict split `runGate` and the
 * ad-hoc endpoint both key on.
 */
function gateRunFromExecError(error: DockerExecError, gateTimeoutMs: number): GateRun {
    const output = reportTail(`${error.stdout ?? ''}${error.stderr ?? ''}`.trim());
    // The timeout kill: a genuine gate failure, reported as one — exit 124, the convention
    // `timeout` itself uses — with the reason in the tail.
    if (error.killed) {
        return { exitCode: 124, output: output || `[driver] gate killed after ${gateTimeoutMs}ms` };
    }
    // The output outgrew the buffer and execFile killed the client: the gate's own verdict,
    // never "the container is gone".
    if (error.code === STDIO_MAXBUFFER_CODE) {
        return {
            exitCode: OUTPUT_OVERFLOW_EXIT_CODE,
            output: output || `[driver] gate output exceeded ${GATE_OUTPUT_MAX_BUFFER_BYTES} bytes`,
        };
    }
    // Docker itself failed — the container is not there. A harness state, not a verdict: it
    // REJECTS with the code, which is what the ad-hoc endpoint's 409 and the loop's failed-gate
    // path both key on.
    if (error.code === CONTAINER_GONE) {
        throw Object.assign(new Error(output || error.message || 'gate environment is gone'), {
            code: CONTAINER_GONE,
        });
    }
    // Not an exit status — docker never ran (ENOENT, EACCES). A harness state like the branch
    // above: rejected with the code, never returned as an exit that did not happen.
    if (typeof error.code !== 'number') {
        throw Object.assign(new Error(output || error.message || 'docker could not be run'), {
            code: CONTAINER_GONE,
        });
    }
    return { exitCode: error.code, output: output || error.message || `exit ${error.code}` };
}

/**
 * One `docker exec` of a script, answered as a gate verdict — or as a rejection carrying
 * CONTAINER_GONE when docker itself could not run it. The docker gate manager's transport.
 */
export async function execInContainer({
    execDocker,
    name,
    script,
    gateTimeoutMs,
    onKilled,
}: {
    execDocker: ExecDocker;
    name: string;
    script: string;
    gateTimeoutMs: number;
    /** Called when the exec client was killed (timeout, output overflow) — the script lives on. */
    onKilled: () => void;
}): Promise<GateRun> {
    try {
        const read = await execDocker(gateExecArgs(name, script), {
            timeout: gateTimeoutMs,
            maxBuffer: GATE_OUTPUT_MAX_BUFFER_BYTES,
        });
        return { exitCode: 0, output: reportTail(read.stdout.trim()) };
    } catch (e) {
        const error = e as DockerExecError;
        // The kill took the `docker exec` client only: the gate's process lives on in the warm
        // container, so the environment goes, as it does for a cancel.
        if (error.killed || error.code === STDIO_MAXBUFFER_CODE) onKilled();
        return gateRunFromExecError(error, gateTimeoutMs);
    }
}
