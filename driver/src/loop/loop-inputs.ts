import type { BoardJob } from '../board/board.js';
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
