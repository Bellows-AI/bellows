/**
 * The driver's logger: pino JSON on stdout, and a copy of every record on the OTEL logger provider (a no-op without an
 * OTLP endpoint). The record shape matches the board's: numeric `level`, `time`, `msg`, `component`, and `trace_id` /
 * `span_id` inside an active span. A record never names a repository or branch. docs/telemetry.md.
 */
import { type Attributes, type DiagLogger, type Logger, logs, SeverityNumber, trace } from '@opentelemetry/api';
import pino from 'pino';

export const LOGGER_NAME = 'bellows-driver';

export const COMPONENTS = ['driver', 'reaper', 'k8s', 'loop', 'drain', 'export'] as const;
export type Component = (typeof COMPONENTS)[number];

export const REDACT_PATHS = [
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
    '*.token',
    '*.accessToken',
    '*.refreshToken',
    '*.password',
];

/** pino's numeric levels to the OTLP severity they ship as. */
const SEVERITIES: Record<number, { number: SeverityNumber; text: string }> = {
    10: { number: SeverityNumber.TRACE, text: 'TRACE' },
    20: { number: SeverityNumber.DEBUG, text: 'DEBUG' },
    30: { number: SeverityNumber.INFO, text: 'INFO' },
    40: { number: SeverityNumber.WARN, text: 'WARN' },
    50: { number: SeverityNumber.ERROR, text: 'ERROR' },
    60: { number: SeverityNumber.FATAL, text: 'FATAL' },
};
/** Record fields that are the OTLP record's own and not attributes. */
const NOT_ATTRIBUTES = new Set(['time', 'level', 'pid', 'hostname', 'msg']);
const DIAG_INTERVAL_MS = 60_000;
const LEVEL_WARN = 40;
const LEVEL_ERROR = 50;

/** The most of an error's name, code or kind a record keeps. */
const CLASS_MAX = 64;
const CLASS_TOKEN = /^[\w.:-]+$/;

const tokenOf = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length <= CLASS_MAX && CLASS_TOKEN.test(value) ? value : undefined;

export interface ErrorClass {
    type: string;
    code?: string | undefined;
    kind?: string | undefined;
    status?: number | undefined;
}

/**
 * The closed description of an error a record may carry: its class name, and the `code`, `kind` and HTTP status when
 * it has them as short tokens. Never its message, stack or cause — a git, gh or HTTP client error spells the request
 * or output it failed on, which is a repository or branch name.
 */
export function errorClass(error: unknown): ErrorClass {
    const source = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
    const status = source.status ?? source.statusCode;
    return {
        type: error instanceof Error ? (tokenOf(error.name) ?? 'Error') : 'NonError',
        ...(tokenOf(source.code) ? { code: tokenOf(source.code) } : {}),
        ...(tokenOf(source.kind) ? { kind: tokenOf(source.kind) } : {}),
        ...(typeof status === 'number' ? { status } : {}),
    };
}

/** `errorClass` as one token string, for the log seams that take a line. */
export const describeError = (error: unknown): string => {
    const { type, code, kind, status } = errorClass(error);
    return [type, code, kind, status].filter((part) => part !== undefined).join(' ');
};

/** The message of a record whose only subject is an error: pino would otherwise spell the error's own message. */
const ERROR_MESSAGE = 'error';

/** `error(err)` and `error({ err })` with no message: name the record without the error's message. */
function withoutErrorMessage(args: unknown[]): void {
    const [first] = args;
    if (first instanceof Error) args.splice(0, 1, { err: first }, ERROR_MESSAGE);
    else if (typeof first === 'object' && first !== null && 'err' in first && args.length === 1)
        args.push(ERROR_MESSAGE);
}

interface Sink {
    write(line: string): unknown;
}

/** Ships one pino line as an OTLP log record. It never throws: a log line must not cost the call that wrote it. */
function otelStream(logger: () => Logger): Sink {
    return {
        write(line) {
            try {
                const record = JSON.parse(line) as Record<string, unknown>;
                const severity = SEVERITIES[Number(record.level)] ?? SEVERITIES[30]!;
                const attributes: Attributes = {};
                for (const [key, value] of Object.entries(record)) {
                    if (!NOT_ATTRIBUTES.has(key))
                        attributes[key] = typeof value === 'object' ? JSON.stringify(value) : (value as string);
                }
                logger().emit({
                    severityNumber: severity.number,
                    severityText: severity.text,
                    body: String(record.msg ?? ''),
                    attributes,
                    timestamp: Number(record.time),
                });
            } catch {
                // Swallowed on purpose: the exporter's own faults are `diagLogger`'s, never routed back here.
            }
        },
    };
}

export interface LogDeps {
    /** Where the JSON lines go; stdout unless a test captures them. */
    stdout?: Sink;
    logger?: () => Logger;
}

export function createLogRoot(deps: LogDeps = {}): pino.Logger {
    const stdout = deps.stdout ?? process.stdout;
    const logger = deps.logger ?? (() => logs.getLogger(LOGGER_NAME));
    return pino(
        {
            redact: REDACT_PATHS,
            hooks: {
                logMethod(args, method) {
                    withoutErrorMessage(args);
                    method.apply(this, args);
                },
            },
            serializers: { err: errorClass },
            mixin() {
                const context = trace.getActiveSpan()?.spanContext();
                return context && trace.isSpanContextValid(context)
                    ? { trace_id: context.traceId, span_id: context.spanId }
                    : {};
            },
        },
        // The root's own level filters; each stream takes whatever reaches it (a multistream defaults to `info`).
        pino.multistream([
            { stream: stdout, level: 'trace' },
            { stream: otelStream(logger), level: 'trace' },
        ])
    );
}

export const logRoot = createLogRoot();

/** The logger of one component of the driver. */
export const logger = (component: Component): pino.Logger => logRoot.child({ component });

/**
 * The OTEL SDK's own diagnostics (an export that failed), to stdout only — never back into the log stream, whose
 * exporter is what failed — and at most once a minute, so a dead collector is one line, not a flood.
 */
export function diagLogger(stdout: Sink = process.stdout, now: () => number = Date.now): DiagLogger {
    let last = -Infinity;
    const line = (message: string, level: number) => {
        const at = now();
        if (at - last < DIAG_INTERVAL_MS) return;
        last = at;
        stdout.write(`${JSON.stringify({ level, time: at, component: 'otel', msg: message })}\n`);
    };
    const warn = (message: string) => line(message, LEVEL_WARN);
    const error = (message: string) => line(message, LEVEL_ERROR);
    const quiet = () => undefined;
    return { error, warn, info: quiet, debug: quiet, verbose: quiet };
}
