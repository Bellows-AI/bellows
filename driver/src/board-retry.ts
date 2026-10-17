/** How many times a board call that must land is tried: the verdict and a question report. */
export const BOARD_CALL_ATTEMPTS = 5;
const BOARD_CALL_BACKOFF_MS = 1_000;
/** The longest single backoff once a budget lets the doubling run on (issue #820). */
const BOARD_CALL_MAX_BACKOFF_MS = 30_000;

const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_EARLY = 425;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
/** The 4xx answers that say "later", not "never". */
const TRANSIENT_CLIENT_STATUSES = new Set([HTTP_REQUEST_TIMEOUT, HTTP_TOO_EARLY, HTTP_TOO_MANY_REQUESTS]);

/**
 * A board answer outside the ones a caller allowed. The status rides the error so the retry can tell
 * a deterministic refusal (a 4xx the same body earns again) from a board that is briefly down.
 */
export class BoardHttpError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'BoardHttpError';
        this.status = status;
    }
}

/**
 * Whether a throw is worth sending again unchanged: a transport failure or a 5xx is the board being
 * briefly down; any other 4xx is its answer to this exact body, and the same body earns it again.
 */
function retryable(e: unknown): boolean {
    if (!(e instanceof BoardHttpError)) return true;
    return e.status >= HTTP_SERVER_ERROR || TRANSIENT_CLIENT_STATUSES.has(e.status);
}

/**
 * Retries a board call that threw (a 5xx, a dropped connection) with doubling backoff; the last
 * throw propagates. A board VERDICT — 409, 404 — is an answer and returns, so it is never retried,
 * and neither is a deterministic refusal (a 400, a 413): it throws at once (issue #820).
 * `what` opens the log line ("job <id>: the verdict was not accepted"). Without `budgetMs` the call
 * is tried `BOARD_CALL_ATTEMPTS` times; with it, until the summed backoff would pass the budget.
 */
export async function withBoardRetry<T>(
    io: { log: (message: string) => void; sleep: (ms: number) => Promise<void> },
    what: string,
    call: () => Promise<T>,
    { budgetMs }: { budgetMs?: number } = {}
): Promise<T> {
    let waitedMs = 0;
    for (let attempt = 1; ; attempt++) {
        try {
            return await call();
        } catch (e) {
            if (!retryable(e)) {
                io.log(`${what}, not retried: ${(e as Error).message}`);
                throw e;
            }
            const delayMs = Math.min(BOARD_CALL_BACKOFF_MS * 2 ** (attempt - 1), BOARD_CALL_MAX_BACKOFF_MS);
            if (budgetMs === undefined ? attempt >= BOARD_CALL_ATTEMPTS : waitedMs + delayMs > budgetMs) throw e;
            io.log(`${what}, retrying in ${delayMs}ms: ${(e as Error).message}`);
            await io.sleep(delayMs);
            waitedMs += delayMs;
        }
    }
}
