// The continuous claude-code transcript exporter: runs beside the agent as its own container of the
// run's pod (docker: its container group), under the task supervisor, over the same volume, tails every session file under
// <CLAUDE_TRANSCRIPT_DIR>/projects and uploads byte-range chunks of it, cut at record boundaries,
// through the driver's run-control channel (the driver relays them to the board's chunk route).
// The raw files on the volume are the spool: nothing is ever dropped, an unacknowledged byte just
// stays on disk and is retried.
//
// Environment (set by the driver; paths and literals, no credential):
//   CLAUDE_TRANSCRIPT_DIR  — the thread's transcript directory (the runner's CLAUDE_CONFIG_DIR).
//   EXPORT_CONTROL_SOCKET  — the task supervisor's relay socket in FACTORY_EXPORT_DIR: it adds this
//                            exporter's token and follows whichever driver holds the run (issue #829),
//                            so this process holds no credential. A socket not there yet is retried.
//   BELLOWS_CONTROL_URL / BELLOWS_CONTROL_TOKEN — one-shot mode only (a review's close-time export,
//                            run by the holder itself): the endpoint and the token it issued.
//   RUN_STARTED_AT         — ISO instant the attempt began; the earliest one on the volume is kept in
//                            <CLAUDE_TRANSCRIPT_DIR>/export-floor.json. An unseen file that existed
//                            before that floor is a resumed session: only what is appended past its
//                            size at first sight is exported (offsets stay the file's own byte offsets).
//   EXPORT_FLUSH_BYTES / EXPORT_FLUSH_MS — flush at this much pending, or this long after the
//                            oldest unflushed byte.
//   EXPORT_SPOOL_MAX_BYTES — unacknowledged bytes allowed before `spoolFull` is reported.
//   EXPORT_RECORD_MAX_BYTES — a record above this is cut and its stream marked truncated.
//   FACTORY_EXPORT_DIR     — the directory only the supervisor and this exporter mount: the supervisor's
//                            `drain.json` and `supervisor.alive` in, this exporter's `status.json` out.
//   EXPORT_ONCE            — 'complete' or 'partial': the one-shot mode, with EXPORT_ONCE_CAUSE as the
//                            terminal cause. No FACTORY_EXPORT_DIR is read or written in it.
//   EXPORT_SUPERVISOR_LOST_MS — a supervisor heartbeat older than this drains the exporter by itself,
//                            partial with cause `supervisor_lost`: the bytes stay on the volume either way.
//   EXPORT_POLL_MS, EXPORT_GIVEUP_MS — the tick, and how long a dead endpoint is tolerated.
//   EXPORT_REQUEST_TIMEOUT_MS — one request's bound, plus a second per MiB it carries (the driver
//                            relays a chunk to the board before it answers): a vanished driver never answers.
//   EXPORT_DRAIN_GIVEUP_MS — once drained, how long an unreachable driver is tolerated before the
//                            exporter ends with its bytes left on the volume for the next claim.
//
// Protocol (all keyed by the token the relay, or the one-shot's env, supplies): PUT /export/chunk?session&offset (raw bytes) -> 200 stored, 413
// refused {cause}, 409/400 permanent, 5xx retry; PUT /export/manifest (json) closes a session; POST
// /export/state reports the vitals. `drain.json` ({state, cause}, written by the supervisor) says the
// agent is gone: flush everything, close every session's manifest, report `done`, exit 0. A token the
// endpoint no longer knows, or an endpoint dead past the give-up window, ends the exporter too.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const KIB = 1024;
const MIB = KIB * KIB;
const MS_PER_MINUTE = 60_000;
const DEFAULT_FLUSH_KIB = 256;
const DEFAULT_FLUSH_MS = 15_000;
const DEFAULT_SPOOL_BYTES = KIB * MIB;
const DEFAULT_RECORD_MIB = 64;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_GIVEUP_MINUTES = 10;
const READ_MIB = 4;
const STATE_MS = 5000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_MAX_STEP = 8;
const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_CONFLICT = 409;
const STATUS_REFUSED = 413;
const STATUS_SERVER_ERROR = 500;
const EXIT_FAILED = 1;
const EXIT_UNAUTHORIZED = 3;
const EXIT_GAVE_UP = 4;
const DEFAULT_SUPERVISOR_LOST_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MS_PER_MIB = 1000;
const DEFAULT_DRAIN_GIVEUP_MS = 90_000;
const EXIT_OK = 0;
const NEWLINE = 0x0a;
const SESSION = /^[A-Za-z0-9._-]{1,128}$/;

const positive = (name, fallback) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};
const DIR = process.env.CLAUDE_TRANSCRIPT_DIR;
const EXPORT_DIR = process.env.FACTORY_EXPORT_DIR;
// One-shot mode (a review's close-time export, issue #774): no mailbox and no drain order. The
// closing state and cause come from the env, and the exporter drains what is there, closes and exits.
const ONCE = process.env.EXPORT_ONCE;
const CONTROL_SOCKET = process.env.EXPORT_CONTROL_SOCKET;
const CONTROL_URL = process.env.BELLOWS_CONTROL_URL;
const TOKEN = process.env.BELLOWS_CONTROL_TOKEN;
const STARTED_MS = Date.parse(process.env.RUN_STARTED_AT ?? '');
let FLOOR_MS = STARTED_MS;
const FLUSH_BYTES = positive('EXPORT_FLUSH_BYTES', DEFAULT_FLUSH_KIB * KIB);
const FLUSH_MS = positive('EXPORT_FLUSH_MS', DEFAULT_FLUSH_MS);
const SPOOL_MAX = positive('EXPORT_SPOOL_MAX_BYTES', DEFAULT_SPOOL_BYTES);
const RECORD_MAX = positive('EXPORT_RECORD_MAX_BYTES', DEFAULT_RECORD_MIB * MIB);
const POLL_MS = positive('EXPORT_POLL_MS', DEFAULT_POLL_MS);
const SUPERVISOR_LOST_MS = positive('EXPORT_SUPERVISOR_LOST_MS', DEFAULT_SUPERVISOR_LOST_MS);
const GIVEUP_MS = positive('EXPORT_GIVEUP_MS', DEFAULT_GIVEUP_MINUTES * MS_PER_MINUTE);
const REQUEST_TIMEOUT_MS = positive('EXPORT_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS);
const DRAIN_GIVEUP_MS = positive('EXPORT_DRAIN_GIVEUP_MS', DEFAULT_DRAIN_GIVEUP_MS);
const READ_BYTES = READ_MIB * MIB;
// Bytes read ahead of the acknowledged point: past this the file itself is the spool and reading pauses.
const HELD_MAX = 2 * RECORD_MAX;

const tracks = new Map();
const startedAt = new Date().toISOString();
const progress = {
    drain: null,
    lastStateAt: 0,
    lastReported: '',
    outageSince: null,
    unreachableSince: null,
    spoolFull: false,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const UNREACHABLE = { status: 0, json: {} };

// One request, answered or not within its bound: a connect to a vanished pod IP never fails by itself.
const send = (method, target, body) =>
    new Promise((resolve) => {
        let settled = false;
        let req = null;
        const settle = (answer) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(answer);
        };
        const bytes = body ? Buffer.byteLength(body) : 0;
        const timer = setTimeout(
            () => {
                settle(UNREACHABLE);
                req?.destroy();
            },
            REQUEST_TIMEOUT_MS + Math.ceil(bytes / MIB) * MS_PER_MIB
        );
        // Over the relay socket the exporter sends no credential: the supervisor attaches the token.
        const headers = CONTROL_SOCKET ? {} : { authorization: `Bearer ${TOKEN}` };
        if (body) headers['content-length'] = bytes;
        const onResponse = (res) => {
            // A response cut by the timer's destroy errors here, not on the request.
            res.on('error', () => settle(UNREACHABLE));
            const parts = [];
            res.on('data', (part) => parts.push(part));
            res.on('end', () => {
                let json = {};
                try {
                    json = JSON.parse(Buffer.concat(parts).toString('utf8'));
                } catch {
                    json = {};
                }
                settle({ status: res.statusCode ?? 0, json });
            });
        };
        req = CONTROL_SOCKET
            ? http.request({ socketPath: CONTROL_SOCKET, path: target, method, headers }, onResponse)
            : http.request(new URL(target, CONTROL_URL), { method, headers }, onResponse);
        req.on('error', () => settle(UNREACHABLE));
        if (body) req.write(body);
        req.end();
    });

// One call, with the clocks the give-up windows read: a dead endpoint starts the outage, a driver
// that did not answer at all (from when the request was sent) the unreachable one; an answer stops each.
const request = async (method, target, body) => {
    const sentAt = Date.now();
    const answer = await send(method, target, body);
    const dead = answer.status === 0 || answer.status >= STATUS_SERVER_ERROR;
    progress.outageSince = dead ? (progress.outageSince ?? Date.now()) : null;
    progress.unreachableSince = answer.status === 0 ? (progress.unreachableSince ?? sentAt) : null;
    return answer;
};

const bail = (code) => {
    writeStatus({ done: true, gone: true });
    process.exit(code);
};

// Drained, and the driver has not answered for the drain window: it is gone, and so is everyone the
// manifests were for. The saved offsets and unsent bytes stay on the volume for the next claim.
const abandonDrain = () => {
    if (
        progress.drain &&
        progress.unreachableSince !== null &&
        Date.now() - progress.unreachableSince > DRAIN_GIVEUP_MS
    ) {
        bail(EXIT_OK);
    }
};

const statePath = (session) => path.join(DIR, 'export-state', `${session}.json`);

// Null only when there is no state; one that is there but unreadable or misshapen says `unreadable`.
const loadState = (session) => {
    let state;
    try {
        state = JSON.parse(fs.readFileSync(statePath(session), 'utf8'));
    } catch (e) {
        return e?.code === 'ENOENT' ? null : { unreadable: true };
    }
    return ['ino', 'base', 'acked'].every((key) => Number.isFinite(state?.[key])) ? state : { unreadable: true };
};

const saveState = (track) => {
    const file = statePath(track.session);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const state = { ino: track.ino, base: track.base, acked: track.acked, stopCause: track.stopCause };
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
};

const listJsonl = (dir) => {
    try {
        return fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    } catch {
        return [];
    }
};

// Every session file the CLI keeps: projects/<dir>/<session>.jsonl and, in the newer layout, its
// subagents' own files under projects/<dir>/<session>/subagents/. Each is a session of its own.
const discover = () => {
    const projects = path.join(DIR, 'projects');
    const found = [];
    let dirs = [];
    try {
        dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
        return found;
    }
    for (const dir of dirs) {
        const root = path.join(projects, dir.name);
        for (const name of listJsonl(root)) found.push(path.join(root, name));
        let entries = [];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
        } catch {
            entries = [];
        }
        for (const entry of entries) {
            const sub = path.join(root, entry.name, 'subagents');
            for (const name of listJsonl(sub)) found.push(path.join(sub, name));
        }
    }
    return found;
};

const blankTrack = (file, fd, stat) => ({
    file,
    fd,
    session: path.basename(file, '.jsonl'),
    ino: stat.ino,
    base: 0,
    pos: 0,
    acked: 0,
    size: stat.size,
    stopCause: null,
    permanent: false,
    rotations: 0,
    truncated: false,
    held: Buffer.alloc(0),
    inflight: null,
    since: null,
    retryAt: 0,
    failures: 0,
});

// The start of the first attempt any exporter served on this volume, kept on the volume itself. Every
// file an exporter sees gets a saved state at once, so an unseen file born after this was never seen:
// its attempt's pod was lost before a scan reached it, and none of its bytes were exported.
const floorPath = () => path.join(DIR, 'export-floor.json');

// A floor that is there but unreadable is left alone and proves nothing: every unseen file is then
// exported whole, since a byte sent twice is harmless and a byte skipped is lost.
const volumeFloor = () => {
    if (Number.isNaN(STARTED_MS)) return STARTED_MS;
    try {
        const saved = JSON.parse(fs.readFileSync(floorPath(), 'utf8')).startedMs;
        return Number.isFinite(saved) ? Math.min(saved, STARTED_MS) : Number.NEGATIVE_INFINITY;
    } catch (e) {
        if (e?.code !== 'ENOENT') return Number.NEGATIVE_INFINITY;
    }
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(`${floorPath()}.tmp`, JSON.stringify({ startedMs: STARTED_MS }));
    fs.renameSync(`${floorPath()}.tmp`, floorPath());
    return STARTED_MS;
};

// Where an unseen file starts. A file born since the volume's first exported attempt is exported
// whole; one that predates it is a resumed session whose existing bytes belong to earlier attempts.
const firstSight = (track, stat) => {
    const born = stat.birthtimeMs > 0 ? stat.birthtimeMs : Number.POSITIVE_INFINITY;
    const fresh = Number.isNaN(FLOOR_MS) || born >= FLOOR_MS;
    track.pos = fresh ? 0 : stat.size;
    track.acked = track.pos;
    saveState(track);
};

const open = (file) => {
    if (!SESSION.test(path.basename(file, '.jsonl'))) return null;
    let fd;
    try {
        fd = fs.openSync(file, 'r');
    } catch {
        return null;
    }
    const stat = fs.fstatSync(fd);
    const track = blankTrack(file, fd, stat);
    const saved = loadState(track.session);
    if (saved?.unreadable) {
        // Where the last exporter stopped is unknown: the file again, whole, rather than a byte skipped.
        saveState(track);
    } else if (saved && saved.ino === stat.ino) {
        // A restarted exporter resumes at the acknowledged point; nothing past it was lost, it is on disk.
        track.base = saved.base;
        track.acked = saved.acked;
        track.pos = saved.acked - saved.base;
        track.stopCause = saved.stopCause ?? null;
    } else {
        firstSight(track, stat);
    }
    return track;
};

const unacked = (track) =>
    track.size - track.pos + track.held.length + (track.inflight ? track.inflight.body.length : 0);

const heldBytes = (track) => track.held.length + (track.inflight ? track.inflight.body.length : 0);

// Reads what the file has grown by into `held`.
const growHeld = (track) => {
    while (track.pos < track.size && heldBytes(track) < HELD_MAX) {
        const buf = Buffer.alloc(Math.min(READ_BYTES, track.size - track.pos));
        const n = fs.readSync(track.fd, buf, 0, buf.length, track.pos);
        if (n <= 0) break;
        if (track.held.length === 0 && !track.inflight) track.since = Date.now();
        track.held = Buffer.concat([track.held, buf.subarray(0, n)]);
        track.pos += n;
    }
};

// Drained to this file's end: if the path now names another file, this one was rotated away (its
// descriptor stayed valid, so every byte of it has been read) and the new one follows.
const followRotation = (track) => {
    let now;
    try {
        now = fs.statSync(track.file);
    } catch {
        return;
    }
    if (now.ino === track.ino) return;
    fs.closeSync(track.fd);
    track.fd = fs.openSync(track.file, 'r');
    track.base += track.pos;
    track.pos = 0;
    track.ino = now.ino;
    track.size = fs.fstatSync(track.fd).size;
    track.rotations += 1;
};

const readMore = (track) => {
    let stat;
    try {
        stat = fs.fstatSync(track.fd);
    } catch {
        return;
    }
    if (stat.size < track.pos) {
        // Truncated in place: whatever was past the cut is gone from the file, what was read is kept.
        track.base += track.pos;
        track.pos = 0;
        track.rotations += 1;
    }
    track.size = stat.size;
    growHeld(track);
    if (track.pos >= track.size) followRotation(track);
};

// How much of `held` the next chunk takes: whole records only, up to FLUSH_BYTES (a larger record is
// its own chunk, and one above RECORD_MAX is cut), or 0 when nothing is due yet.
const chunkEnd = (track, force) => {
    const held = track.held;
    let whole = held.lastIndexOf(NEWLINE) + 1;
    if (whole === 0 && held.length >= RECORD_MAX) {
        whole = RECORD_MAX;
        track.truncated = true;
    }
    const due = whole >= FLUSH_BYTES || Date.now() - track.since >= FLUSH_MS || force;
    if (whole === 0 || !due) return 0;
    let end = whole;
    if (whole > FLUSH_BYTES) {
        const back = held.lastIndexOf(NEWLINE, FLUSH_BYTES - 1);
        end = back >= 0 ? back + 1 : held.indexOf(NEWLINE) + 1 || whole;
    }
    if (end > RECORD_MAX) {
        end = RECORD_MAX;
        track.truncated = true;
    }
    return end;
};

const cut = (track, force) => {
    if (track.inflight || track.held.length === 0) return;
    const end = chunkEnd(track, force);
    if (end === 0) return;
    const offset = track.base + track.pos - track.held.length;
    track.inflight = { offset, body: track.held.subarray(0, end) };
    track.held = track.held.subarray(end);
};

const ack = (track) => {
    track.acked = track.inflight.offset + track.inflight.body.length;
    track.inflight = null;
    track.since = unacked(track) > 0 ? Date.now() : null;
    saveState(track);
};

const stopStream = (track, answer) => {
    // A cap refusal is the board's say-so, anything else is permanent: either way the bytes stay on
    // the volume, the stream stops uploading, and the manifest says why.
    track.stopCause = typeof answer.json.cause === 'string' ? answer.json.cause : 'upload_rejected';
    track.permanent = answer.status !== STATUS_REFUSED;
    ack(track);
};

const retryLater = (track) => {
    track.failures += 1;
    track.retryAt =
        Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(track.failures, BACKOFF_MAX_STEP));
};

const upload = async (track) => {
    if (!track.inflight || Date.now() < track.retryAt) return;
    if (track.stopCause) {
        ack(track);
        return;
    }
    const query = new URLSearchParams({ session: track.session, offset: String(track.inflight.offset) });
    const answer = await request('PUT', `/export/chunk?${query}`, track.inflight.body);
    if (answer.status === STATUS_OK) {
        track.failures = 0;
        ack(track);
    } else if (answer.status === STATUS_UNAUTHORIZED) {
        bail(EXIT_UNAUTHORIZED);
    } else if ([STATUS_REFUSED, STATUS_CONFLICT, STATUS_BAD_REQUEST].includes(answer.status)) {
        stopStream(track, answer);
    } else {
        retryLater(track);
    }
};

const vitals = () => {
    let pendingBytes = 0;
    let oldest = null;
    for (const track of tracks.values()) {
        const bytes = unacked(track);
        if (bytes === 0) continue;
        pendingBytes += bytes;
        const since = track.since ?? Date.now();
        oldest = oldest === null ? since : Math.min(oldest, since);
    }
    return { pendingBytes, oldestUnackedMs: oldest === null ? 0 : Math.max(0, Date.now() - oldest) };
};

const report = async (done) => {
    const { pendingBytes, oldestUnackedMs } = vitals();
    const spoolFull = pendingBytes > SPOOL_MAX;
    progress.spoolFull = spoolFull;
    const key = JSON.stringify({ spoolFull, done });
    const quiet = key === progress.lastReported && Date.now() - progress.lastStateAt < STATE_MS;
    if (!done && quiet) return;
    progress.lastStateAt = Date.now();
    progress.lastReported = key;
    const answer = await request(
        'POST',
        '/export/state',
        JSON.stringify({ pendingBytes, oldestUnackedMs, spoolFull, done })
    );
    // The endpoint no longer knows the token: the attempt is over, and nothing here can reach the board again.
    if (answer.status === STATUS_UNAUTHORIZED) bail(EXIT_UNAUTHORIZED);
};

// One session's closing record: what the drain says, unless the stream itself ended another way.
const manifestOf = (track) => {
    const { drain } = progress;
    let state = drain.state;
    let terminalCause = drain.cause;
    if (track.truncated) {
        state = 'truncated';
        terminalCause = 'record_cap';
    } else if (track.stopCause) {
        state = track.permanent ? 'partial' : 'truncated';
        terminalCause = track.stopCause;
    } else if (track.held.length > 0) {
        // A trailing record with no newline: written partially, never uploaded.
        state = 'partial';
        terminalCause = terminalCause ?? 'partial_trailing_record';
    }
    const finishedAt = new Date().toISOString();
    return JSON.stringify({ session: track.session, state, terminalCause, startedAt, finishedAt });
};

const finalize = async () => {
    for (const track of tracks.values()) {
        const manifest = manifestOf(track);
        let answer = await request('PUT', '/export/manifest', manifest);
        while (answer.status === 0 || answer.status >= STATUS_SERVER_ERROR) {
            abandonDrain();
            if (progress.outageSince !== null && Date.now() - progress.outageSince > GIVEUP_MS) bail(EXIT_GAVE_UP);
            await sleep(POLL_MS);
            answer = await request('PUT', '/export/manifest', manifest);
        }
        if (answer.status === STATUS_UNAUTHORIZED) bail(EXIT_UNAUTHORIZED);
    }
};

const tick = async () => {
    for (const file of discover()) {
        if (tracks.has(file)) continue;
        const track = open(file);
        if (track) tracks.set(file, track);
    }
    const force = progress.drain !== null;
    for (const track of tracks.values()) {
        readMore(track);
        cut(track, force);
        await upload(track);
        // A cut chunk that was acknowledged frees the next cut at once rather than a tick later.
        if (!track.inflight) {
            cut(track, force);
            await upload(track);
        }
    }
};

// Nothing in flight, nothing unread, and no whole record held back.
const settled = () => [...tracks.values()].every((t) => !t.inflight && t.size === t.pos && t.held.indexOf(NEWLINE) < 0);

const readText = (file) => {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
};

// What the supervisor reads of this exporter: the vitals, whether it finished, whether its token is gone.
function writeStatus({ done = false, gone = false } = {}) {
    if (!EXPORT_DIR) return;
    const { pendingBytes, oldestUnackedMs } = vitals();
    const body = JSON.stringify({ pendingBytes, oldestUnackedMs, spoolFull: progress.spoolFull, done, gone });
    const target = path.join(EXPORT_DIR, 'status.json');
    const tmp = `${target}.tmp`;
    try {
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, target);
    } catch {
        // The directory is the supervisor's to keep; an unwritable one costs it this exporter's vitals only.
    }
}

// The drain order: the supervisor's file, or — when its heartbeat stopped — this exporter's own.
const pollDrain = () => {
    if (progress.drain || !EXPORT_DIR) return;
    try {
        const ordered = JSON.parse(readText(path.join(EXPORT_DIR, 'drain.json')) ?? 'null');
        if (ordered && (ordered.state === 'complete' || ordered.state === 'partial')) {
            progress.drain = { state: ordered.state, cause: typeof ordered.cause === 'string' ? ordered.cause : null };
            return;
        }
    } catch {
        // Half a file is no order yet; the supervisor writes it atomically, so the next tick has it whole.
    }
    const beat = Number.parseInt(readText(path.join(EXPORT_DIR, 'supervisor.alive')) ?? '', 10);
    if (Number.isFinite(beat) && Date.now() - beat > SUPERVISOR_LOST_MS) {
        progress.drain = { state: 'partial', cause: 'supervisor_lost' };
    }
};

// One-shot mode: the closing is ordered by the env from the first tick.
const orderOnce = () => {
    if (!ONCE) return;
    progress.drain = {
        state: ONCE === 'complete' ? 'complete' : 'partial',
        cause: process.env.EXPORT_ONCE_CAUSE || null,
    };
};

const main = async () => {
    if (!DIR || !(CONTROL_SOCKET || (CONTROL_URL && TOKEN)) || (!EXPORT_DIR && !ONCE)) {
        throw new Error(
            'CLAUDE_TRANSCRIPT_DIR, FACTORY_EXPORT_DIR and EXPORT_CONTROL_SOCKET (or BELLOWS_CONTROL_URL and BELLOWS_CONTROL_TOKEN) are required'
        );
    }
    FLOOR_MS = volumeFloor();
    orderOnce();
    for (;;) {
        await tick();
        pollDrain();
        abandonDrain();
        if (progress.outageSince !== null && Date.now() - progress.outageSince > GIVEUP_MS) bail(EXIT_GAVE_UP);
        if (progress.drain && settled()) {
            await tick();
            if (settled()) {
                await finalize();
                await report(true);
                writeStatus({ done: true });
                return;
            }
        }
        await report(false);
        writeStatus();
        await sleep(POLL_MS);
    }
};

main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(EXIT_FAILED);
});
