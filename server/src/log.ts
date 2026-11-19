/**
 * The board's one structured logger: pino JSON on stdout, every record also handed to the OTEL LoggerProvider
 * (a no-op until `otel.ts` starts the SDK). Records inside a span carry its `trace_id`/`span_id`. What a record may
 * hold is closed here — the request serializer logs the route pattern, never the concrete path or query, and `redact`
 * blanks credentials — and both destinations sit behind it, so the OTLP copy is never less redacted than stdout.
 * docs/observability.md.
 */
import { logs, SeverityNumber, trace } from '@opentelemetry/api';
import type { LogRecord } from '@opentelemetry/api';
import type { FastifyReply, FastifyRequest } from 'fastify';
import pino from 'pino';

export const LOGGER_NAME = 'bellows-board';

/** The route a request no route matched is logged and counted under. */
export const UNMATCHED_ROUTE = '<unmatched>';

export const REDACT_PATHS = [
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
    '*.token',
    '*.accessToken',
    '*.refreshToken',
    '*.password',
];

/** pino level → OTLP severity. */
const SEVERITY: Record<number, { number: SeverityNumber; text: string }> = {
    10: { number: SeverityNumber.TRACE, text: 'TRACE' },
    20: { number: SeverityNumber.DEBUG, text: 'DEBUG' },
    30: { number: SeverityNumber.INFO, text: 'INFO' },
    40: { number: SeverityNumber.WARN, text: 'WARN' },
    50: { number: SeverityNumber.ERROR, text: 'ERROR' },
    60: { number: SeverityNumber.FATAL, text: 'FATAL' },
};

/** Fields the OTLP record carries as its own members, or not at all. */
const NOT_ATTRIBUTES = new Set(['time', 'level', 'pid', 'hostname', 'msg']);

type AnyValueMap = NonNullable<LogRecord['attributes']>;

const attributeOf = (value: unknown): AnyValueMap[string] =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : JSON.stringify(value);

/**
 * Hands a finished pino line to the LoggerProvider. It runs inside the log call, so the active context is the
 * caller's. Never throws: a log line must not fail the request that wrote it.
 */
const otelDestination: pino.DestinationStream = {
    write(line: string) {
        try {
            const record = JSON.parse(line) as Record<string, unknown>;
            const severity = SEVERITY[record.level as number] ?? SEVERITY[30];
            const attributes: AnyValueMap = {};
            for (const [key, value] of Object.entries(record)) {
                if (!NOT_ATTRIBUTES.has(key) && value !== undefined) attributes[key] = attributeOf(value);
            }
            logs.getLogger(LOGGER_NAME).emit({
                severityNumber: severity?.number ?? SeverityNumber.INFO,
                severityText: severity?.text ?? 'INFO',
                body: typeof record.msg === 'string' ? record.msg : '',
                attributes,
                timestamp: typeof record.time === 'number' ? record.time : Date.now(),
            });
        } catch {
            // Dropped: the stdout copy stands.
        }
    },
};

/** Fastify's own message for a request no route took: it spells the concrete URL, query included. */
const NOT_FOUND_MESSAGE = /^Route (\w+):.* not found$/;

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
 * it has them as short tokens. Never its message, stack or cause — a GitHub, git or HTTP client error spells the
 * request it failed on (`/repos/<owner>/<name>/pulls/7`), which is a repository name.
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

export interface LoggerOptions {
    /** Where the JSON lines go; stdout unless a test captures them. */
    stdout?: pino.DestinationStream;
    level?: string;
}

export function createLogger({ stdout = pino.destination(1), level = 'info' }: LoggerOptions = {}): pino.Logger {
    return pino(
        {
            level,
            mixin() {
                const context = trace.getActiveSpan()?.spanContext();
                return context && trace.isSpanContextValid(context)
                    ? { trace_id: context.traceId, span_id: context.spanId }
                    : {};
            },
            redact: REDACT_PATHS,
            hooks: {
                logMethod(args, method) {
                    withoutErrorMessage(args);
                    const at = typeof args[0] === 'string' ? 0 : 1;
                    const message = args[at];
                    if (typeof message === 'string') {
                        args[at] = message.replace(NOT_FOUND_MESSAGE, `Route $1:${UNMATCHED_ROUTE} not found`);
                    }
                    method.apply(this, args);
                },
            },
            serializers: {
                req: (request: FastifyRequest) => ({
                    method: request.method,
                    url: request.routeOptions?.url ?? UNMATCHED_ROUTE,
                    id: request.id,
                }),
                err: errorClass,
                res: (reply: FastifyReply) => ({ statusCode: reply.statusCode }),
            },
        },
        pino.multistream([{ stream: stdout }, { stream: otelDestination }])
    );
}

/** The process's logger. Modules take a child of it with `logger('component')`. */
export const root = createLogger();

export const logger = (component: string): pino.Logger => root.child({ component });
