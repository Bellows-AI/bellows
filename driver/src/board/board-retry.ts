/** How many times a board call that must land is tried: the verdict and a question report. */
export const BOARD_CALL_ATTEMPTS = 5;
const BOARD_CALL_BACKOFF_MS = 1_000;
/** The longest single backoff once a budget lets the doubling run on. */
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

/** Thrown into a board call the driver's lapsed lease fenced (`loop-lease.ts`). */
export class LeaseLapsedError extends Error {
    constructor() {
        super('the lease lapsed while the board was unreachable');
        this.name = 'LeaseLapsedError';
    }
}

/** Settles with `call`, or rejects with `LeaseLapsedError` the moment `signal` aborts; the call is abandoned. */
export function fenced<T>(signal: AbortSignal | undefined, call: () => Promise<T>): Promise<T> {
    if (signal === undefined) return call();
    if (signal.aborted) return Promise.reject(new LeaseLapsedError());
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(new LeaseLapsedError());
        signal.addEventListener('abort', onAbort, { once: true });
        call()
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', onAbort));
    });
}

/**
 * Whether a throw is worth sending again unchanged: a transport failure or a 5xx is the board being
 * briefly down; any other 4xx is its answer to this exact body, and the same body earns it again.
 */
function retryable(e: unknown): boolean {
    if (!(e instanceof BoardHttpError)) return true;
    return e.status >= HTTP_SERVER_ERROR || TRANSIENT_CLIENT_STATUSES.has(e.status);
}

/** Whether a retry loop has used what it was given: its attempts, or with a budget, the summed backoff. */
const spent = (attempt: number, waitedMs: number, budgetMs?: number): boolean =>
    budgetMs === undefined ? attempt >= BOARD_CALL_ATTEMPTS : waitedMs > budgetMs;

/**
 * Retries a board call that threw (a 5xx, a dropped connection) with doubling backoff; the last
 * throw propagates. A board VERDICT — 409, 404 — is an answer and returns, so it is never retried,
 * and neither is a deterministic refusal (a 400, a 413): it throws at once.
 * `what` opens the log line ("job <id>: the verdict was not accepted"). Without `budgetMs` the call
 * is tried `BOARD_CALL_ATTEMPTS` times; with it, until the summed backoff would pass the budget.
 * `leaseLapsed` fences the retry on the driver's lease clock: no call starts once it aborts, and
 * one in flight or a backoff is abandoned with `LeaseLapsedError`, never retried.
 */
export async function withBoardRetry<T>(
    io: { log: (message: string) => void; sleep: (ms: number) => Promise<void> },
    what: string,
    call: () => Promise<T>,
    { budgetMs, leaseLapsed }: { budgetMs?: number; leaseLapsed?: AbortSignal } = {}
): Promise<T> {
    let waitedMs = 0;
    for (let attempt = 1; ; attempt++) {
        try {
            return await fenced(leaseLapsed, call);
        } catch (e) {
            if (e instanceof LeaseLapsedError) throw e;
            if (!retryable(e)) {
                io.log(`${what}, not retried: ${(e as Error).message}`);
                throw e;
            }
            const delayMs = Math.min(BOARD_CALL_BACKOFF_MS * 2 ** (attempt - 1), BOARD_CALL_MAX_BACKOFF_MS);
            if (spent(attempt, waitedMs + delayMs, budgetMs)) throw e;
            io.log(`${what}, retrying in ${delayMs}ms: ${(e as Error).message}`);
            await fenced(leaseLapsed, () => io.sleep(delayMs));
            waitedMs += delayMs;
        }
    }
}
