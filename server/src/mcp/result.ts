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

/** A refusal the board (or the tool layer) gave: the caller was heard and the answer is no. `code` is the board's. */
export const refusal = (code: string, message: string, status?: number): CallToolResult =>
    failure({ outcome: 'refused', code, message, ...(status === undefined ? {} : { status }) }, `${code}: ${message}`);

/** No verdict: the board did not answer, or answered something that cannot be trusted. Never success, never failure. */
export const inconclusive = (reason: string): CallToolResult =>
    failure(
        { outcome: 'inconclusive', reason },
        `inconclusive: ${reason}. The outcome is unknown; check the board before retrying.`
    );

/** A success: the board's data as structured content plus a one-line text for clients that do not read it. */
export const success = (data: Record<string, unknown>, summary: string): CallToolResult => ({
    content: [{ type: 'text', text: summary }],
    structuredContent: data,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const MAX_MESSAGE_CHARS = 500;
const CODE_LIKE = /^[a-z0-9_]{1,64}$/i;
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

/**
 * A board 4xx carries `{ error, code? }`. The code is the board's own, verbatim (`insufficient_scope` has only
 * `error`); a 4xx that names neither is not a board answer and is inconclusive.
 */
function refusalOf(status: number, body: unknown): Tagged {
    if (isRecord(body)) {
        const named = typeof body.code === 'string' && body.code ? body.code : undefined;
        // Without a `code`, the error text is the code only when it is a plain identifier (`insufficient_scope`).
        const fromError = typeof body.error === 'string' && CODE_LIKE.test(body.error) ? body.error : undefined;
        const code = named ?? fromError ?? (typeof body.error === 'string' && body.error ? FALLBACK_CODE : undefined);
        if (code !== undefined) return { outcome: 'refused', result: refusal(code, textOf(body.error, code), status) };
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
