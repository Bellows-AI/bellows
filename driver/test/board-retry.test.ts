import { describe, expect, it } from 'vitest';
import { BOARD_CALL_ATTEMPTS, BoardHttpError, withBoardRetry } from '../src/board-retry.js';

/** A recording io: every log line and every backoff the retry slept. */
function io() {
    const logs: string[] = [];
    const slept: number[] = [];
    return {
        logs,
        slept,
        io: { log: (m: string) => logs.push(m), sleep: async (ms: number) => void slept.push(ms) },
    };
}

/** A call that always throws `error`, counting how often it was made. */
function failing(error: Error) {
    let calls = 0;
    return {
        calls: () => calls,
        call: async (): Promise<never> => {
            calls += 1;
            throw error;
        },
    };
}

describe('withBoardRetry: what is retried', () => {
    it.each([400, 401, 403, 404, 413, 422])('sends a deterministic %i once and throws it', async (status) => {
        const { io: rec, logs } = io();
        const call = failing(new BoardHttpError(status, `/api/jobs/x/complete answered ${status}: no`));

        await expect(withBoardRetry(rec, 'job x: the verdict was not accepted', call.call)).rejects.toBeInstanceOf(
            BoardHttpError
        );

        expect(call.calls()).toBe(1);
        expect(logs).toEqual([
            `job x: the verdict was not accepted, not retried: /api/jobs/x/complete answered ${status}: no`,
        ]);
    });

    it.each([408, 425, 429, 500, 502, 503])('retries a transient %i up to the attempt bound', async (status) => {
        const { io: rec } = io();
        const call = failing(new BoardHttpError(status, `answered ${status}`));

        await expect(withBoardRetry(rec, 'x', call.call)).rejects.toThrow(`answered ${status}`);

        expect(call.calls()).toBe(BOARD_CALL_ATTEMPTS);
    });

    it('retries a transport failure that carries no status', async () => {
        const { io: rec } = io();
        const call = failing(new TypeError('fetch failed'));

        await expect(withBoardRetry(rec, 'x', call.call)).rejects.toThrow('fetch failed');

        expect(call.calls()).toBe(BOARD_CALL_ATTEMPTS);
    });
});

describe('withBoardRetry: a backoff budget', () => {
    it('keeps retrying until the summed backoff would pass the budget, with each backoff capped', async () => {
        const { io: rec, slept } = io();
        const call = failing(new BoardHttpError(503, 'answered 503'));

        await expect(withBoardRetry(rec, 'x', call.call, { budgetMs: 300_000 })).rejects.toThrow('answered 503');

        const total = slept.reduce((sum, ms) => sum + ms, 0);
        expect(total).toBeLessThanOrEqual(300_000);
        expect(Math.max(...slept)).toBeLessThanOrEqual(30_000);
        // One more capped backoff would have passed the budget.
        expect(total + 30_000).toBeGreaterThan(300_000);
        expect(call.calls()).toBe(slept.length + 1);
        expect(call.calls()).toBeGreaterThan(BOARD_CALL_ATTEMPTS);
    });

    it('still stops at once on a deterministic refusal', async () => {
        const { io: rec } = io();
        const call = failing(new BoardHttpError(413, 'answered 413'));

        await expect(withBoardRetry(rec, 'x', call.call, { budgetMs: 300_000 })).rejects.toThrow('answered 413');

        expect(call.calls()).toBe(1);
    });
});
