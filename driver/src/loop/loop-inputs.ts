import type { BoardJob, ReviewClaim } from '../board/board.js';
import { inputDelivery, SKILLS_DELIVERY, skillDelivery } from '../input-control.js';
import { hasSkills } from '../skill-inputs.js';
import { hasInputs, TASK_DELIVERY } from '../task-inputs.js';
import type { LoopRuntime } from './loop-types.js';

/**
 * Registers the task's input files and pinned skill bundles on the supervisor's control token, read from the board
 * under the task's own lease. Nothing is registered for a claim that carries none, or where the run has no control endpoint.
 */
export function attachTaskInputs(
    ctx: { rt: Pick<LoopRuntime, 'gates' | 'board'>; job: BoardJob },
    token: string
): void {
    const { rt, job } = ctx;
    const row = { id: job.id, leaseToken: job.leaseToken };
    if (hasInputs(job))
        rt.gates?.server.attachInputs(token, TASK_DELIVERY, inputDelivery(rt.board, row, job.attachments ?? []));
    if (hasSkills(job))
        rt.gates?.server.attachInputs(token, SKILLS_DELIVERY, skillDelivery(rt.board, row, job.skillPin ?? []));
}

/**
 * Registers a review's input files on its CALLER's control token, under the review row's own id and lease:
 * the reviewed row's manifest can differ from the caller's, and the board serves each row only its own.
 */
export function attachReviewInputs(
    ctx: { rt: Pick<LoopRuntime, 'gates' | 'board'>; review: Pick<ReviewClaim, 'id' | 'leaseToken' | 'attachments'> },
    callerToken: string
): void {
    const { rt, review } = ctx;
    if (!hasInputs(review)) return;
    rt.gates?.server.attachInputs(
        callerToken,
        review.id,
        inputDelivery(rt.board, { id: review.id, leaseToken: review.leaseToken }, review.attachments ?? [])
    );
}
