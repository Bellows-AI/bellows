import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentCorrupt, AttachmentGone } from '../src/board/board-attachments.js';
import { createControlChannel, type ControlChannel } from '../src/control-channel.js';
import { inputDelivery } from '../src/input-control.js';

/**
 * The control channel's input route: the task supervisor's fetch step reads a task input's bytes here and the
 * driver forwards the read to the board under the lease of the row the delivery is registered for. Only the
 * supervisor's token opens it, and only for a file of the manifest registered for the delivery.
 */
const TOKEN = 'tok';
const EXPORTER = 'tok-export';
const AGENT = 'tok-agent';
const SHA = 'a'.repeat(64);
const FILE = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const TASK = { id: '22222222-2222-4222-8222-222222222222', leaseToken: 'task-lease' };
const REVIEW = { id: '55555555-5555-4555-8555-555555555555', leaseToken: 'review-lease' };
const entry = (id: string) => ({
    id,
    name: 'a.txt',
    mediaType: 'text/plain',
    size: 1,
    sha256: SHA,
    originJobId: TASK.id,
});

let server: Server;
let channel: ControlChannel;
let base: string;
let boardAnswer: () => Promise<{ bytes: Uint8Array; sha256: string } | null>;
let reads: { row: { id: string; leaseToken: string }; attachmentId: string }[];
const board = {
    attachmentContent: (row: { id: string; leaseToken: string }, attachmentId: string) => {
        reads.push({ row, attachmentId });
        return boardAnswer();
    },
};
const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);

beforeEach(async () => {
    reads = [];
    boardAnswer = async () => ({ bytes, sha256: SHA });
    channel = createControlChannel();
    server = createServer((request, reply) => {
        const auth = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
        void channel
            .serve(request, reply, auth)
            .then((handled) => {
                if (!handled) reply.writeHead(404).end();
            })
            .catch(() => reply.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
});

const call = (path: string, token = TOKEN, method = 'GET') =>
    fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` } });

const openTask = () => {
    channel.open(TOKEN);
    channel.grantExporter(TOKEN, EXPORTER);
    channel.grantAgent(TOKEN, AGENT);
    channel.attachInputs(TOKEN, 'task', inputDelivery(board, TASK, [entry(FILE)]));
};

describe('the input route', () => {
    it('serve the supervisor the file bytes, byte for byte, with the board digest', async () => {
        openTask();

        const reply = await call(`/input/task/${FILE}`);

        expect(reply.status).toBe(200);
        expect(reply.headers.get('x-content-sha256')).toBe(SHA);
        expect(new Uint8Array(await reply.arrayBuffer())).toEqual(bytes);
        expect(reads).toEqual([{ row: TASK, attachmentId: FILE }]);
    });

    it('open the route to the supervisor token alone', async () => {
        openTask();

        expect((await call(`/input/task/${FILE}`, EXPORTER)).status).toBe(403);
        expect((await call(`/input/task/${FILE}`, AGENT)).status).toBe(403);
        expect((await call(`/input/task/${FILE}`, 'unknown')).status).toBe(401);
        expect(reads).toEqual([]);
    });

    it('answer 404 for a board 404, 410 for a gone file, 422 for a corrupt one', async () => {
        openTask();
        boardAnswer = async () => null;
        expect((await call(`/input/task/${FILE}`)).status).toBe(404);
        boardAnswer = async () => {
            throw new AttachmentGone('gone');
        };
        expect((await call(`/input/task/${FILE}`)).status).toBe(410);
        boardAnswer = async () => {
            throw new AttachmentCorrupt('corrupt');
        };
        expect((await call(`/input/task/${FILE}`)).status).toBe(422);
    });

    it('answer 502 when the board is unreachable or unconfirmed, so the supervisor retries', async () => {
        openTask();
        boardAnswer = async () => {
            throw new Error('connection reset');
        };
        expect((await call(`/input/task/${FILE}`)).status).toBe(502);
    });

    it('validate the id as a uuid and refuse one outside the registered manifest: no free fetch', async () => {
        openTask();

        expect((await call('/input/task/not-a-uuid')).status).toBe(400);
        expect((await call(`/input/task/${OTHER}`)).status).toBe(404);
        expect((await call(`/input/nobody/${FILE}`)).status).toBe(404);
        expect((await call('/input/task')).status).toBe(400);
        expect(reads).toEqual([]);
    });

    it('answer 404 where the attempt registered no delivery at all', async () => {
        channel.open(TOKEN);
        expect((await call(`/input/task/${FILE}`)).status).toBe(404);
    });

    it('forward a review delivery with the review row’s id and lease, and refuse ids outside its manifest', async () => {
        openTask();
        channel.attachInputs(TOKEN, REVIEW.id, inputDelivery(board, REVIEW, [entry(OTHER)]));

        expect((await call(`/input/${REVIEW.id}/${OTHER}`)).status).toBe(200);
        expect((await call(`/input/${REVIEW.id}/${FILE}`)).status).toBe(404);
        expect((await call(`/input/task/${OTHER}`)).status).toBe(404);
        expect(reads).toEqual([{ row: REVIEW, attachmentId: OTHER }]);
    });

    it('stop serving a delivery once it is detached', async () => {
        openTask();
        channel.detachInputs(TOKEN, 'task');

        expect((await call(`/input/task/${FILE}`)).status).toBe(404);
    });

    it('answer 401 for a token whose attempt closed while the board read was in flight', async () => {
        openTask();
        boardAnswer = async () => {
            channel.close(TOKEN);
            return { bytes, sha256: SHA };
        };

        expect((await call(`/input/task/${FILE}`)).status).toBe(401);
    });
});
