import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChunkAnswer } from '../src/board.js';
import { createControlChannel, type ControlChannel } from '../src/control-channel.js';
import type { ExportRelay } from '../src/export-control.js';

/** The control channel's transcript-export routes: their statuses, their validation, and what they never touch. */

/** One attempt's supervisor token, and its exporter's own token — the one the export routes take. */
const TOKEN = 'tok';
const EXPORTER = 'tok-export';

let server: Server;
let channel: ControlChannel;
let base: string;
let answer: () => Promise<ChunkAnswer>;
const seen: { chunks: [string, number, number][]; reports: unknown[] } = { chunks: [], reports: [] };

const relayInto = (into: typeof seen): ExportRelay => ({
    putChunk: (session, offset, bytes) => {
        into.chunks.push([session, offset, bytes.length]);
        return answer();
    },
    finalize: async () => 'stored',
    report: (report) => {
        into.reports.push(report);
    },
});
const relay = relayInto(seen);

beforeEach(async () => {
    seen.chunks = [];
    seen.reports = [];
    answer = async () => ({ result: 'stored' });
    channel = createControlChannel();
    server = createServer((request, reply) => {
        const auth = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
        void channel.serve(request, reply, auth).then((handled) => {
            if (!handled) reply.end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
    server.close();
});

const openExporting = (): void => {
    channel.open(TOKEN);
    channel.grantExporter(TOKEN, EXPORTER);
    channel.attachExporter(TOKEN, relay);
};

const STATE = JSON.stringify({ pendingBytes: 0, oldestUnackedMs: 0, spoolFull: false, done: false });

const call = (method: string, path: string, body?: string | Uint8Array, token = EXPORTER) =>
    fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` }, ...(body ? { body } : {}) });

describe('the export routes of the control channel', () => {
    it('refuse an unknown token', async () => {
        openExporting();
        expect((await call('POST', '/export/state', '{}', 'other')).status).toBe(401);
    });

    // The drain order is the supervisor's file in a directory only it and the exporter mount: no
    // route carries it, and none answers one.
    it('carry no drain order: the supervisor hands it over by file', async () => {
        openExporting();
        expect((await call('GET', '/export/control')).status).toBe(400);
        expect('drainExport' in channel).toBe(false);
    });

    it('never mark the token polled: only the supervisor’s own control poll does', async () => {
        openExporting();
        expect((await call('POST', '/export/state', STATE)).status).toBe(200);
        expect(channel.polled(TOKEN)).toBe(false);
        await call('GET', '/control', undefined, TOKEN);
        expect(channel.polled(TOKEN)).toBe(true);
    });

    it('relay a chunk at its offset and map the board’s answers to statuses', async () => {
        openExporting();
        const put = () => call('PUT', '/export/chunk?session=abc&offset=40', new Uint8Array([1, 2, 3]));
        expect((await put()).status).toBe(200);
        expect(seen.chunks).toEqual([['abc', 40, 3]]);
        answer = async () => ({ result: 'refused', cause: 'stream_cap' });
        const refused = await put();
        expect(refused.status).toBe(413);
        expect(await refused.json()).toEqual({ cause: 'stream_cap' });
        answer = async () => ({ result: 'conflict' });
        expect((await put()).status).toBe(409);
        answer = async () => {
            throw new Error('the board is down');
        };
        expect((await put()).status).toBe(502);
    });

    it('refuse a chunk with a session or offset that is not one', async () => {
        openExporting();
        expect((await call('PUT', '/export/chunk?session=../x&offset=0', new Uint8Array([1]))).status).toBe(400);
        expect((await call('PUT', '/export/chunk?session=abc&offset=-1', new Uint8Array([1]))).status).toBe(400);
        expect((await call('PUT', '/export/chunk?session=abc', new Uint8Array([1]))).status).toBe(400);
        expect(seen.chunks).toEqual([]);
    });

    it('keep the vitals the exporter reports and refuse a malformed report', async () => {
        openExporting();
        const report = { pendingBytes: 12, oldestUnackedMs: 3400, spoolFull: false, done: false };
        expect((await call('POST', '/export/state', JSON.stringify(report))).status).toBe(200);
        expect(seen.reports).toEqual([report]);
        expect((await call('POST', '/export/state', JSON.stringify({ pendingBytes: -1 }))).status).toBe(400);
    });

    it('refuse a manifest or a report that is not a JSON object as a malformed export request', async () => {
        openExporting();
        for (const body of ['not json', 'null', '[]']) {
            const manifest = await call('PUT', '/export/manifest', body);
            expect(manifest.status).toBe(400);
            expect(await manifest.json()).toEqual({ error: 'malformed export request' });
            const state = await call('POST', '/export/state', body);
            expect(state.status).toBe(400);
            expect(await state.json()).toEqual({ error: 'malformed export request' });
        }
        expect(seen.reports).toEqual([]);
    });

    it('answer 400 where the attempt exports no transcript', async () => {
        channel.open(TOKEN);
        channel.grantExporter(TOKEN, EXPORTER);
        expect((await call('PUT', '/export/chunk?session=abc&offset=0', new Uint8Array([1]))).status).toBe(400);
    });

    it('answer 401 to a request whose token closed while its body arrived', async () => {
        openExporting();
        channel.close(TOKEN);
        expect((await call('PUT', '/export/chunk?session=abc&offset=0', new Uint8Array([1]))).status).toBe(401);
    });
});

describe('the exporter token of the control channel', () => {
    // The exporter holds its own token: it opens the export routes and no supervisor door, and the
    // supervisor's token no longer opens the export routes.
    it('opens the export routes alone, and the supervisor token is refused on them', async () => {
        openExporting();
        expect((await call('GET', '/control')).status).toBe(403);
        expect((await call('GET', '/step?wait=0')).status).toBe(403);
        expect((await call('POST', '/step/s1', '{}')).status).toBe(403);
        expect((await call('POST', '/report', '{}')).status).toBe(403);
        expect((await call('POST', '/question', '{}')).status).toBe(403);
        expect((await call('GET', '/question/q1')).status).toBe(403);
        expect((await call('POST', '/publish')).status).toBe(403);
        expect((await call('GET', '/review/r1')).status).toBe(403);
        expect(channel.polled(TOKEN)).toBe(false);
        expect((await call('POST', '/export/state', STATE, TOKEN)).status).toBe(403);
        expect((await call('PUT', '/export/chunk?session=abc&offset=0', new Uint8Array([1]), TOKEN)).status).toBe(403);
        expect(seen.chunks).toEqual([]);
        expect((await call('POST', '/export/state', STATE)).status).toBe(200);
        expect(seen.reports).toHaveLength(1);
    });

    it('closes with its attempt, and a new attempt’s exporter token relays to its own attempt only', async () => {
        openExporting();
        const next: typeof seen = { chunks: [], reports: [] };
        channel.open('tok-2');
        channel.grantExporter('tok-2', 'tok-2-export');
        channel.attachExporter('tok-2', relayInto(next));
        channel.close(TOKEN);

        expect((await call('POST', '/export/state', STATE)).status).toBe(401);
        expect(
            (await call('PUT', '/export/chunk?session=abc&offset=0', new Uint8Array([1, 2]), 'tok-2-export')).status
        ).toBe(200);
        expect(next.chunks).toEqual([['abc', 0, 2]]);
        expect(seen.chunks).toEqual([]);
        expect((await call('GET', '/control', undefined, 'tok-2-export')).status).toBe(403);
        expect((await call('GET', '/control', undefined, 'tok-2')).status).toBe(200);
    });

    it('never stands in for the supervisor token it is granted beside', async () => {
        channel.open(TOKEN);
        channel.grantExporter(TOKEN, TOKEN);
        channel.attachExporter(TOKEN, relay);
        expect((await call('POST', '/export/state', STATE, TOKEN)).status).toBe(403);
        expect((await call('GET', '/control', undefined, TOKEN)).status).toBe(200);
    });
});

// Issue #774 (B5): a review's close-time export step runs in the CALLER's group but under the
// review row's identity — its own exporter token, bound to the review's relay.
describe('a review-bound exporter token', () => {
    const REVIEW_EXPORTER = 'review-export';

    it('relays to the review’s relay and never to the caller’s, and is revoked on its own', async () => {
        openExporting();
        const review: typeof seen = { chunks: [], reports: [] };
        channel.grantExporter(TOKEN, REVIEW_EXPORTER, relayInto(review));

        const put = (token: string) => call('PUT', '/export/chunk?session=abc&offset=0', new Uint8Array([1, 2]), token);
        expect((await put(REVIEW_EXPORTER)).status).toBe(200);
        expect(review.chunks).toEqual([['abc', 0, 2]]);
        expect(seen.chunks).toEqual([]);
        expect((await put(EXPORTER)).status).toBe(200);
        expect(seen.chunks).toEqual([['abc', 0, 2]]);

        channel.revokeExporter(REVIEW_EXPORTER);
        expect((await put(REVIEW_EXPORTER)).status).toBe(401);
        expect((await put(EXPORTER)).status).toBe(200);
    });

    it('closes with the caller’s attempt', async () => {
        openExporting();
        channel.grantExporter(TOKEN, REVIEW_EXPORTER, relayInto({ chunks: [], reports: [] }));
        channel.close(TOKEN);
        expect((await call('POST', '/export/state', STATE, REVIEW_EXPORTER)).status).toBe(401);
    });
});
