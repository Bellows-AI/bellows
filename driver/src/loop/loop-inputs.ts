import type { BoardJob, ReviewClaim } from '../board/board.js';
import { inputDelivery } from '../input-control.js';
import { hasInputs, TASK_DELIVERY } from '../task-inputs.js';
import type { LoopRuntime } from './loop-types.js';

/**
 * Registers the task's input files on the supervisor's control token, read from the board under the task's own lease.
 * Nothing is registered for a claim that carries none, or where the run has no control endpoint.
 */
export function attachTaskInputs(
    ctx: { rt: Pick<LoopRuntime, 'gates' | 'board'>; job: BoardJob },
    token: string
): void {
    const { rt, job } = ctx;
    if (!hasInputs(job)) return;
    rt.gates?.server.attachInputs(
        token,
        TASK_DELIVERY,
        inputDelivery(rt.board, { id: job.id, leaseToken: job.leaseToken }, job.attachments ?? [])
    );
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
