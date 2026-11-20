import { setTimeout as delay } from 'node:timers/promises';
import type { Otel } from './otel.js';

/** How long the exit waits for the SDK to flush before it goes anyway. */
export const OTEL_FLUSH_MS = 2_000;
const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * The driver's exit: what the SDK has buffered (logs, spans, the last metrics) is flushed first, raced against
 * `OTEL_FLUSH_MS`; a flush that is late or fails never holds the exit, and one more signal ends it at once.
 */
export function createFlushThenExit(deps: {
    otel: Otel | null;
    exit: (code: number) => unknown;
    flushMs?: number;
    wait?: (ms: number) => Promise<unknown>;
    onSignal?: (signal: (typeof SIGNALS)[number], handler: () => void) => void;
}): (code: number) => Promise<void> {
    const { otel, exit, flushMs = OTEL_FLUSH_MS, wait = delay } = deps;
    const onSignal = deps.onSignal ?? ((signal, handler) => void process.once(signal, handler));
    return async (code) => {
        for (const signal of SIGNALS) onSignal(signal, () => exit(code));
        await Promise.race([otel?.shutdown().catch(() => undefined), wait(flushMs)]);
        exit(code);
    };
}
