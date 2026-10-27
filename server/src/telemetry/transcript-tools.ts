import { CLAUDE_CODE, OPENCODE } from '@factory-ai/core';

/**
 * Gate runs and pull-request operations read out of an executor's own transcript (issue #983): the
 * Claude session jsonl and the OpenCode raw export, pure and synchronous. An activity is the call
 * and, when one is paired and parses, its result. Nothing here counts anything as success on the
 * word of the agent: a call with no result, a result that does not parse, prose such as "tests
 * passed" and a PR URL mentioned in discussion are `unknown` or nothing. The session of an activity
 * is the one the record names, never the artifact it arrived in. Only classified fields leave this
 * module: no command, no output, no environment.
 */

export type ToolKind = 'gate' | 'pr';
/** `run` a gate; `create` a PR with `gh`; `publish` through the control socket; `lookup` an existing PR. */
export type ToolOperation = 'run' | 'create' | 'publish' | 'lookup';
export type ToolOutcome = 'passed' | 'failed' | 'unknown';

export interface ToolResult {
    outcome: ToolOutcome;
    exitCode: number | null;
    /** The gate server's `executionId`: the key of `job_gate_run`. */
    executionId: string | null;
    /** The publish reply's `operationId`: the key of `job_pr_operation`. */
    operationId: string | null;
    repo: string | null;
    prNumber: number | null;
    prUrl: string | null;
    /** When the execution started, as an instant, when the record carries it (OpenCode `state.time`). */
    startedAt: string | null;
    /** When it ended, as an instant, when the record carries it: the result record's own time. */
    endedAt: string | null;
    /** Byte offset of the record that carried the result, in the stream. */
    offset: number;
}

/** A classified call, before any result is paired with it. */
export interface ToolCall {
    session: string;
    toolCallId: string;
    kind: ToolKind;
    operation: ToolOperation;
    gate: string | null;
    filtered: boolean | null;
    /** False when the command is a compound line: what it printed is no evidence of what this call did. */
    lone: boolean;
    /** When the call started, as an instant, when the record carries it. */
    startedAt: string | null;
    /** Byte offset of the record that carried the call, in the stream. */
    offset: number;
}

export interface ToolActivity extends Omit<ToolCall, 'lone'> {
    /** Null while the call has no paired result: interrupted, or the result not delivered yet. */
    result: ToolResult | null;
}

/** A contiguous piece of a stream: its text and where it starts, in bytes. */
export interface TranscriptChunk {
    offset: number;
    text: string;
}

interface RawCall {
    session: string;
    id: string;
    command: string;
    offset: number;
    startedAt: string | null;
}

/**
 * A result read off the stream and not yet classified: it is classified against its call (`resolveResult`),
 * which may be in another chunk. Its text lives only in memory; it is never stored.
 */
export interface PendingResult {
    session: string;
    toolCallId: string;
    text: string;
    errored: boolean;
    offset: number;
    startedAt: string | null;
    endedAt: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)$/;
/** The wrappers the baked skills call (`docker/*-executor/factory-gate.cjs`, `factory-control.cjs`), #1061. */
const GATE_RUN = /^\s*factory-gate(?:\s|$)/;
const GATE_NAME = /^\s*factory-gate\s+['"]?([A-Za-z0-9_.:-]+)['"]?(?=\s|$)/;
const GATE_FILTER = /\s--filter(?:\s|=|$)/;
const PUBLISH = /^\s*factory-control\s+publish(?:\s|$)/;
const PR_CREATE = /^\s*gh\s+pr\s+create\b/;
const PR_LOOKUP = /^\s*gh\s+pr\s+(?:view|list)\b/;

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const asString = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** An instant, as ISO text, from epoch milliseconds or a date string; null when absent or not a time. */
const instantOf = (value: unknown): string | null => {
    const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
};

const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
};

/** The lines of the chunks with the byte offset each starts at; a blank line has nothing to read. */
function* linesOf(chunks: readonly TranscriptChunk[]): Generator<{ text: string; offset: number }> {
    for (const chunk of chunks) {
        let offset = chunk.offset;
        for (const text of chunk.text.split('\n')) {
            if (text.trim() !== '') yield { text, offset };
            offset += Buffer.byteLength(text) + 1;
        }
    }
}

interface Reading {
    calls: RawCall[];
    results: PendingResult[];
}

const textOfContent = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((block) => asString(asRecord(block)?.text) ?? '')
        .filter((text) => text !== '')
        .join('\n');
};

/** One content block of a Claude record: a Bash `tool_use` is a call, a `tool_result` a result. */
function claudeBlock(raw: unknown, at: { session: string; offset: number; time: string | null }, into: Reading): void {
    const block = asRecord(raw);
    if (block?.type === 'tool_use' && block.name === 'Bash') {
        const id = asString(block.id);
        const command = asString(asRecord(block.input)?.command);
        if (id && command) {
            into.calls.push({ session: at.session, offset: at.offset, startedAt: at.time, id, command });
        }
        return;
    }
    const id = block?.type === 'tool_result' ? asString(block.tool_use_id) : null;
    if (!id) return;
    into.results.push({
        session: at.session,
        offset: at.offset,
        toolCallId: id,
        text: textOfContent(block?.content),
        errored: block?.is_error === true,
        startedAt: null,
        endedAt: at.time,
    });
}

/** Claude jsonl: `tool_use` blocks of an assistant record, `tool_result` blocks of a user record, paired by id. */
function readClaude(chunks: readonly TranscriptChunk[]): Reading {
    const reading: Reading = { calls: [], results: [] };
    for (const line of linesOf(chunks)) {
        const record = asRecord(parseJson(line.text));
        const session = asString(record?.sessionId);
        const content = asRecord(record?.message)?.content;
        if (!session || !Array.isArray(content)) continue;
        const at = { session, offset: line.offset, time: instantOf(record?.timestamp) };
        for (const block of content) claudeBlock(block, at, reading);
    }
    return reading;
}

/** The tool part a raw `part` row holds, when it is a Bash call with the ids to pair it by. */
function opencodePart(text: string): { session: string; id: string; state: Record<string, unknown> } | null {
    const record = asRecord(parseJson(text));
    if (record?.table !== 'part') return null;
    const row = asRecord(record.row);
    const data = asRecord(typeof row?.data === 'string' ? parseJson(row.data) : row?.data);
    if (data?.type !== 'tool' || String(data.tool).toLowerCase() !== 'bash') return null;
    const session = asString(data.sessionID) ?? asString(row?.session_id);
    const id = asString(data.callID);
    const state = asRecord(data.state);
    return session && id && state ? { session, id, state } : null;
}

/** OpenCode raw export: one `part` row per tool part, holding the call and, once it ended, its result. */
function readOpencode(chunks: readonly TranscriptChunk[]): Reading {
    const reading: Reading = { calls: [], results: [] };
    for (const line of linesOf(chunks)) {
        const part = opencodePart(line.text);
        if (!part) continue;
        const { session, id, state } = part;
        const time = asRecord(state.time);
        const startedAt = instantOf(time?.start);
        const command = asString(asRecord(state.input)?.command);
        if (command) reading.calls.push({ session, id, offset: line.offset, command, startedAt });
        if (state.status !== 'completed' && state.status !== 'error') continue;
        const exit = asRecord(state.metadata)?.exit;
        const errored = state.status === 'error' || (typeof exit === 'number' && exit !== 0);
        reading.results.push({
            session,
            toolCallId: id,
            offset: line.offset,
            text: asString(state.output) ?? asString(state.error) ?? '',
            errored,
            startedAt,
            endedAt: instantOf(time?.end),
        });
    }
    return reading;
}

/** The first of a record's `{...}` lines, or the whole text, that parses as a JSON object. */
function jsonObjectOf(text: string): Record<string, unknown> | null {
    const whole = asRecord(parseJson(text.trim()));
    if (whole) return whole;
    const lines = text.split('\n').map((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i] ?? '';
        if (!line.startsWith('{')) continue;
        const parsed = asRecord(parseJson(line));
        if (parsed) return parsed;
    }
    return null;
}

const uuidOrNull = (value: unknown): string | null => (typeof value === 'string' && UUID.test(value) ? value : null);

type Classified = Pick<ToolCall, 'kind' | 'operation' | 'gate' | 'filtered' | 'lone'>;

/**
 * The simple commands of a shell line: it is split at every unquoted `;`, `&`, `|`, newline, backtick,
 * parenthesis and `$(`, and a quoted separator splits nothing — but a `$(` or backtick inside double
 * quotes still runs a command, so it counts as one more. Whether a call is the invocation it
 * looks like is decided on a command's own first words, never on a substring of the line.
 */
/** A shell line's tokens: an escape, a quoted string, a redirection `&`, a separator, plain text, a stray character. */
const SHELL_TOKEN = /\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|[<>]&|&>|\$\(|[;|&\n`()]|[^\\'"<>&$;|\n`()]+|[\s\S]/g;
const SEPARATOR = /^(?:\$\(|[;|&\n`()])$/;
/** A double-quoted string that runs a command of its own: an unescaped `$(` or backtick inside it. */
const QUOTED_SUBSTITUTION = /^"(?:\\[\s\S]|[^\\$`]|\$(?!\())*(?:\$\(|`)/;
/** ANSI-C quoting (`$'…'`) escapes its own quote, which the tokens above cannot follow: never lone. */
const ANSI_C_QUOTE = /\$'/;

function simpleCommands(command: string): string[] {
    const parts: string[] = [];
    let current = '';
    const flush = () => {
        if (current.trim() !== '') parts.push(current);
        current = '';
    };
    for (const [token] of command.replace(/\\\r?\n/g, ' ').matchAll(SHELL_TOKEN)) {
        if (SEPARATOR.test(token)) flush();
        else current += token;
        // The substituted command is a command of its own: the line is compound.
        if (QUOTED_SUBSTITUTION.test(token)) parts.push(token);
    }
    flush();
    return parts;
}

function classifyCall(command: string): Classified | null {
    const parts = simpleCommands(command);
    const lone = parts.length === 1 && !ANSI_C_QUOTE.test(command);
    const find = (pattern: RegExp) => parts.find((part) => pattern.test(part));
    const gate = find(GATE_RUN);
    if (gate !== undefined) {
        const filtered = GATE_FILTER.test(gate);
        return { kind: 'gate', operation: 'run', gate: GATE_NAME.exec(gate)?.[1] ?? null, filtered, lone };
    }
    const pr = (operation: ToolOperation): Classified => ({ kind: 'pr', operation, gate: null, filtered: null, lone });
    if (find(PUBLISH) !== undefined) return pr('publish');
    if (find(PR_CREATE) !== undefined) return pr('create');
    if (find(PR_LOOKUP) !== undefined) return pr('lookup');
    return null;
}

const NO_FIELDS = { exitCode: null, executionId: null, operationId: null, repo: null, prNumber: null, prUrl: null };

/** The PR a URL names, only when it is the job's own repository: anything else is no evidence about this job. */
function prOfUrl(url: string | null, jobRepo: string | null): Pick<ToolResult, 'repo' | 'prNumber' | 'prUrl'> | null {
    const match = url === null ? null : PR_URL.exec(url);
    if (!match || jobRepo === null || match[1]!.toLowerCase() !== jobRepo.toLowerCase()) return null;
    return { repo: match[1]!, prNumber: Number(match[2]), prUrl: url! };
}

type Fields = Omit<ToolResult, 'offset' | 'startedAt' | 'endedAt'>;
const UNKNOWN: Fields = { outcome: 'unknown', ...NO_FIELDS };
function gateResult(found: PendingResult): Fields {
    const body = jsonObjectOf(found.text);
    const exitCode = body?.exitCode;
    if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) return UNKNOWN;
    return {
        ...NO_FIELDS,
        outcome: exitCode === 0 ? 'passed' : 'failed',
        exitCode,
        executionId: uuidOrNull(body?.executionId),
    };
}

function publishResult(found: PendingResult, jobRepo: string | null): Fields {
    const body = jsonObjectOf(found.text);
    const pr = body?.published === true ? prOfUrl(asString(body.prUrl), jobRepo) : null;
    return pr ? { ...NO_FIELDS, ...pr, outcome: 'passed', operationId: uuidOrNull(body?.operationId) } : UNKNOWN;
}

function createResult(found: PendingResult, jobRepo: string | null): Fields {
    if (found.errored) return { outcome: 'failed', ...NO_FIELDS };
    const lines = found.text.split('\n').map((l) => l.trim());
    const pr = prOfUrl(lines.filter((l) => l !== '').at(-1) ?? null, jobRepo);
    return pr ? { ...NO_FIELDS, ...pr, outcome: 'passed' } : UNKNOWN;
}

function fieldsOf(call: Pick<ToolCall, 'operation' | 'lone'>, found: PendingResult, jobRepo: string | null): Fields {
    if (!call.lone) return UNKNOWN;
    if (call.operation === 'run') return gateResult(found);
    if (call.operation === 'publish') return publishResult(found, jobRepo);
    return call.operation === 'create' ? createResult(found, jobRepo) : UNKNOWN;
}

/**
 * The result a call got, classified against that call. A result is never classified on its own: what
 * its text means depends on the call, which may have been read in another chunk. `repo` is the job's
 * repository: a PR is confirmed only for that one.
 */
export function resolveResult(
    call: Pick<ToolCall, 'operation' | 'lone'>,
    found: PendingResult,
    repo: string | null
): ToolResult {
    const { startedAt, endedAt, offset } = found;
    return { ...fieldsOf(call, found, repo), startedAt, endedAt, offset };
}

const executorReading = (executor: string, chunks: readonly TranscriptChunk[]): Reading | null =>
    executor === CLAUDE_CODE ? readClaude(chunks) : executor === OPENCODE ? readOpencode(chunks) : null;

const keyOf = (session: string, id: string) => `${session}\0${id}`;

/**
 * The classified calls and the unclassified results of the chunks, each side on its own: a call and
 * its result need not sit in the same chunk. The same id seen twice (a resumed session replaying its
 * history) counts once, the first sighting winning.
 */
export function readTranscript(input: { executor: string; chunks: readonly TranscriptChunk[] }): {
    calls: ToolCall[];
    results: PendingResult[];
} {
    const reading = executorReading(input.executor, input.chunks);
    if (!reading) return { calls: [], results: [] };
    const seenCalls = new Set<string>();
    const calls: ToolCall[] = [];
    for (const call of reading.calls) {
        const k = keyOf(call.session, call.id);
        if (seenCalls.has(k)) continue;
        const classified = classifyCall(call.command);
        if (!classified) continue;
        seenCalls.add(k);
        calls.push({
            session: call.session,
            toolCallId: call.id,
            ...classified,
            startedAt: call.startedAt,
            offset: call.offset,
        });
    }
    const seenResults = new Set<string>();
    const results = reading.results.filter((found) => {
        const k = keyOf(found.session, found.toolCallId);
        if (seenResults.has(k)) return false;
        seenResults.add(k);
        return true;
    });
    return { calls, results };
}

/**
 * Every classified tool call of the chunks, each with its paired result when there is one. A result
 * is paired by (session, call id) wherever it sits in the chunks, so one delivered before its call
 * still pairs. `repo` is the job's repository: a PR is confirmed only for that one.
 */
export function classifyTranscript(input: {
    executor: string;
    chunks: readonly TranscriptChunk[];
    repo: string | null;
}): ToolActivity[] {
    const { calls, results } = readTranscript(input);
    const found = new Map(results.map((r) => [keyOf(r.session, r.toolCallId), r]));
    return calls
        .map(({ lone, ...call }): ToolActivity => {
            const pending = found.get(keyOf(call.session, call.toolCallId));
            return { ...call, result: pending ? resolveResult({ ...call, lone }, pending, input.repo) : null };
        })
        .sort((a, b) => a.offset - b.offset);
}
