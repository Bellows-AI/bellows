/** Sleeps `ms`, or less when `signal` aborts first; the caller's loop sees the abort. */
export const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });
