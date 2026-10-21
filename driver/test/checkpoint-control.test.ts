import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChunkAnswer } from '../src/board.js';
import { createControlChannel, type ControlChannel } from '../src/control-channel.js';
import type { CheckpointRelay } from '../src/export-control.js';

/**
 * The control channel's checkpoint routes (issue #775): the task supervisor, at finalize, puts the
 * checkpoint's bytes and its closing record here and the loop forwards them to the board's
 * `checkpoint` stream. Only the supervisor's token opens them; the bytes are binary and kept exact.
 */
const TOKEN = 'tok';
const EXPORTER = 'tok-export';
const AGENT = 'tok-agent';

let server: Server;
let channel: ControlChannel;
let base: string;
let chunkAnswer: () => Promise<ChunkAnswer>;
let finalizeAnswer: () => Promise<'stored' | 'duplicate' | 'conflict' | 'rejected'>;
let readAnswer: (offset: number) => Promise<{ bytes: Uint8Array; sha256: string } | null>;
const seen: { chunks: [number, Uint8Array][]; manifests: unknown[] } = { chunks: [], manifests: [] };

const relay: CheckpointRelay = {
    putChunk: (offset, bytes) => {
        seen.chunks.push([offset, bytes]);
        return chunkAnswer();
    },
    finalize: (manifest) => {
        seen.manifests.push(manifest);
        return finalizeAnswer();
    },
    readChunk: (offset) => readAnswer(offset),
};

beforeEach(async () => {
    seen.chunks = [];
    seen.manifests = [];
    chunkAnswer = async () => ({ result: 'stored' });
    finalizeAnswer = async () => 'stored';
    readAnswer = async () => null;
    channel = createControlChannel();
    server = createServer((request, reply) => {
        const auth = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
        // As the gate server does: a body cut short rejects the serve, and the dead socket is dropped.
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

const call = (method: string, path: string, body?: string | Uint8Array, token = TOKEN) =>
    fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body }),
    });

const openCheckpointing = () => {
    channel.open(TOKEN);
    channel.grantExporter(TOKEN, EXPORTER);
    channel.grantAgent(TOKEN, AGENT);
    channel.attachCheckpoint(TOKEN, relay);
};

const MANIFEST = {
    state: 'truncated',
    terminalCause: 'checkpoint_cap',
    startedAt: '2026-10-21T10:00:00.000Z',
    finishedAt: '2026-10-21T10:00:05.000Z',
};

describe('the checkpoint routes', () => {
    it('relay a binary chunk at its offset, byte for byte', async () => {
        openCheckpointing();
        const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);

        const reply = await call('PUT', '/checkpoint/chunk?offset=4096', bytes);

        expect(reply.status).toBe(200);
        expect(await reply.json()).toEqual({ result: 'stored' });
        expect(seen.chunks).toHaveLength(1);
        expect(seen.chunks[0]![0]).toBe(4096);
        expect(Buffer.from(seen.chunks[0]![1])).toEqual(Buffer.from(bytes));
    });

    it('answer the board’s refusal, conflict and rejection with the statuses the exporter retries on', async () => {
        openCheckpointing();
        chunkAnswer = async () => ({ result: 'refused', cause: 'stream_cap' });
        const refused = await call('PUT', '/checkpoint/chunk?offset=0', 'x');
        expect(refused.status).toBe(413);
        expect(await refused.json()).toEqual({ cause: 'stream_cap' });
        chunkAnswer = async () => ({ result: 'conflict' });
        expect((await call('PUT', '/checkpoint/chunk?offset=0', 'x')).status).toBe(409);
        chunkAnswer = async () => ({ result: 'rejected' });
        expect((await call('PUT', '/checkpoint/chunk?offset=0', 'x')).status).toBe(400);
    });

    it('answer 502 when the board could not be reached, so the supervisor retries', async () => {
        openCheckpointing();
        chunkAnswer = async () => {
            throw new Error('board down');
        };
        const reply = await call('PUT', '/checkpoint/chunk?offset=0', 'x');
        expect(reply.status).toBe(502);
        expect(await reply.json()).toEqual({ error: 'board down' });
    });

    it('refuse an offset that is not a count, and a request of another method or path', async () => {
        openCheckpointing();
        expect((await call('PUT', '/checkpoint/chunk?offset=-1', 'x')).status).toBe(400);
        expect((await call('PUT', '/checkpoint/chunk', 'x')).status).toBe(400);
        expect((await call('POST', '/checkpoint/chunk?offset=0', 'x')).status).toBe(400);
        expect((await call('PUT', '/checkpoint/other', 'x')).status).toBe(400);
        expect(seen.chunks).toEqual([]);
    });

    it('relay the closing record, and validate it', async () => {
        openCheckpointing();

        const reply = await call('PUT', '/checkpoint/manifest', JSON.stringify(MANIFEST));

        expect(reply.status).toBe(200);
        expect(await reply.json()).toEqual({ result: 'stored' });
        expect(seen.manifests).toEqual([MANIFEST]);
        expect((await call('PUT', '/checkpoint/manifest', JSON.stringify({ ...MANIFEST, state: 'done' }))).status).toBe(
            400
        );
        expect((await call('PUT', '/checkpoint/manifest', 'not json')).status).toBe(400);
        finalizeAnswer = async () => 'conflict';
        expect((await call('PUT', '/checkpoint/manifest', JSON.stringify(MANIFEST))).status).toBe(409);
    });

    it('serve one chunk of the board’s checkpoint to the restore step as base64 beside its sha256', async () => {
        openCheckpointing();
        const bytes = Uint8Array.from({ length: 300 }, (_, i) => i % 251);
        const asked: number[] = [];
        readAnswer = async (offset) => {
            asked.push(offset);
            return { bytes, sha256: 'a'.repeat(64) };
        };

        const reply = await call('GET', '/checkpoint/restore?offset=1048576');

        expect(reply.status).toBe(200);
        const body = (await reply.json()) as { bytes: string; sha256: string };
        expect(Buffer.from(body.bytes, 'base64')).toEqual(Buffer.from(bytes));
        expect(body.sha256).toBe('a'.repeat(64));
        expect(asked).toEqual([1048576]);
    });

    it('answer 404 for a chunk the board does not hold, 400 for an offset that is none and 502 when the board is out of reach', async () => {
        openCheckpointing();

        expect((await call('GET', '/checkpoint/restore?offset=0')).status).toBe(404);
        expect((await call('GET', '/checkpoint/restore?offset=-1')).status).toBe(400);
        readAnswer = async () => {
            throw new Error('board unreachable');
        };
        expect((await call('GET', '/checkpoint/restore?offset=0')).status).toBe(502);
    });

    it('open the restore read to the supervisor token alone', async () => {
        openCheckpointing();

        expect((await call('GET', '/checkpoint/restore?offset=0', undefined, EXPORTER)).status).toBe(403);
        expect((await call('GET', '/checkpoint/restore?offset=0', undefined, AGENT)).status).toBe(403);
    });

    it('answer 400 where the attempt has no checkpoint relay', async () => {
        channel.open(TOKEN);
        expect((await call('PUT', '/checkpoint/chunk?offset=0', 'x')).status).toBe(400);
        expect((await call('PUT', '/checkpoint/manifest', JSON.stringify(MANIFEST))).status).toBe(400);
    });

    it('open for the supervisor token alone: the exporter’s and the agent’s are refused', async () => {
        openCheckpointing();
        expect((await call('PUT', '/checkpoint/chunk?offset=0', 'x', EXPORTER)).status).toBe(403);
        expect((await call('PUT', '/checkpoint/chunk?offset=0', 'x', AGENT)).status).toBe(403);
        expect(seen.chunks).toEqual([]);
    });

    it('never say a supervisor is listening: a checkpoint call is not a control poll', async () => {
        openCheckpointing();
        await call('PUT', '/checkpoint/chunk?offset=0', 'x');
        expect(channel.polled(TOKEN)).toBe(false);
    });

    it('answer 401 once the attempt is closed', async () => {
        openCheckpointing();
        channel.close(TOKEN);
        expect((await call('PUT', '/checkpoint/chunk?offset=0', 'x')).status).toBe(401);
        expect(seen.chunks).toEqual([]);
    });

    it('settle a body cut short by a dropped connection: nothing is relayed and the next call is served', async () => {
        openCheckpointing();
        const port = (server.address() as AddressInfo).port;
        await new Promise<void>((resolve) => {
            const cut = httpRequest(
                {
                    port,
                    host: '127.0.0.1',
                    method: 'PUT',
                    path: '/checkpoint/chunk?offset=0',
                    headers: { authorization: `Bearer ${TOKEN}`, 'content-length': '1000' },
                },
                () => undefined
            );
            cut.on('error', () => resolve());
            cut.write('only ten b');
            setTimeout(() => cut.destroy(), 20);
        });

        expect(seen.chunks).toEqual([]);
        expect((await call('PUT', '/checkpoint/chunk?offset=0', 'whole')).status).toBe(200);
        expect(seen.chunks).toHaveLength(1);
    });
});
