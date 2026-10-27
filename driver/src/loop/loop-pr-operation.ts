import type { BoardJob } from '../board/board.js';
import type { PrOperationRecorder } from '../publish/publish-pr.js';
import type { LoopRuntime } from './loop-types.js';

/**
 * The recorder the loop hands every managed publish (issue #983): each PR operation goes to the board
 * under the attempt's lease as the publish performs it. Best effort, decided on purpose: the PR is
 * already open (or found) when this runs, and failing the publish or repeating it would open a second
 * one, so a write the board did not take only leaves the operation unrecorded, and says so here.
 */
export function prOperationRecorder(rt: LoopRuntime, job: BoardJob): PrOperationRecorder {
    return async (note) => {
        const answer = await rt.board.prOperation(job, note).catch(() => 'rejected' as const);
        if (answer !== 'ok') {
            rt.log(`job ${job.id}: the PR operation ${note.operation} of ${note.prUrl} is unrecorded (${answer})`);
        }
    };
}
