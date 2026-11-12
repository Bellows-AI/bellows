import type { BoardJob } from '../board/board.js';
import {
    REVIEWER_LOG_TAIL_LINES,
    type ReviewRun,
    reviewerReadSignal,
    reviewerStateNote,
    reviewIsLost,
    runReviewSteps,
    withReviewerNote,
} from '../review/review-step.js';
import { type GateStepRequest, runGateStep, type StepHost } from '../supervised-steps.js';
import type { StepResult } from '../supervisor-contract.js';
import { reviewerName } from './docker-group.js';
import type { ExecDocker } from './docker-runner-support.js';

/** What a docker gate run needs of its runner: the attempt's step host, its group made on demand. */
export interface DockerGateDeps {
    /** The attempt's step host, its group made on demand for an attempt whose sync made none. */
    host: () => Promise<StepHost>;
    /** The attempt's docker CLI: how a lost review's reviewer container is read. */
    execDocker: ExecDocker;
}

/**
 * One gate in the attempt's group: its gate container runs it, in the network
 * namespace of the group's supervisor, so it reaches the declared services by name on loopback the
 * way the agent does.
 */
export async function runDockerGate(
    deps: DockerGateDeps,
    job: BoardJob,
    gate: GateStepRequest,
    signal?: AbortSignal
): Promise<StepResult> {
    return runGateStep(await deps.host(), job, gate, signal);
}

/** One review in the caller's group: its reviewer container runs it, beside the gate container, in the same namespace. */
export async function runDockerReview(deps: DockerGateDeps, run: ReviewRun, signal?: AbortSignal): Promise<StepResult> {
    const result = await runReviewSteps(await deps.host(), run, signal);
    if (!reviewIsLost(result, signal)) return result;
    return withReviewerNote(result, await readReviewer(deps.execDocker, run, signal));
}

/** `docker inspect`'s `.State` as text: "exited 2", with the OOM kill named; a reason when it is not readable. */
function dockerStateOf(stdout: string): { state: string } | { why: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return { why: 'inspect answered no JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null) return { why: 'inspect answered no state' };
    const state = parsed as { Status?: unknown; ExitCode?: unknown; OOMKilled?: unknown };
    if (typeof state.Status !== 'string') return { why: 'inspect named no status' };
    const exited = state.Status === 'running' ? '' : typeof state.ExitCode === 'number' ? ` ${state.ExitCode}` : '';
    if (state.Status !== 'running' && exited === '') return { why: 'inspect named no exit code' };
    return { state: `${state.Status}${exited}${state.OOMKilled === true ? ' (OOMKilled)' : ''}` };
}

/**
 * The reviewer container's state and last log lines, under one 5 s bound. Evidence only: a read
 * that fails, times out or answers nothing is "state unknown" / "logs unavailable", and neither
 * read changes the review's outcome.
 */
async function readReviewer(execDocker: ExecDocker, run: ReviewRun, signal?: AbortSignal): Promise<string> {
    const bound = reviewerReadSignal(signal);
    const name = reviewerName(run.caller);
    let state: string | null = null;
    let why = 'unreadable';
    try {
        const read = dockerStateOf(
            (await execDocker(['inspect', '--format', '{{json .State}}', name], { signal: bound })).stdout
        );
        if ('state' in read) state = read.state;
        else why = read.why;
    } catch (e) {
        why = (e as Error).message;
    }
    let tail: string[] | null = null;
    try {
        const read = await execDocker(['logs', '--tail', String(REVIEWER_LOG_TAIL_LINES), name], { signal: bound });
        tail = `${read.stdout}\n${read.stderr ?? ''}`.split('\n');
    } catch {
        // logs unavailable
    }
    return reviewerStateNote({ state, why, tail });
}
