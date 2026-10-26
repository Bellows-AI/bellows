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
    /** Byte offset of the record that carried the result, in the stream. */
    offset: number;
}

export interface ToolActivity {
    session: string;
    toolCallId: string;
    kind: ToolKind;
    operation: ToolOperation;
    gate: string | null;
    filtered: boolean | null;
    /** Byte offset of the record that carried the call, in the stream. */
    offset: number;
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
}

interface RawResult {
    session: string;
    id: string;
    text: string;
    errored: boolean;
    offset: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)$/;
const GATE_RUN = /\$\{?BELLOWS_GATE_URL\}?\/run\b/;
const GATE_NAME = /\\?"gate\\?"\s*:\s*\\?"([A-Za-z0-9_.:-]+)/;
const GATE_FILTER = /\\?"filter\\?"\s*:/;
const PUBLISH = /control\.sock\b[^|;&]*\/publish\b/;
const PR_CREATE = /\bgh\s+pr\s+create\b/;
const PR_LOOKUP = /\bgh\s+pr\s+(?:view|list)\b/;

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const asString = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

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
    results: RawResult[];
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
function claudeBlock(raw: unknown, at: { session: string; offset: number }, into: Reading): void {
    const block = asRecord(raw);
    if (block?.type === 'tool_use' && block.name === 'Bash') {
        const id = asString(block.id);
        const command = asString(asRecord(block.input)?.command);
        if (id && command) into.calls.push({ ...at, id, command });
        return;
    }
    const id = block?.type === 'tool_result' ? asString(block.tool_use_id) : null;
    if (id) into.results.push({ ...at, id, text: textOfContent(block?.content), errored: block?.is_error === true });
}

/** Claude jsonl: `tool_use` blocks of an assistant record, `tool_result` blocks of a user record, paired by id. */
function readClaude(chunks: readonly TranscriptChunk[]): Reading {
    const reading: Reading = { calls: [], results: [] };
    for (const line of linesOf(chunks)) {
        const record = asRecord(parseJson(line.text));
        const session = asString(record?.sessionId);
        const content = asRecord(record?.message)?.content;
        if (!session || !Array.isArray(content)) continue;
        for (const block of content) claudeBlock(block, { session, offset: line.offset }, reading);
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
        const at = { session, id, offset: line.offset };
        const command = asString(asRecord(state.input)?.command);
        if (command) reading.calls.push({ ...at, command });
        if (state.status !== 'completed' && state.status !== 'error') continue;
        const exit = asRecord(state.metadata)?.exit;
        const errored = state.status === 'error' || (typeof exit === 'number' && exit !== 0);
        reading.results.push({ ...at, text: asString(state.output) ?? asString(state.error) ?? '', errored });
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

type Classified = Pick<ToolActivity, 'kind' | 'operation' | 'gate' | 'filtered'>;

function classifyCall(command: string): Classified | null {
    if (GATE_RUN.test(command)) {
        return {
            kind: 'gate',
            operation: 'run',
            gate: GATE_NAME.exec(command)?.[1] ?? null,
            filtered: GATE_FILTER.test(command),
        };
    }
    const pr = (operation: ToolOperation): Classified => ({ kind: 'pr', operation, gate: null, filtered: null });
    if (PUBLISH.test(command)) return pr('publish');
    if (PR_CREATE.test(command)) return pr('create');
    if (PR_LOOKUP.test(command)) return pr('lookup');
    return null;
}

const NO_FIELDS = { exitCode: null, executionId: null, operationId: null, repo: null, prNumber: null, prUrl: null };

/** The PR a URL names, only when it is the job's own repository: anything else is no evidence about this job. */
function prOfUrl(url: string | null, jobRepo: string | null): Pick<ToolResult, 'repo' | 'prNumber' | 'prUrl'> | null {
    const match = url === null ? null : PR_URL.exec(url);
    if (!match || jobRepo === null || match[1]!.toLowerCase() !== jobRepo.toLowerCase()) return null;
    return { repo: match[1]!, prNumber: Number(match[2]), prUrl: url! };
}

type Fields = Omit<ToolResult, 'offset'>;
const UNKNOWN: Fields = { outcome: 'unknown', ...NO_FIELDS };

function gateResult(found: RawResult): Fields {
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

function publishResult(found: RawResult, jobRepo: string | null): Fields {
    const body = jsonObjectOf(found.text);
    const pr = body?.published === true ? prOfUrl(asString(body.prUrl), jobRepo) : null;
    return pr ? { ...NO_FIELDS, ...pr, outcome: 'passed', operationId: uuidOrNull(body?.operationId) } : UNKNOWN;
}

function createResult(found: RawResult, jobRepo: string | null): Fields {
    if (found.errored) return { outcome: 'failed', ...NO_FIELDS };
    const lines = found.text.split('\n').map((l) => l.trim());
    const pr = prOfUrl(lines.filter((l) => l !== '').at(-1) ?? null, jobRepo);
    return pr ? { ...NO_FIELDS, ...pr, outcome: 'passed' } : UNKNOWN;
}

function resultOf(operation: ToolOperation, found: RawResult, jobRepo: string | null): Fields {
    if (operation === 'run') return gateResult(found);
    if (operation === 'publish') return publishResult(found, jobRepo);
    return operation === 'create' ? createResult(found, jobRepo) : UNKNOWN;
}

/**
 * Every classified tool call of the chunks, each with its paired result when there is one. A result
 * is paired by (session, call id) wherever it sits in the stream, so one delivered before its call
 * still pairs; the same id seen twice (a resumed session replaying its history) counts once, the
 * first sighting winning. `repo` is the job's repository: a PR is confirmed only for that one.
 */
export function classifyTranscript(input: {
    executor: string;
    chunks: readonly TranscriptChunk[];
    repo: string | null;
}): ToolActivity[] {
    const { executor, chunks, repo } = input;
    const reading = executor === CLAUDE_CODE ? readClaude(chunks) : executor === OPENCODE ? readOpencode(chunks) : null;
    if (!reading) return [];
    const key = (session: string, id: string) => `${session}\0${id}`;
    const results = new Map<string, RawResult>();
    for (const found of reading.results)
        if (!results.has(key(found.session, found.id))) results.set(key(found.session, found.id), found);
    const seen = new Set<string>();
    const activities: ToolActivity[] = [];
    for (const call of reading.calls) {
        const k = key(call.session, call.id);
        if (seen.has(k)) continue;
        const classified = classifyCall(call.command);
        if (!classified) continue;
        seen.add(k);
        const found = results.get(k);
        activities.push({
            session: call.session,
            toolCallId: call.id,
            ...classified,
            offset: call.offset,
            result: found ? { ...resultOf(classified.operation, found, repo), offset: found.offset } : null,
        });
    }
    return activities.sort((a, b) => a.offset - b.offset);
}
