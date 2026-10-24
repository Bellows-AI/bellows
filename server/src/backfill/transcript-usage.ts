import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type DiscoveredFile, type Skip, discoverTranscripts } from './transcript-discovery.js';

/**
 * Turns discovered transcripts into deduplicated usage events. Pure: reads files, writes nothing.
 *
 * Three identities are kept apart: the physical file (`DiscoveredFile.rel`), the child
 * conversation (`conversation`, the file name) and the canonical source-selection session
 * (`sessionId`, what `session_source` chooses between OTEL and transcript for). A nested file
 * joins its parent's session only when the parent's main transcript is in the same scan; else
 * it is quarantined, never guessed. Nothing here reads an organization, task or repository from
 * a path.
 *
 * Fields verified against real local transcripts: assistant records carry `sessionId`,
 * `timestamp`, `requestId`, `message.id`, `message.model` and `message.usage`; a subagent record
 * carries its PARENT's `sessionId`. Real transcripts carry no query source; one is read only when
 * explicit at `message.usage.query_source`, `record.query_source` or `record.querySource`.
 */

export interface EventTokens {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
}

export interface UsageEvent {
    /** Stable hash, suitable for `attrs.event_id`; never derived from message content. */
    eventId: string;
    /** Canonical source-selection session. */
    sessionId: string;
    /** Child conversation (file name) the selected evidence came from. */
    conversation: string;
    /** Physical files carrying this event, sorted. */
    files: string[];
    timestamp: string;
    model: string | null;
    /** Evidenced only; null when the transcript does not say. */
    querySource: string | null;
    tokens: EventTokens;
    identity: 'message' | 'anonymous';
    /** True when no identifier exists, so distinct-looking records cannot be proven distinct or equal. */
    identityAmbiguous: boolean;
    occurrences: number;
    /** Field names whose observed values disagreed across the merged records. */
    conflicts: string[];
}

export interface QuarantinedFile {
    rel: string;
    reason: 'parent-not-in-scan' | 'parent-session-unresolved';
    layoutParent: string;
    records: number;
}

export interface FileReport {
    rel: string;
    conversation: string;
    layout: DiscoveredFile['layout'];
    malformedLines: number;
    truncatedTail: boolean;
    usageRecords: number;
}

export interface TranscriptScan {
    events: UsageEvent[];
    quarantined: QuarantinedFile[];
    files: FileReport[];
    skipped: Skip[];
    /** Records dropped for having no valid timestamp or no usable token field. */
    droppedRecords: number;
    /** False after any unreadable or refused entry: a destructive caller must not replace on this. */
    complete: boolean;
}

interface Observation {
    key: string | null;
    requestId: string | null;
    /** A nested file's record named a session other than its resolved parent's. */
    sessionConflict: boolean;
    sessionId: string;
    conversation: string;
    rel: string;
    timestamp: string;
    model: string | null;
    querySource: string | null;
    tokens: EventTokens;
    invalid: string[];
}

const sha = (...parts: string[]): string => createHash('sha256').update(parts.join('\u0000')).digest('hex');
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const token = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);

/** Parsed lines of a transcript; an unparseable line is counted, never fatal. */
export function parseTranscriptText(text: string): {
    records: Record<string, unknown>[];
    malformed: number;
    truncatedTail: boolean;
} {
    const lines = text.split('\n');
    const records: Record<string, unknown>[] = [];
    let malformed = 0;
    let truncatedTail = false;
    lines.forEach((line, i) => {
        if (line.trim() === '') return;
        try {
            const parsed: unknown = JSON.parse(line);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                records.push(parsed as Record<string, unknown>);
                return;
            }
            malformed += 1;
        } catch {
            malformed += 1;
            // The last line with no newline after it is a write cut short.
            if (i === lines.length - 1) truncatedTail = true;
        }
    });
    return { records, malformed, truncatedTail };
}

const obj = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function observe(
    record: Record<string, unknown>,
    fallbackSession: string,
    conversation: string,
    rel: string
): Observation | 'drop' | null {
    if (record.type !== 'assistant') return null;
    const message = obj(record.message);
    const usage = obj(message?.usage);
    if (!message || !usage) return null;
    const at = typeof record.timestamp === 'string' ? new Date(record.timestamp) : null;
    const fields = {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
    };
    const invalid = Object.entries(fields)
        .filter(([, v]) => v !== undefined && v !== null && token(v) === null)
        .map(([k]) => `invalid:${k}`);
    const tokens: EventTokens = {
        input: token(fields.input_tokens),
        output: token(fields.output_tokens),
        cacheRead: token(fields.cache_read_input_tokens),
        cacheWrite: token(fields.cache_creation_input_tokens),
    };
    if (!at || Number.isNaN(at.getTime()) || Object.values(tokens).every((v) => v === null)) return 'drop';
    const sessionId = str(record.sessionId) ?? fallbackSession;
    const model = str(message.model);
    const querySource = str(usage.query_source) ?? str(record.query_source) ?? str(record.querySource);
    const timestamp = at.toISOString();
    const messageId = str(message.id);
    const requestId = str(record.requestId);
    return {
        key: messageId === null ? null : sha('message', messageId),
        requestId,
        sessionConflict: false,
        sessionId,
        conversation,
        rel,
        timestamp,
        model,
        querySource,
        tokens,
        invalid,
    };
}

/** Byte-equivalent normalized usage: same session, instant, model, source and four token values. */
const fingerprintOf = (o: Observation): string =>
    sha(
        'usage',
        o.sessionId,
        o.timestamp,
        o.model ?? '',
        o.querySource ?? '',
        ...[o.tokens.input, o.tokens.output, o.tokens.cacheRead, o.tokens.cacheWrite].map((v) =>
            v === null ? 'null' : String(v)
        )
    );

const TOKEN_KEYS: (keyof EventTokens)[] = ['output', 'input', 'cacheRead', 'cacheWrite'];

/** Orders evidence: more output, then more of the other types, then earliest timestamp, then fingerprint. */
function compareEvidence(a: Observation, b: Observation): number {
    for (const key of TOKEN_KEYS) {
        const x = a.tokens[key] ?? -1;
        const y = b.tokens[key] ?? -1;
        if (x !== y) return y - x;
    }
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    const [x, y] = [fingerprintOf(a), fingerprintOf(b)];
    return x < y ? -1 : x > y ? 1 : 0;
}

function merge(group: Observation[]): UsageEvent {
    const selected = [...group].sort(compareEvidence)[0] as Observation;
    const identified = selected.key !== null;
    const maxOf = (key: keyof EventTokens): number | null => {
        const seen = group.map((o) => o.tokens[key]).filter((v): v is number => v !== null);
        return seen.length === 0 ? null : Math.max(...seen);
    };
    const differs = (pick: (o: Observation) => string | number | null): boolean => new Set(group.map(pick)).size > 1;
    const conflicts = [
        differs((o) => o.model) && 'model',
        differs((o) => o.querySource) && 'query_source',
        differs((o) => o.timestamp) && 'timestamp',
        differs((o) => o.requestId) && 'request_id',
        group.some((o) => o.sessionConflict) && 'session_id',
        ...group.flatMap((o) => o.invalid),
    ].filter((c): c is string => typeof c === 'string');
    return {
        eventId: identified
            ? sha('event', selected.sessionId, selected.key as string)
            : sha('event', fingerprintOf(selected)),
        sessionId: selected.sessionId,
        conversation: selected.conversation,
        files: [...new Set(group.map((o) => o.rel))].sort(),
        timestamp: selected.timestamp,
        model: selected.model,
        querySource: selected.querySource,
        tokens: {
            input: maxOf('input'),
            output: maxOf('output'),
            cacheRead: maxOf('cacheRead'),
            cacheWrite: maxOf('cacheWrite'),
        },
        identity: identified ? 'message' : 'anonymous',
        identityAmbiguous: !identified,
        occurrences: group.length,
        conflicts: [...new Set(conflicts)].sort(),
    };
}

interface Parsed {
    file: DiscoveredFile;
    list: Observation[];
}

/** Read and parse every discovered file; an unreadable one is reported and the scan marked incomplete. */
function readAll(discovery: ReturnType<typeof discoverTranscripts>): {
    parsed: Parsed[];
    files: FileReport[];
    skipped: Skip[];
    droppedRecords: number;
    complete: boolean;
} {
    const out = {
        parsed: [] as Parsed[],
        files: [] as FileReport[],
        skipped: [...discovery.skipped],
        droppedRecords: 0,
        complete: discovery.complete,
    };
    for (const file of discovery.files) {
        let text: string;
        try {
            text = readFileSync(file.path, 'utf8');
        } catch {
            out.skipped.push({ rel: file.rel, reason: 'unreadable-entry' });
            out.complete = false;
            continue;
        }
        const p = parseTranscriptText(text);
        const observations = p.records.map((r) => observe(r, file.conversation, file.conversation, file.rel));
        out.droppedRecords += observations.filter((o) => o === 'drop').length;
        const list = observations.filter((o): o is Observation => o !== null && o !== 'drop');
        out.parsed.push({ file, list });
        out.files.push({
            rel: file.rel,
            conversation: file.conversation,
            layout: file.layout,
            malformedLines: p.malformed,
            truncatedTail: p.truncatedTail,
            usageRecords: list.length,
        });
    }
    return out;
}

/** Each main transcript's session: the one session its records name (null when they name several). */
function mainSessions(parsed: Parsed[]): Map<string, string | null> {
    const out = new Map<string, string | null>();
    for (const { file, list } of parsed.filter((p) => p.file.layout === 'project')) {
        const sessions = [...new Set(list.map((o) => o.sessionId))];
        const resolved =
            sessions.length === 0 ? file.conversation : sessions.length === 1 ? (sessions[0] ?? null) : null;
        out.set(`${file.project}/${file.conversation}`, resolved);
    }
    return out;
}

/** Observations safe to count, with nested files joined to a proven parent or quarantined. */
function attachNested(parsed: Parsed[]): { accepted: Observation[]; quarantined: QuarantinedFile[] } {
    const mains = mainSessions(parsed);
    const accepted: Observation[] = [];
    const quarantined: QuarantinedFile[] = [];
    for (const { file, list } of parsed) {
        if (file.layout === 'project') {
            accepted.push(...list);
            continue;
        }
        const layoutParent = file.layoutParent as string;
        const parent = mains.get(`${file.project}/${layoutParent}`);
        if (typeof parent === 'string') {
            // Joined to the parent's session so an OTEL-covered parent is never supplemented.
            accepted.push(...list.map((o) => ({ ...o, sessionConflict: o.sessionId !== parent, sessionId: parent })));
            continue;
        }
        const reason = parent === undefined ? 'parent-not-in-scan' : 'parent-session-unresolved';
        quarantined.push({ rel: file.rel, reason, layoutParent, records: list.length });
    }
    quarantined.sort((a, b) => (a.rel < b.rel ? -1 : 1));
    return { accepted, quarantined };
}

/** Discover under `root`, parse, attach nested files to proven parents, dedupe into events. */
export function scanTranscripts(root: string): TranscriptScan {
    const read = readAll(discoverTranscripts(root));
    const { accepted, quarantined } = attachNested(read.parsed);
    const groups = new Map<string, Observation[]>();
    for (const o of accepted) {
        // An identified key is scoped to the session; an anonymous record groups by byte-equivalent usage.
        const k = o.key === null ? sha('anon', fingerprintOf(o)) : sha('id', o.sessionId, o.key);
        groups.set(k, [...(groups.get(k) ?? []), o]);
    }
    const events = [...groups.values()]
        .map(merge)
        .sort((a, b) =>
            a.timestamp !== b.timestamp ? (a.timestamp < b.timestamp ? -1 : 1) : a.eventId < b.eventId ? -1 : 1
        );
    return {
        events,
        quarantined,
        files: read.files,
        skipped: read.skipped,
        droppedRecords: read.droppedRecords,
        complete: read.complete,
    };
}
