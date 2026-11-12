/**
 * The one wall-clock budget of a graceful close. Under the 10 s `docker stop` grace of compose and well under the
 * chart's `terminationGracePeriodSeconds` (preStopSeconds + 15), so the process exits on its own before a SIGKILL.
 */
export const SHUTDOWN_DEADLINE_MS = 10_000;

/** Stops one background loop: clears its timer and settles once the pass in flight has. */
export type Stop = () => void | Promise<void>;

/** Starts a loop and hands its stop to the registry; once the close began the loop is never started. */
export type Track = (start: () => Stop) => void;

/**
 * The background loops' stops, collected as they start (some start inside `ready.then`, long after `start()`
 * returned) so `close()` waits for every one of them. A loop whose start comes after `stopAll()` began is never
 * started, so none runs a pass against an ended pool. One stop throwing never skips the others.
 */
export function createStopRegistry() {
    const stops: Stop[] = [];
    let closing = false;
    const run = async (stop: Stop) => {
        try {
            await stop();
        } catch (e) {
            console.error(`[shutdown] a stop failed: ${(e as Error).message}`);
        }
    };
    return {
        add(start: () => Stop): void {
            if (closing) return;
            stops.push(start());
        },
        /** From here no loop starts: called before the server drains, while `ready` may still resolve. */
        refuseStarts(): void {
            closing = true;
        },
        async stopAll(): Promise<void> {
            closing = true;
            await Promise.all(stops.map(run));
        },
    };
}

const MS_PER_SECOND = 1000;

/**
 * The graceful close (BEL-322), under ONE wall-clock deadline: `app.close()` aborts the long-polls and refuses new
 * requests (503) while the open ones finish; then every loop settles its pass in flight; only then do the pools end,
 * so no query is cut mid-transaction (an interrupted one rolls back and the next pass redoes it). A failing step
 * never skips the next one; a failure or deadline overrun is thrown after the pools have been ended anyway. Calling
 * it again is the same promise.
 */
export function createClose({
    app,
    stops,
    pools,
}: {
    app: { close(): Promise<unknown> };
    stops: { refuseStarts(): void; stopAll(): Promise<void> };
    pools: { end(options: { timeout: number }): Promise<unknown> }[];
}): () => Promise<void> {
    let closed: Promise<void> | undefined;
    return () =>
        (closed ??= (async () => {
            const deadlineAt = Date.now() + SHUTDOWN_DEADLINE_MS;
            const failures: Error[] = [];
            const step = async (what: string, work: () => Promise<unknown>) => {
                try {
                    await beforeDeadline(work(), deadlineAt, what);
                } catch (e) {
                    failures.push(e as Error);
                }
            };
            stops.refuseStarts();
            await step('closing the server', () => app.close());
            await step('stopping the loops', () => stops.stopAll());
            const timeout = Math.max(1, Math.ceil((deadlineAt - Date.now()) / MS_PER_SECOND));
            await step('ending the database pools', () => Promise.all(pools.map((pool) => pool.end({ timeout }))));
            if (failures.length > 0) throw new Error(failures.map((f) => f.message).join('; '));
        })());
}

/** Rejects with `what` once the absolute `deadlineAt` passes, whichever nested await is still pending. */
export async function beforeDeadline<T>(work: Promise<T>, deadlineAt: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`${what} did not finish before the shutdown deadline`)),
            Math.max(0, deadlineAt - Date.now())
        );
    });
    try {
        return await Promise.race([work, late]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Closes on the first SIGTERM or SIGINT and exits 0, or 1 when the close failed or overran its deadline. A second
 * signal while closing is ignored: `close` is not re-entered.
 */
export function closeOnSignal(close: () => Promise<void>): void {
    let begun = false;
    const onSignal = (signal: NodeJS.Signals) => {
        if (begun) return;
        begun = true;
        console.log(`[shutdown] ${signal}: closing`);
        close().then(
            () => process.exit(0),
            (e: Error) => {
                console.error(`[shutdown] ${e.message}`);
                process.exit(1);
            }
        );
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
}
