import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ControlChannel, createControlChannel } from '../src/control-channel.js';
import type { ConnectionRelay } from '../src/connection-control.js';

/**
 * The control channel's connection route (BEL-174): the agent's token — and only it — asks for a
 * connection its task lacks, `POST /connection {provider}`, and the answer is the board's.
 */
const TOKEN = 'tok';
const EXPORTER = 'tok-export';
const AGENT = 'tok-agent';

let server: Server;
let channel: ControlChannel;
let base: string;
let asked: string[];

const relay: ConnectionRelay = {
    require: async (provider) => {
        asked.push(provider);
        return 'waiting';
    },
};

beforeEach(async () => {
    asked = [];
    channel = createControlChannel();
    channel.open(TOKEN);
    channel.grantAgent(TOKEN, AGENT);
    channel.grantExporter(TOKEN, EXPORTER);
    channel.attachConnection(TOKEN, relay);
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

function call(method: string, token: string, body?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            `${base}/connection`,
            { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
            (res) => {
                let text = '';
                res.on('data', (chunk: Buffer) => {
                    text += chunk.toString();
                });
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
            }
        );
        req.on('error', reject);
        req.end(body);
    });
}

describe('POST /connection', () => {
    it("relays the agent token's ask to the board and answers what the board did", async () => {
        const answer = await call('POST', AGENT, JSON.stringify({ provider: 'jira' }));

        expect(answer.status).toBe(200);
        expect(JSON.parse(answer.body)).toEqual({ answer: 'waiting' });
        expect(asked).toEqual(['jira']);
    });

    it.each([
        ['the supervisor', TOKEN],
        ['the exporter', EXPORTER],
    ])("is not a door of %s's token", async (_who, token) => {
        expect((await call('POST', token, JSON.stringify({ provider: 'jira' }))).status).toBe(403);
        expect(asked).toEqual([]);
    });

    it('answers 401 for a token of no attempt, and does not serve a GET', async () => {
        expect((await call('POST', 'unknown', JSON.stringify({ provider: 'jira' }))).status).toBe(401);
        expect((await call('GET', AGENT)).status).toBe(404);
        expect(asked).toEqual([]);
    });

    it('answers 503 until the loop attaches a relay', async () => {
        channel.close(TOKEN);
        channel.open(TOKEN);
        channel.grantAgent(TOKEN, AGENT);
        expect((await call('POST', AGENT, JSON.stringify({ provider: 'jira' }))).status).toBe(503);
    });

    it('answers 413 to a body past the bound', async () => {
        expect((await call('POST', AGENT, JSON.stringify({ provider: 'jira', pad: 'x'.repeat(8192) }))).status).toBe(
            413
        );
        expect(asked).toEqual([]);
    });
});
