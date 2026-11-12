import { ERROR_CODES } from '@factory-ai/core';
import { request } from './request.js';
import type { AuthorRef } from './useJobs.js';

/**
 * What one answer POST settled to. `answered` covers our own 200 and a 409 another member won —
 * either way the question now carries an answer; a 409 does not say when, so `answeredAt` is null
 * until the thread refresh brings it in. `failed` keeps the form open for a retry.
 */
export type AnswerOutcome =
    | { state: 'answered'; answers: Record<string, string>; answeredBy: AuthorRef | null; answeredAt: string | null }
    | { state: 'expired' }
    | { state: 'closed' }
    | { state: 'failed'; error: string };

interface AnsweredBody {
    answers: Record<string, string>;
    answeredBy: AuthorRef | null;
    answeredAt?: string | null;
}

const answered = (body: AnsweredBody): AnswerOutcome => ({
    state: 'answered',
    answers: body.answers,
    answeredBy: body.answeredBy,
    answeredAt: body.answeredAt ?? null,
});

/** `POST /api/jobs/:id/questions/:questionId/answer`, mapped to the state the question now shows. */
export async function postAnswer(
    jobId: string,
    questionId: string,
    answers: Record<string, string>
): Promise<AnswerOutcome> {
    const result = await request<AnsweredBody>(`/api/jobs/${jobId}/questions/${questionId}/answer`, {
        method: 'POST',
        body: { answers },
        verb: 'Could not send your answer',
    });
    if (result.ok) return answered(result.value);
    // The 409 arms need the body's code AND, for an answered one, the winner's answer.
    const body = (result.body ?? {}) as unknown as Partial<AnsweredBody>;
    if (result.code === ERROR_CODES.QUESTION_ANSWERED && body.answers) return answered(body as AnsweredBody);
    if (result.code === ERROR_CODES.QUESTION_EXPIRED) return { state: 'expired' };
    if (result.code === ERROR_CODES.QUESTION_CLOSED) return { state: 'closed' };
    return { state: 'failed', error: result.error };
}
