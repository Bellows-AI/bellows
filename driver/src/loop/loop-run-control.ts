import { randomUUID } from 'node:crypto';
import type { BoardJob } from '../board/board.js';
import { SUPERVISOR_ENV } from '../supervisor-contract.js';
import { takeoverBoundMs } from '../supervisor-plan.js';
import { clearPendingQuestions } from './loop-attempt.js';
import type { JobState } from './loop-attempt.js';
import { attachConnection } from './loop-connection.js';
import { attachCheckpoint, attachTranscriptExport } from './loop-export.js';
import { createGateTokenRelay } from './loop-github.js';
import { declaresGates } from './loop-gates.js';
import { createPublishRelay } from './loop-publish.js';
import { createQuestionRelay } from './loop-questions.js';
import { createReviewRelay } from './loop-review.js';
import type { LoopRuntime } from './loop-types.js';

/**
 * Opens the run-control channel for one attempt about to launch, gated or not: three
 * tokens scoped to this lease. The supervisor's goes to the task supervisor alone
 * (`job.supervisorEnv`) so it can read a Stop the board raised, relay the agent's questions and run
 * the supervised steps; the exporter's and the agent's, beside it in `job.supervisorEnv`, open only
 * the transcript export and only the publish and review routes. Neither leaves the supervisor: it
 * relays the agent's and the exporter's requests, attaching the role's token. Best-effort — a driver whose endpoint cannot bind keeps today's immediate-kill
 * Stop, said out loud, instead of refusing every job over a feature.
 */
export async function openRunControl(rt: LoopRuntime, job: BoardJob, state: JobState): Promise<void> {
    const { gates } = rt;
    if (!gates) return;
    try {
        const port = await gates.server.listen();
        // Three tokens of one lease: the supervisor's (stop, kill, questions, steps) never leaves
        // the supervisor; the exporter's opens only the transcript export; the agent's only publish
        // and review.
        const token = randomUUID();
        const agentToken = randomUUID();
        const exporterToken = randomUUID();
        gates.server.openControl(
            token,
            createQuestionRelay(rt, job, state),
            createPublishRelay(rt, job, state),
            createReviewRelay(rt, job, state)
        );
        attachConnection({ rt, job, state }, token);
        gates.server.attachGateToken(token, createGateTokenRelay(rt, job, state));
        // A job with no gate to ask for answers its agent's `POST /gate/run` "no gates"; a gated one 503s until `beginGates`.
        if (!declaresGates(job)) gates.server.attachGateRun(token, null);
        gates.server.grantAgent(token, agentToken);
        gates.server.grantExporter(token, exporterToken);
        attachTranscriptExport({ rt, job, state }, token);
        attachCheckpoint({ rt, job }, token);
        const url = gates.advertiseUrl(port);
        job.supervisorEnv = {
            [SUPERVISOR_ENV.controlUrl]: url,
            [SUPERVISOR_ENV.controlToken]: token,
            [SUPERVISOR_ENV.agentToken]: agentToken,
            [SUPERVISOR_ENV.exportToken]: exporterToken,
        };
        state.control = token;
    } catch (e) {
        rt.log(
            `job ${job.id}: could not open the run-control endpoint, a Stop will kill at once: ${(e as Error).message}`
        );
    }
}

/**
 * Closes the attempt's control token, if one was opened: the token's questions go with it and the
 * bridge gets 401 from here on.
 */
export function closeRunControl(rt: LoopRuntime, state: JobState): void {
    clearPendingQuestions(state);
    if (state.control === null) return;
    rt.gates?.server.closeControl(state.control);
    // Closed once: `end` (`loop-conclusion.ts`) closes it after the group's `finish`.
    state.control = null;
}

/**
 * Leaves the attempt's control token to a newer holder: its group is retained, so the token
 * is hung up on — never answered 401, which the group's supervisor reads as the end of its attempt —
 * until the group's takeover bound passes and the holder it waits for has named itself.
 */
export function departRunControl(rt: LoopRuntime, state: JobState): void {
    clearPendingQuestions(state);
    if (state.control === null) return;
    rt.gates?.server.departControl(state.control, takeoverBoundMs(rt.config));
    state.control = null;
}
