import type { IncomingMessage } from 'node:http';
import type { ChunkAnswer } from './board.js';
import { readBody, readBodyBytes } from './http.js';
import { parseJsonObject } from './json-parse.js';

/**
 * The control endpoint's transcript-export routes, one set per control token — so one lease. The
 * exporter (`scripts/claude-export.cjs`) runs beside the agent under the task supervisor and
 * carries no board credential: it puts each chunk here and the loop (`loop-export.ts`) forwards it
 * to the board's chunk route. The routes never mark the token `polled` — only the supervisor's own
 * control poll says a Stop can be cooperative. The drain order does not travel here: the supervisor
 * hands it to the exporter through the directory only the two of them mount.
 */

export const EXPORT_PATH = '/export';
export const EXPORT_CHUNK_PATH = `${EXPORT_PATH}/chunk`;
export const EXPORT_MANIFEST_PATH = `${EXPORT_PATH}/manifest`;
export const EXPORT_STATE_PATH = `${EXPORT_PATH}/state`;
/** The checkpoint routes (issue #775): the supervisor's own, at finalize — not the exporter's. */
export const CHECKPOINT_PATH = '/checkpoint';
export const CHECKPOINT_CHUNK_PATH = `${CHECKPOINT_PATH}/chunk`;
export const CHECKPOINT_MANIFEST_PATH = `${CHECKPOINT_PATH}/manifest`;

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
/** The board cuts a record above 64 MiB and one chunk is never larger: this is that, plus a MiB of headroom. */
const CHUNK_BODY_MIB = 65;
export const EXPORT_CHUNK_BODY_LIMIT = CHUNK_BODY_MIB * BYTES_PER_MIB;
const JSON_BODY_KIB = 4;
export const EXPORT_JSON_BODY_LIMIT = JSON_BODY_KIB * BYTES_PER_KIB;

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_BAD_GATEWAY = 502;

/** The segment of a stream's key a session may fill: the board's own rule for ids in a key. */
const SESSION = /^[A-Za-z0-9._-]{1,128}$/;

/** The exporter's vitals: what is unacknowledged and for how long, and whether the spool cap is hit. */
export interface ExportReport {
    pendingBytes: number;
    oldestUnackedMs: number;
    spoolFull: boolean;
    done: boolean;
}

/** One session's closing record, as the exporter proposes it. */
export interface ExportManifestRequest {
    session: string;
    state: 'complete' | 'partial' | 'truncated';
    terminalCause: string | null;
    startedAt: string;
    finishedAt: string;
}

/** What the loop does with the exporter's calls: forward to the board, and keep the vitals. */
export interface ExportRelay {
    putChunk(session: string, offset: number, bytes: Uint8Array): Promise<ChunkAnswer>;
    finalize(manifest: ExportManifestRequest): Promise<'stored' | 'duplicate' | 'conflict' | 'rejected'>;
    report(report: ExportReport): void;
}

/** The checkpoint stream's closing record, as the supervisor proposes it: the claim sequence is the loop's own. */
export interface CheckpointManifestRequest {
    state: 'complete' | 'partial' | 'truncated';
    terminalCause: string | null;
    startedAt: string;
    finishedAt: string;
}

/** What the loop does with the supervisor's checkpoint calls: forward to the board's `checkpoint` stream. */
export interface CheckpointRelay {
    putChunk(offset: number, bytes: Uint8Array): Promise<ChunkAnswer>;
    finalize(manifest: CheckpointManifestRequest): Promise<'stored' | 'duplicate' | 'conflict' | 'rejected'>;
}

/** One token's checkpoint state: the relay, null until the loop attaches it. */
export interface CheckpointSlot {
    relay: CheckpointRelay | null;
}

/** One token's export state: the relay, null on a run with no exporter. */
export interface ExportSlot {
    relay: ExportRelay | null;
}

export interface ExportAnswer {
    status: number;
    body: unknown;
}

const MANIFEST_STATES: readonly string[] = ['complete', 'partial', 'truncated'];
const BAD_REQUEST: ExportAnswer = { status: HTTP_BAD_REQUEST, body: { error: 'malformed export request' } };
const TOO_LARGE: ExportAnswer = { status: HTTP_PAYLOAD_TOO_LARGE, body: { error: 'body too large' } };
const GONE: ExportAnswer = { status: HTTP_UNAUTHORIZED, body: { error: 'unknown token' } };

const count = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A chunk answer on the wire: the statuses the board's own chunk route answers with. */
function chunkAnswer(answer: ChunkAnswer): ExportAnswer {
    if (answer.result === 'refused') return { status: HTTP_PAYLOAD_TOO_LARGE, body: { cause: answer.cause } };
    if (answer.result === 'conflict') return { status: HTTP_CONFLICT, body: { result: 'conflict' } };
    if (answer.result === 'rejected') return { status: HTTP_BAD_REQUEST, body: { result: 'rejected' } };
    return { status: HTTP_OK, body: { result: answer.result } };
}

/** The failure of a relay call, as the transient answer the exporter retries. */
const relayFailed = (e: unknown): ExportAnswer => ({
    status: HTTP_BAD_GATEWAY,
    body: { error: e instanceof Error ? e.message : String(e) },
});

/** A manifest answer on the wire. */
const manifestAnswer = (result: 'stored' | 'duplicate' | 'conflict' | 'rejected'): ExportAnswer =>
    result === 'conflict'
        ? { status: HTTP_CONFLICT, body: { result } }
        : result === 'rejected'
          ? { status: HTTP_BAD_REQUEST, body: { result } }
          : { status: HTTP_OK, body: { result } };

async function serveChunk(relay: ExportRelay, request: IncomingMessage, open: () => boolean): Promise<ExportAnswer> {
    const query = new URL(request.url ?? '', 'http://control').searchParams;
    const session = query.get('session') ?? '';
    const offset = Number(query.get('offset') ?? Number.NaN);
    if (!SESSION.test(session) || !count(offset)) return BAD_REQUEST;
    const bytes = await readBodyBytes(request, EXPORT_CHUNK_BODY_LIMIT);
    if (bytes === null) return TOO_LARGE;
    if (!open()) return GONE;
    return relay.putChunk(session, offset, bytes).then(chunkAnswer, relayFailed);
}

async function serveManifest(relay: ExportRelay, request: IncomingMessage, open: () => boolean): Promise<ExportAnswer> {
    const raw = await readBody(request, EXPORT_JSON_BODY_LIMIT);
    if (raw === null) return TOO_LARGE;
    const body = parseJsonObject(raw);
    if (!body) return BAD_REQUEST;
    const { session, state, terminalCause, startedAt, finishedAt } = body;
    if (typeof session !== 'string' || !SESSION.test(session)) return BAD_REQUEST;
    if (typeof state !== 'string' || !MANIFEST_STATES.includes(state)) return BAD_REQUEST;
    if (typeof startedAt !== 'string' || typeof finishedAt !== 'string') return BAD_REQUEST;
    if (terminalCause !== null && typeof terminalCause !== 'string') return BAD_REQUEST;
    if (!open()) return GONE;
    const manifest = { session, state, terminalCause, startedAt, finishedAt } as ExportManifestRequest;
    return relay.finalize(manifest).then(manifestAnswer, relayFailed);
}

async function serveState(relay: ExportRelay, request: IncomingMessage, open: () => boolean): Promise<ExportAnswer> {
    const raw = await readBody(request, EXPORT_JSON_BODY_LIMIT);
    if (raw === null) return TOO_LARGE;
    const body = parseJsonObject(raw);
    if (!body) return BAD_REQUEST;
    const { pendingBytes, oldestUnackedMs, spoolFull, done } = body;
    if (!count(pendingBytes) || !count(oldestUnackedMs)) return BAD_REQUEST;
    if (typeof spoolFull !== 'boolean' || typeof done !== 'boolean') return BAD_REQUEST;
    if (!open()) return GONE;
    relay.report({ pendingBytes, oldestUnackedMs, spoolFull, done });
    return { status: HTTP_OK, body: {} };
}

const checkpointManifestOf = (body: Record<string, unknown>): CheckpointManifestRequest | null => {
    const { state, terminalCause, startedAt, finishedAt } = body;
    if (typeof state !== 'string' || !MANIFEST_STATES.includes(state)) return null;
    if (typeof startedAt !== 'string' || typeof finishedAt !== 'string') return null;
    if (terminalCause !== null && typeof terminalCause !== 'string') return null;
    return { state, terminalCause, startedAt, finishedAt } as CheckpointManifestRequest;
};

/**
 * Serves one checkpoint request once the supervisor's token is known: `PUT /checkpoint/chunk?offset=`
 * (the raw bytes) and `PUT /checkpoint/manifest`. Answers as the export routes do, so the supervisor
 * retries the same statuses; a body cut short by a dropped connection relays nothing.
 */
export async function serveCheckpoint(
    slot: CheckpointSlot,
    request: IncomingMessage,
    open: () => boolean
): Promise<ExportAnswer> {
    const { relay } = slot;
    if (!relay) return { status: HTTP_BAD_REQUEST, body: { error: 'this attempt checkpoints nothing' } };
    const [path, search = ''] = (request.url ?? '').split('?');
    if (request.method !== 'PUT') return BAD_REQUEST;
    if (path === CHECKPOINT_CHUNK_PATH) return serveCheckpointChunk(relay, { request, search }, open);
    if (path === CHECKPOINT_MANIFEST_PATH) return serveCheckpointManifest(relay, request, open);
    return BAD_REQUEST;
}

async function serveCheckpointChunk(
    relay: CheckpointRelay,
    { request, search }: { request: IncomingMessage; search: string },
    open: () => boolean
): Promise<ExportAnswer> {
    const offset = Number(new URLSearchParams(search).get('offset') ?? Number.NaN);
    if (!count(offset)) return BAD_REQUEST;
    const bytes = await readBodyBytes(request, EXPORT_CHUNK_BODY_LIMIT);
    if (bytes === null) return TOO_LARGE;
    if (!open()) return GONE;
    return relay.putChunk(offset, bytes).then(chunkAnswer, relayFailed);
}

async function serveCheckpointManifest(
    relay: CheckpointRelay,
    request: IncomingMessage,
    open: () => boolean
): Promise<ExportAnswer> {
    const raw = await readBody(request, EXPORT_JSON_BODY_LIMIT);
    if (raw === null) return TOO_LARGE;
    const body = parseJsonObject(raw);
    const manifest = body && checkpointManifestOf(body);
    if (!manifest) return BAD_REQUEST;
    if (!open()) return GONE;
    return relay.finalize(manifest).then(manifestAnswer, relayFailed);
}

/**
 * Serves one export request once the token is known. `open` says the token is still the same
 * entry after the body arrived: a token closed meanwhile belongs to a dead attempt, and its
 * request is answered 401 whatever it carried.
 */
export async function serveExport(
    slot: ExportSlot,
    request: IncomingMessage,
    open: () => boolean
): Promise<ExportAnswer> {
    const { relay } = slot;
    const path = (request.url ?? '').split('?')[0];
    if (!relay) return { status: HTTP_BAD_REQUEST, body: { error: 'this attempt exports no transcript' } };
    const serve =
        request.method === 'PUT' && path === EXPORT_CHUNK_PATH
            ? serveChunk
            : request.method === 'PUT' && path === EXPORT_MANIFEST_PATH
              ? serveManifest
              : request.method === 'POST' && path === EXPORT_STATE_PATH
                ? serveState
                : null;
    if (!serve) return BAD_REQUEST;
    return serve(relay, request, open);
}
