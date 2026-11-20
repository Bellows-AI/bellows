import { logs } from '@opentelemetry/api';
import { LoggerProvider, type LogRecordProcessor, type ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { createLogger } from '../src/log.js';

/** One record as the LoggerProvider received it. */
export interface Emitted {
    severityNumber: number | undefined;
    severityText: string | undefined;
    body: unknown;
    attributes: Record<string, unknown>;
}

/**
 * Captures what the board's loggers write: a fresh logger on a captured stdout, and every record any logger hands the
 * global LoggerProvider (the `logger(...)` children of the process root included). The provider's processor records
 * synchronously, so it holds under fake timers. `stop` hands the global provider back.
 */
export function captureLogs() {
    const lines: string[] = [];
    const emitted: Emitted[] = [];
    const processor: LogRecordProcessor = {
        onEmit: (record: ReadableLogRecord | { body?: unknown }) => {
            const { severityNumber, severityText, body, attributes } = record as ReadableLogRecord;
            emitted.push({ severityNumber, severityText, body, attributes: { ...attributes } });
        },
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
    };
    logs.disable();
    logs.setGlobalLoggerProvider(new LoggerProvider({ processors: [processor] }));
    return {
        logger: createLogger({ stdout: { write: (line: string) => void lines.push(line) }, level: 'trace' }),
        /** Parsed stdout records of `logger`. */
        records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
        /** Everything either destination of `logger` received, as one string to search. */
        everything: () =>
            lines.join('') + JSON.stringify(emitted.map((r) => ({ body: r.body, attributes: r.attributes }))),
        emitted: () => emitted,
        /** The OTLP records of one component, as `[severity, body]`. */
        of: (component: string) =>
            emitted.filter((r) => r.attributes.component === component).map((r) => [r.severityText, r.body]),
        stop: () => logs.disable(),
    };
}
