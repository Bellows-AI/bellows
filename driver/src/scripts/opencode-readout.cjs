// The close-time opencode readout: one read-only query pair against the session database a
// finished run left behind — the ROOT session that ran in OPENCODE_DIR (subagents create children
// under a parent_id; the conversation a follow-up continues is the run's own root) and, from its
// messages, the finish reason of the run's last word, the context it reached, its cost, the last
// provider error it recorded, and the run's summary (the last assistant TEXT, what the run did,
// in the agent's own words). One JSON line on stdout; a failure prints one parseable error
// line — an empty answer and a broken query are otherwise indistinguishable to the parse.
//
// The same read exports the task's session records (issues #735, #767). Every read runs inside ONE
// read transaction, so the raw rows, the normalized stream and the summary line describe a single
// consistent snapshot of the database — never a live file copy, never rows from two moments. When
// EXPORT_LIMIT_BYTES is set, the lines BEFORE the final summary line are the export, each tagged
// with its `stream`:
//   raw        — every row of the session, message and part tables, verbatim
//                ({stream,table,row}): the source of truth.
//   normalized — one event per session, message and part ({stream,kind,source,...}) keeping its
//                provenance (table, row id, session, message) and carrying tool calls and usage.
// Each stream is tail-kept at EXPORT_LIMIT_BYTES at a line boundary; a stream that dropped lines
// leads with {stream,truncated:true,droppedLines}. The summary line stays the LAST line.
//
// Environment (set by the driver; paths, never credentials):
//   OPENCODE_DB  — the session database: <task volume>/.factory/opencode/<root>/opencode/opencode.db,
//                  one directory per task (thread root), so a follow-up's `--session` resumes in it.
//   OPENCODE_DIR — the working directory the run had: the scope that keeps this readout answering
//                  the root session that ran there.
//   RUN_STARTED_MS — the run's start as epoch ms. A follow-up RESUMES the root conversation, so
//                  the turn count and the summary are bounded to messages created at or after
//                  this instant — the run's own delta, never the earlier runs' turns again.
//                  Absent, the whole conversation is counted (the pre-delta shape, kept for
//                  tolerance).
//
// The role is a field INSIDE the message's data JSON, not a column: filtering it in SQL throws
// "no such column: role" on every read, and the failure reads as an empty database. Filtered
// in JS instead, where the parsed role actually is. The message text lives in `part` rows —
// one row per block, keyed by message_id — and a database whose schema predates the table (or
// otherwise refuses the summary read) costs the summary alone, never the rest of the line.
const { DatabaseSync } = require('node:sqlite');

const RUN_STARTED_MS = Number(process.env.RUN_STARTED_MS);
const SUMMARY_MAX_CHARS = 400;
const BLOCKED_MARKER = 'FACTORY_BLOCKED:';

// The agent's blocked report: the final text's LAST non-empty line, when it starts with the
// marker — read before the summary collapses the lines, so a mention mid-message never counts.
const blockedOf = (text) => {
    const last =
        text
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .pop() ?? '';
    return last.startsWith(BLOCKED_MARKER)
        ? last.slice(BLOCKED_MARKER.length).trim().slice(0, SUMMARY_MAX_CHARS)
        : null;
};

const EXPORT_LIMIT_BYTES = Number(process.env.EXPORT_LIMIT_BYTES);
const EXPORT_TABLES = ['session', 'message', 'part'];
const STREAM_RAW = 'raw';
const STREAM_NORMALIZED = 'normalized';

// A blob column has no JSON form; base64 keeps the raw row lossless.
const rawReplacer = (_key, value) =>
    value instanceof Uint8Array ? { $blob: Buffer.from(value).toString('base64') } : value;

const parseJson = (text) => {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

// The usage block opencode keeps on an assistant message and on a step-finish part.
const usageOf = (d) =>
    d && (d.tokens || typeof d.cost === 'number') ? { tokens: d.tokens ?? null, cost: d.cost ?? null } : null;

// One normalized event per part: the text, the tool call (name, call id, status, input, output)
// or the step's usage — whatever else a part is keeps its type and its own data.
const normalizePart = (p, d) => {
    const base = {
        stream: STREAM_NORMALIZED,
        source: { table: 'part', id: String(p.id), session_id: p.session_id, message_id: String(p.message_id) },
    };
    if (d.type === 'text') return { ...base, kind: 'text', text: d.text ?? null };
    if (d.type === 'tool') {
        const state = d.state ?? {};
        return {
            ...base,
            kind: 'tool',
            tool: d.tool ?? null,
            callId: d.callID ?? null,
            status: state.status ?? null,
            input: state.input ?? null,
            output: state.output ?? null,
            error: state.error ?? null,
            time: state.time ?? null,
        };
    }
    if (d.type === 'step-finish') return { ...base, kind: 'step-finish', reason: d.reason ?? null, usage: usageOf(d) };
    return { ...base, kind: d.type ?? 'unknown', data: d };
};

// The newest `limit` bytes of whole lines, with a marker line first when any were dropped.
const tailKept = (stream, lines, limit) => {
    const kept = [];
    let bytes = 0;
    let dropped = lines.length;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const size = Buffer.byteLength(lines[i] + '\n', 'utf8');
        if (bytes + size > limit && kept.length > 0) break;
        kept.unshift(lines[i]);
        bytes += size;
        dropped = i;
    }
    if (dropped > 0) kept.unshift(JSON.stringify({ stream, truncated: true, droppedLines: dropped }));
    return kept;
};

const normalizeSession = (s) => ({
    stream: STREAM_NORMALIZED,
    kind: 'session',
    source: { table: 'session', id: String(s.id), session_id: s.id },
    parentSessionId: s.parent_id ?? null,
    directory: s.directory ?? null,
    time: s.time_created ?? null,
});

const normalizeMessage = (m, d) => ({
    stream: STREAM_NORMALIZED,
    kind: 'message',
    source: { table: 'message', id: String(m.id), session_id: m.session_id },
    role: d.role ?? null,
    time: d.time ?? null,
    model: d.modelID ?? d.model?.modelID ?? null,
    provider: d.providerID ?? d.model?.providerID ?? null,
    finish: d.finish ?? null,
    usage: usageOf(d),
    error: d.error ?? null,
});

// Every row of the export tables, read inside the caller's open transaction. A table the schema
// lacks costs its own rows only.
const readRows = (db) => {
    const rows = {};
    for (const table of EXPORT_TABLES) {
        try {
            rows[table] = db.prepare(`select * from ${table} order by rowid`).all();
        } catch {
            rows[table] = [];
        }
    }
    return rows;
};

// Sessions first, then each message followed by its parts, in row order.
const normalizedLines = (rows) => {
    const lines = rows.session.map((s) => JSON.stringify(normalizeSession(s)));
    const partsOf = new Map();
    for (const p of rows.part) {
        const held = partsOf.get(String(p.message_id)) ?? [];
        held.push(p);
        partsOf.set(String(p.message_id), held);
    }
    for (const m of rows.message) {
        lines.push(JSON.stringify(normalizeMessage(m, parseJson(m.data) ?? {})));
        for (const p of partsOf.get(String(m.id)) ?? []) {
            const pd = parseJson(p.data);
            if (pd) lines.push(JSON.stringify(normalizePart(p, pd)));
        }
    }
    return lines;
};

const printExport = (db) => {
    const rows = readRows(db);
    const raw = EXPORT_TABLES.flatMap((table) =>
        rows[table].map((row) => JSON.stringify({ stream: STREAM_RAW, table, row }, rawReplacer))
    );
    for (const line of [
        ...tailKept(STREAM_RAW, raw, EXPORT_LIMIT_BYTES),
        ...tailKept(STREAM_NORMALIZED, normalizedLines(rows), EXPORT_LIMIT_BYTES),
    ]) {
        console.log(line);
    }
};

try {
    const dbPath = process.env.OPENCODE_DB;
    const dir = process.env.OPENCODE_DIR;
    if (!dbPath) throw new Error('OPENCODE_DB is not set');
    if (!dir)
        throw new Error(
            'OPENCODE_DIR is not set: the session database is per member, so a readout without a directory answers whichever task closed last'
        );
    const db = new DatabaseSync(dbPath, { readOnly: true });
    // One read transaction: the first read pins the snapshot every later read sees.
    db.exec('BEGIN');
    const s = db
        .prepare('select id from session where parent_id is null and directory = ? order by time_created desc limit 1')
        .get(dir);
    if (s && s.id) {
        const msgs = db.prepare('select id, data from message where session_id=? order by id').all(s.id);
        let finish = null;
        let tokens = 0;
        let cost = 0;
        let error = null;
        // The agent-turn count: assistant messages of the ROOT session only. Subagent
        // conversations are child sessions under a parent_id, and the session selection above
        // already excluded them — what is left here is exactly the run's own conversation.
        let turns = 0;
        // The run's assistant messages, in conversation order — the summary walks them from
        // the end once the parts are in hand.
        const assistantIds = [];
        for (const m of msgs) {
            const d = JSON.parse(m.data);
            if (d.role !== 'assistant') continue;
            // The per-run delta: a message whose own created time predates this run belongs to
            // the run (or runs) before it. A message with no usable time cannot be placed in
            // either — skipped rather than mis-booked, for the same reason a parse miss is null.
            if (!Number.isNaN(RUN_STARTED_MS)) {
                const created = d.time && typeof d.time.created === 'number' ? d.time.created : null;
                if (created === null || created < RUN_STARTED_MS) continue;
            }
            turns += 1;
            assistantIds.push(String(m.id));
            if (d.finish) finish = d.finish;
            if (d.tokens && typeof d.tokens.total === 'number') tokens = Math.max(tokens, d.tokens.total);
            if (typeof d.cost === 'number') cost += d.cost;
            // The run's last word on why it stopped — an APIError whose provider message is the
            // premature stop's cause. The LAST one wins: an error opencode retried through is
            // history, and only the final rejection explains how the run ended.
            const message = d.error && (d.error.data?.message ?? d.error.message);
            if (typeof message === 'string' && message) error = message;
        }
        let summary = null;
        let blocked = null;
        try {
            const texts = new Map();
            for (const p of db.prepare('select message_id, data from part where session_id=? order by id').all(s.id)) {
                const d = JSON.parse(p.data);
                if (d.type !== 'text' || typeof d.text !== 'string' || !d.text.trim()) continue;
                const held = texts.get(String(p.message_id));
                texts.set(String(p.message_id), held ? `${held}\n${d.text}` : d.text);
            }
            for (let i = assistantIds.length - 1; i >= 0; i -= 1) {
                const text = texts.get(assistantIds[i]);
                if (!text) continue;
                summary = text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX_CHARS);
                blocked = blockedOf(text);
                break;
            }
        } catch {
            summary = null;
            blocked = null;
        }
        if (Number.isFinite(EXPORT_LIMIT_BYTES) && EXPORT_LIMIT_BYTES > 0) printExport(db);
        console.log(JSON.stringify({ id: s.id, finish, tokens, cost, turns, summary, blocked, error }));
    } else {
        console.log(JSON.stringify({ error: `no session ran in ${dir}` }));
    }
} catch (e) {
    console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
}
