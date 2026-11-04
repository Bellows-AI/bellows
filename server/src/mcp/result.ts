import type { CallToolResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { BridgeOutcome } from './bridge.js';

/** How a tool call ended, as the metrics and the structured content name it. */
export type ToolOutcome = 'ok' | 'refused' | 'inconclusive';

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_CLIENT_ERROR_MAX = 499;

export interface Tagged {
    readonly result: CallToolResult;
    readonly outcome: ToolOutcome;
}

const failure = (structured: Record<string, unknown>, text: string): CallToolResult => ({
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: structured,
});

/** One path-addressed problem a board refusal listed (a refused batch plan names each). */
export interface RefusalIssue {
    readonly path: string;
    readonly message: string;
}

const issueText = (issue: RefusalIssue): string => `${issue.path || '(plan)'}: ${issue.message}`;

/** Past this many issues the text counts the rest; `structuredContent` keeps the whole bounded list. */
const TEXT_ISSUES = 3;

const issuesTextOf = (issues: readonly RefusalIssue[]): string => {
    const shown = issues.slice(0, TEXT_ISSUES).map(issueText).join('; ');
    return issues.length > TEXT_ISSUES ? `${shown}; (+${issues.length - TEXT_ISSUES} more)` : shown;
};

/**
 * A refusal the board (or the tool layer) gave: the caller was heard and the answer is no. `code` is the board's;
 * `reason` is its machine-readable sub-reason when it sent one (`BATCH_UNSUPPORTED` / `multi_target`).
 */
export const refusal = (
    code: string,
    message: string,
    status?: number,
    { issues = [], reason }: { readonly issues?: readonly RefusalIssue[]; readonly reason?: string | undefined } = {}
): CallToolResult =>
    failure(
        {
            outcome: 'refused',
            code,
            message,
            ...(reason === undefined ? {} : { reason }),
            ...(status === undefined ? {} : { status }),
            ...(issues.length === 0 ? {} : { issues }),
        },
        issues.length === 0 ? `${code}: ${message}` : `${code}: ${message} (${issuesTextOf(issues)})`
    );

/** No verdict: the board did not answer, or answered something that cannot be trusted. Never success, never failure. */
export const inconclusive = (reason: string): CallToolResult =>
    failure(
        { outcome: 'inconclusive', reason },
        `inconclusive: ${reason}. The outcome is unknown; check the board before retrying.`
    );

/**
 * A success: the board's data as structured content, and as text a one-line summary followed by the same data
 * serialized — the MCP spec's backward-compatible shape. A client that hands the model only `content` (claude.ai)
 * otherwise sees "failed" or "5 runs" with no cause, PR, gates or log text behind it.
 */
export const success = (data: Record<string, unknown>, summary: string): CallToolResult => ({
    content: [
        { type: 'text', text: summary },
        { type: 'text', text: JSON.stringify(data) },
    ],
    structuredContent: data,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const MAX_MESSAGE_CHARS = 500;
const MAX_ISSUES = 20;
const CODE_LIKE = /^[a-z0-9_]{1,64}$/i;
/** The value when it is a plain identifier (a code, a reason), else undefined. */
const codeLike = (value: unknown): string | undefined =>
    typeof value === 'string' && CODE_LIKE.test(value) ? value : undefined;
const FALLBACK_CODE = 'board_refused';
const SPACE = 0x20;
const DELETE = 0x7f;

/** The board's error text as a client may show it: no tags, no control characters, at most 500 characters. */
const textOf = (value: unknown, fallback: string): string => {
    if (typeof value !== 'string') return fallback;
    const stripped = value.replace(/<[^>]*>/g, '');
    const printable = Array.from(stripped)
        .filter((ch) => {
            const code = ch.codePointAt(0) ?? 0;
            return code >= SPACE && code !== DELETE && ch !== '<' && ch !== '>';
        })
        .join('')
        .trim();
    return printable ? printable.slice(0, MAX_MESSAGE_CHARS) : fallback;
};

/** The `issues` a board 4xx lists, each cleaned like the message; anything not a `{ path, message }` pair is dropped. */
const issuesOf = (body: Record<string, unknown>): RefusalIssue[] => {
    if (!Array.isArray(body.issues)) return [];
    return (body.issues as unknown[])
        .filter(isRecord)
        .filter((issue) => typeof issue.path === 'string' && typeof issue.message === 'string')
        .slice(0, MAX_ISSUES)
        .map((issue) => ({ path: textOf(issue.path, ''), message: textOf(issue.message, '') }));
};

/**
 * A board 4xx carries `{ error, code?, reason?, issues? }`. The code is the board's own, verbatim (`insufficient_scope` has only
 * `error`); a 4xx that names neither is not a board answer and is inconclusive.
 */
function refusalOf(status: number, body: unknown): Tagged {
    if (isRecord(body)) {
        const named = typeof body.code === 'string' && body.code ? body.code : undefined;
        // Without a `code`, the error text is the code only when it is a plain identifier (`insufficient_scope`).
        const fromError = codeLike(body.error);
        const code = named ?? fromError ?? (typeof body.error === 'string' && body.error ? FALLBACK_CODE : undefined);
        const reason = codeLike(body.reason);
        if (code !== undefined)
            return {
                outcome: 'refused',
                result: refusal(code, textOf(body.error, code), status, { issues: issuesOf(body), reason }),
            };
    }
    return { outcome: 'inconclusive', result: inconclusive(`malformed ${status} response`) };
}

export type Judged<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly tagged: Tagged };

/**
 * The one door every bridge answer goes through. A 2xx that passes `schema` is data; a 4xx the board explained is a
 * refusal; everything else (5xx, a redirect, a timeout, an abort, an empty, null or schema-failing body) is
 * inconclusive. A payload's own `stale` markers are kept as the board sent them, never refreshed here.
 */
export function judge<S extends z.ZodType>(outcome: BridgeOutcome, schema: S): Judged<z.output<S>> {
    if (outcome.kind === 'inconclusive') {
        return { ok: false, tagged: { outcome: 'inconclusive', result: inconclusive(outcome.reason) } };
    }
    const { status, body } = outcome;
    if (status >= HTTP_OK_MIN && status <= HTTP_OK_MAX) {
        const checked = schema.safeParse(body);
        if (checked.success) return { ok: true, data: checked.data };
        return { ok: false, tagged: { outcome: 'inconclusive', result: inconclusive('malformed response') } };
    }
    if (status >= HTTP_CLIENT_ERROR_MIN && status <= HTTP_CLIENT_ERROR_MAX) {
        return { ok: false, tagged: refusalOf(status, body) };
    }
    return { ok: false, tagged: { outcome: 'inconclusive', result: inconclusive(`board answered ${status}`) } };
}

/** `judge` for the common case of one call whose data is the whole result. */
export function mapResult<S extends z.ZodType<Record<string, unknown>>>(
    outcome: BridgeOutcome,
    schema: S,
    summarize: (data: z.output<S>) => string
): Tagged {
    const judged = judge(outcome, schema);
    if (!judged.ok) return judged.tagged;
    return { outcome: 'ok', result: success(judged.data, summarize(judged.data)) };
}
