import type { IncomingMessage } from 'node:http';
import { AttachmentCorrupt, AttachmentGone, type ClaimAttachment } from './board/board-attachments.js';
import type { Board, BoardJob } from './board/board.js';
import { UUID } from './task-volume.js';

/**
 * The task input route of the control channel: `GET /input/<delivery>/<attachmentId>`, opened to the supervisor's
 * token alone. The fetch step reads a file's bytes here and the driver forwards the read to the board under the
 * lease of the row the delivery is registered for: the task's own, or a review's (its row id and lease), each
 * under the caller's control token (`ControlChannel.attachInputs`). The id must be a uuid and listed in the
 * delivery's manifest, so the route is no free fetch of anything the lease could name.
 */
export const INPUT_PATH = '/input';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
const HTTP_UNPROCESSABLE = 422;
const HTTP_BAD_GATEWAY = 502;

/** One delivery: the files its row's claim lists, and the board read under that row's lease. */
export interface InputDelivery {
    manifest: readonly ClaimAttachment[];
    read(attachmentId: string): Promise<{ bytes: Uint8Array; sha256: string } | null>;
}

/** The deliveries of one attempt, by delivery name (`task`, or a review row's id). */
export interface InputSlot {
    deliveries: Map<string, InputDelivery>;
}

/** What the route answers: JSON, or the file's raw bytes with the digest the board sent. */
export type InputAnswer =
    | { status: number; body: unknown }
    | { status: typeof HTTP_OK; bytes: Uint8Array; sha256: string };

/** A delivery of `manifest` read from the board as `row`, whose lease fences every read. */
export const inputDelivery = (
    board: Pick<Board, 'attachmentContent'>,
    row: Pick<BoardJob, 'id' | 'leaseToken'>,
    manifest: readonly ClaimAttachment[]
): InputDelivery => ({
    manifest,
    read: (attachmentId) => board.attachmentContent({ id: row.id, leaseToken: row.leaseToken }, attachmentId),
});

const refuse = (status: number, error: string): InputAnswer => ({ status, body: { error } });

/** A failed board read as the status the fetch script classifies: 410 and 422 never deliverable, the rest retried. */
const readFailed = (e: unknown): InputAnswer => {
    if (e instanceof AttachmentGone) return refuse(HTTP_GONE, e.message);
    if (e instanceof AttachmentCorrupt) return refuse(HTTP_UNPROCESSABLE, e.message);
    return refuse(HTTP_BAD_GATEWAY, e instanceof Error ? e.message : String(e));
};

/** Serves one `GET /input/<delivery>/<id>` once the supervisor's token is known; `open` says the attempt is still live. */
export async function serveInput(slot: InputSlot, request: IncomingMessage, open: () => boolean): Promise<InputAnswer> {
    const [delivery = '', id = '', ...rest] = (request.url ?? '').slice(INPUT_PATH.length + 1).split('/');
    if (request.method !== 'GET' || !delivery || !UUID.test(id) || rest.length > 0) {
        return refuse(HTTP_BAD_REQUEST, 'malformed input request');
    }
    const known = slot.deliveries.get(delivery);
    if (!known?.manifest.some((file) => file.id === id)) return refuse(HTTP_NOT_FOUND, 'no such input');
    const read = await known.read(id).catch(readFailed);
    if (!open()) return refuse(HTTP_UNAUTHORIZED, 'unknown token');
    if (read === null) return refuse(HTTP_NOT_FOUND, 'the board holds no such input');
    if ('status' in read) return read;
    return { status: HTTP_OK, bytes: read.bytes, sha256: read.sha256 };
}
