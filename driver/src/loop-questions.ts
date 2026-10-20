import type { AskedQuestion, BoardJob } from './board.js';
import { withBoardRetry } from './board-retry.js';
import { applyHeartbeatVerdict, down, updateQuestionDeadline } from './loop-attempt.js';
import type { JobState } from './loop-attempt.js';
import type { LoopRuntime } from './loop-types.js';
import type { QuestionRelay } from './question-control.js';

/** The relay one attempt's control token reports its questions through. */
export function createQuestionRelay(rt: LoopRuntime, job: BoardJob, state: JobState): QuestionRelay {
    return {
        async ask(questionId: string, questions: AskedQuestion[]) {
            state.pendingQuestions.add(questionId);
            const verdict = await withBoardRetry(rt, `job ${job.id}: the question was not accepted`, () =>
                rt.board.question(job, questionId, questions)
            ).catch(async (error: unknown) => {
                state.pendingQuestions.delete(questionId);
                await updateQuestionDeadline(rt, job, state);
                throw error;
            });
            if (verdict === 'refused') {
                state.pendingQuestions.delete(questionId);
                await updateQuestionDeadline(rt, job, state);
                return 'refused';
            }
            if (verdict === 'lost' || verdict === 'removed') {
                await applyHeartbeatVerdict(rt, job, state, verdict);
                return 'gone';
            }
            // A Stop or the end of the run landed during the board call and already cleaned up:
            // nothing is waiting, so the runtime budget stays unchanged.
            if (state.phase === 'ended' || state.draining || down(state)) return 'accepted';
            await updateQuestionDeadline(rt, job, state);
            return 'accepted';
        },
    };
}
