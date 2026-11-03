import { z } from 'zod';
import { inconclusive, judge, refusal, success, type Tagged } from '../result.js';
import { defineTool, READ_ONLY } from '../tool.js';
import { MAX_CURSOR_CHARS, MAX_NAME_CHARS, pageOf, PAGING_INPUT, queryOf } from './paging.js';
import { JobIdInput, jobPath } from './runs.js';

/** What one `read_job_log` page may carry: a small default and a hard cap, both in bytes of text. */
const KIB = 1024;
const LOG_DEFAULT_KIB = 32;
const LOG_MAX_KIB = 256;
export const LOG_DEFAULT_BYTES = LOG_DEFAULT_KIB * KIB;
export const LOG_MAX_BYTES = LOG_MAX_KIB * KIB;
/** No UTF-8 character is longer, so a cut always finds a boundary inside the page. */
const LOG_MIN_BYTES = 16;

const StreamView = z.object({
    attempt: z.number(),
    executor: z.string(),
    session: z.string(),
    stream: z.string(),
    state: z.enum(['complete', 'partial', 'truncated', 'deleted']),
    terminalCause: z.string().nullable(),
    chunks: z.number(),
    bytes: z.number(),
    producer: z.string().nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
});

const Selection = {
    stream: z.string().max(MAX_NAME_CHARS).optional().describe('Only this stream (for example transcript or log).'),
    attempt: z.number().int().min(0).optional().describe('Only this attempt (claim sequence).'),
    session: z.string().max(MAX_NAME_CHARS).optional().describe('Only this session.'),
    executor: z.string().max(MAX_NAME_CHARS).optional().describe('Only this executor.'),
};

/** Wide enough that attempts sort numerically as text. */
const ATTEMPT_DIGITS = 9;

const streamKey = (s: z.infer<typeof StreamView>): string =>
    [String(s.attempt).padStart(ATTEMPT_DIGITS, '0'), s.session, s.stream, s.executor].join('|');

export const listJobStreams = defineTool({
    name: 'list_job_streams',
    description:
        'List the log streams of a run across attempts, sessions and executors, each with its state: complete, partial (still running or never finalized), truncated or deleted. Sorted by attempt, session, stream. Use the result to pick the selection for read_job_log.',
    scope: 'factory:read',
    routes: [['GET', '/api/jobs/:id/artifacts']],
    annotations: READ_ONLY,
    input: JobIdInput.extend({ ...Selection, ...PAGING_INPUT }),
    output: z.object({ jobId: z.string(), streams: z.array(StreamView), cursor: z.string().nullable() }),
    async run({ jobId, limit, cursor, ...selection }, ctx) {
        const url = `${jobPath(jobId)}/artifacts${queryOf(selection)}`;
        const judged = judge(
            await ctx.fetch({ method: 'GET', url }),
            z.object({ jobId: z.string(), streams: z.array(StreamView) })
        );
        if (!judged.ok) return judged.tagged;
        const paged = pageOf(judged.data.streams, streamKey, { limit, cursor });
        return {
            outcome: 'ok',
            result: success(
                { jobId: judged.data.jobId, streams: paged.page, cursor: paged.cursor },
                `${paged.page.length} streams${paged.cursor ? ', more available' : ''}`
            ),
        };
    },
});

const BoardSegment = z.object({
    attempt: z.number(),
    executor: z.string(),
    session: z.string(),
    stream: z.string(),
    offset: z.number(),
    length: z.number(),
    gapBefore: z.number(),
    state: z.enum(['ok', 'deleted']),
    text: z.string().nullable(),
});
const BoardPage = z.object({
    jobId: z.string(),
    streams: z.array(StreamView),
    segments: z.array(BoardSegment),
    nextCursor: z.string().nullable(),
});

/** This tool's cursor: the board's cursor of the page it was cut from, and how many bytes of its first chunk were read. */
const OwnCursor = z.object({ c: z.string().nullable(), s: z.number().int().min(0) });
type OwnCursor = z.infer<typeof OwnCursor>;
const encode = (cursor: OwnCursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');
function decode(raw: string | undefined): OwnCursor | null {
    if (raw === undefined) return { c: null, s: 0 };
    try {
        const parsed = OwnCursor.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

const UTF8_TAIL_MASK = 0b1100_0000;
const UTF8_TAIL = 0b1000_0000;

/** The prefix of `buf` of at most `max` bytes that ends on a character boundary. */
function boundary(buf: Buffer, max: number): number {
    let end = Math.min(max, buf.length);
    while (end > 0 && end < buf.length && (buf[end]! & UTF8_TAIL_MASK) === UTF8_TAIL) end -= 1;
    return end;
}

type Fitted = { segments: z.infer<typeof BoardSegment>[]; cutAt: number | null } | 'bad_cursor' | 'over_cap';

/**
 * The page's segments within `limit` bytes of text, the first text segment read from byte `skip`. Only that one
 * can be cut: the board fills a page with whole chunks and stops at the first that does not fit, so a later
 * segment over the cap means the board broke its own bound.
 */
function withinCap(source: readonly z.infer<typeof BoardSegment>[], skip: number, limit: number): Fitted {
    const segments: z.infer<typeof BoardSegment>[] = [];
    let used = 0;
    let from = skip;
    for (const segment of source) {
        if (segment.text === null) {
            segments.push(segment);
            continue;
        }
        const whole = Buffer.from(segment.text);
        if (from > whole.length) return 'bad_cursor';
        const buf = whole.subarray(from);
        if (buf.length > limit - used) {
            if (used > 0) return 'over_cap';
            const end = boundary(buf, limit);
            const cut = {
                ...segment,
                offset: segment.offset + from,
                length: end,
                text: buf.subarray(0, end).toString('utf8'),
            };
            return { segments: [...segments, cut], cutAt: from + end };
        }
        segments.push(
            from === 0
                ? segment
                : { ...segment, offset: segment.offset + from, length: buf.length, text: buf.toString('utf8') }
        );
        used += buf.length;
        from = 0;
    }
    return { segments, cutAt: null };
}

const badCursor = (): Tagged => ({
    outcome: 'refused',
    result: refusal('bad_cursor', 'cursor was not issued by this tool for this query'),
});

export const readJobLog = defineTool({
    name: 'read_job_log',
    description: `Read one page of a run's log text, in attempt, session, stream and offset order. A page holds at most \`limitBytes\` bytes (default ${LOG_DEFAULT_BYTES}, at most ${LOG_MAX_BYTES}); keep passing \`cursor\` until it is null to read to the end. The text is what the board stored, with the runner's secrets already masked. \`complete\` is true only when every selected stream is finalized and nothing on the page is missing or deleted; \`truncated\` says one chunk was cut at the cap and the cursor continues inside it.`,
    scope: 'factory:read',
    routes: [['GET', '/api/jobs/:id/artifacts/read']],
    annotations: READ_ONLY,
    input: JobIdInput.extend({
        ...Selection,
        cursor: z
            .string()
            .max(MAX_CURSOR_CHARS)
            .optional()
            .describe('The cursor of the previous page; omit for the first.'),
        limitBytes: z.number().int().min(LOG_MIN_BYTES).max(LOG_MAX_BYTES).optional(),
    }),
    output: z.object({
        jobId: z.string(),
        streams: z.array(StreamView),
        segments: z.array(BoardSegment),
        cursor: z.string().nullable(),
        truncated: z.boolean(),
        complete: z.boolean(),
        bytes: z.number(),
    }),
    async run({ jobId, cursor, limitBytes = LOG_DEFAULT_BYTES, ...selection }, ctx) {
        const own = decode(cursor);
        if (!own) return badCursor();
        const query = queryOf({ ...selection, limit: limitBytes, cursor: own.c ?? undefined });
        const judged = judge(
            await ctx.fetch({ method: 'GET', url: `${jobPath(jobId)}/artifacts/read${query}` }),
            BoardPage
        );
        if (!judged.ok) return judged.tagged;
        const page = judged.data;

        const fitted = withinCap(page.segments, own.s, limitBytes);
        if (fitted === 'bad_cursor') return badCursor();
        if (fitted === 'over_cap') {
            return { outcome: 'inconclusive', result: inconclusive('the board page exceeded the byte cap') };
        }
        const { segments, cutAt } = fitted;
        const truncated = cutAt !== null;
        const next =
            cutAt !== null
                ? encode({ c: own.c, s: cutAt })
                : page.nextCursor === null
                  ? null
                  : encode({ c: page.nextCursor, s: 0 });
        const complete =
            page.streams.length > 0 &&
            page.streams.every((s) => s.state === 'complete') &&
            segments.every((s) => s.state === 'ok' && s.gapBefore === 0);
        const bytes = segments.reduce((n, s) => n + (s.text === null ? 0 : Buffer.byteLength(s.text)), 0);
        return {
            outcome: 'ok',
            result: success(
                { jobId: page.jobId, streams: page.streams, segments, cursor: next, truncated, complete, bytes },
                `${bytes} bytes${next ? ', more available' : ''}${complete ? '' : ', incomplete'}`
            ),
        };
    },
});
