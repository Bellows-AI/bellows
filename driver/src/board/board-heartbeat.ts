import type { AnsweredQuestion, HeartbeatVerdict } from './board.js';

/** A heartbeat the board held: the stop flag, every question of the lease the board has an answer for, and a requirement wait. */
export async function heldBeat(response: Response): Promise<HeartbeatVerdict> {
    const body = (await response.json()) as {
        cancelRequested?: boolean;
        answeredQuestions?: unknown;
        requirementWait?: unknown;
    };
    const answered = Array.isArray(body.answeredQuestions) ? (body.answeredQuestions as AnsweredQuestion[]) : [];
    return {
        result: 'held',
        cancelRequested: body.cancelRequested === true,
        answeredQuestions: answered,
        ...(body.requirementWait === true ? { requirementWait: true } : {}),
    };
}
