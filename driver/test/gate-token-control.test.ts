import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ControlChannel, createControlChannel } from '../src/control-channel.js';
import type { GateTokenRelay } from '../src/gate-token-control.js';
import type { GithubGrant } from '../src/github-credential-call.js';
import { createStepBroker, type StepBroker } from '../src/step-control.js';
import type { StepRequest } from '../src/supervisor-contract.js';

/**
 * The control channel's gate-token route: the supervisor's token — and only it — asks for a
 * GitHub token on behalf of a gate step it is running; the answer is the board's.
 */
const TOKEN = 'tok';
const EXPORTER = 'tok-export';
const AGENT = 'tok-agent';
const never = new AbortController().signal;
const gate: StepRequest = {
    id: 'gate-1',
    invocation: 'i-1',
    kind: 'gate',
    argv: ['sh', '-c', 'true'],
    env: {},
    timeoutMs: 60_000,
};

let server: Server;
let channel: ControlChannel;
let steps: StepBroker;
let base: string;
let asks: number;
let answer: () => Promise<GithubGrant | 'gone'>;

const relay: GateTokenRelay = {
    token: async () => {
        asks += 1;
        return answer();
    },
};
const grant = (token: string, expiresAt: string | null = '2030-01-01T00:00:00.000Z'): GithubGrant => ({
    kind: 'token',
    token,
    expiresAt,
});

/** Submits the gate step and has the supervisor pull it, so the broker holds it. */
async function holdGate(step: StepRequest = gate) {
    const settled = steps.submit(TOKEN, step);
    settled.catch(() => undefined);
    await steps.next(TOKEN, 0, never);
    return { settled };
}

beforeEach(async () => {
    asks = 0;
    answer = async () => grant('ghs_1');
    steps = createStepBroker();
    channel = createControlChannel(steps);
    channel.open(TOKEN);
    channel.grantAgent(TOKEN, AGENT);
    channel.grantExporter(TOKEN, EXPORTER);
    channel.attachGateToken(TOKEN, relay);
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

function call(token: string, body: string): Promise<{ status: number; body: string; cache: string | undefined }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            `${base}/gate-token`,
            { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
            (res) => {
                let text = '';
                res.on('data', (chunk: Buffer) => {
                    text += chunk.toString();
                });
                res.on('end', () =>
                    resolve({ status: res.statusCode ?? 0, body: text, cache: res.headers['cache-control'] })
                );
            }
        );
        req.on('error', reject);
        req.end(body);
    });
}
const ask = (token = TOKEN, step = 'gate-1') => call(token, JSON.stringify({ step }));

describe('POST /gate-token', () => {
    it('answers a held gate step the board’s token and expiry, uncacheable', async () => {
        await holdGate();
        const response = await ask();
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ token: 'ghs_1', expiresAt: '2030-01-01T00:00:00.000Z' });
        expect(response.cache).toBe('no-store');
    });

    it('is the supervisor token’s alone: the agent and exporter tokens get 403, an unknown one 401', async () => {
        await holdGate();
        expect((await ask(AGENT)).status).toBe(403);
        expect((await ask(EXPORTER)).status).toBe(403);
        expect((await ask('unknown')).status).toBe(401);
        expect(asks).toBe(0);
    });

    it('answers 409 and never asks the board for a step the supervisor does not hold', async () => {
        const queued = steps.submit(TOKEN, gate);
        queued.catch(() => undefined);
        expect((await ask()).status).toBe(409);
        await steps.next(TOKEN, 0, never);
        expect((await ask(TOKEN, 'another-gate')).status).toBe(409);
        expect(asks).toBe(0);
    });

    it('answers 503 retryable for an ask the board did not answer, never a 200 with no token', async () => {
        await holdGate();
        answer = async () => ({ kind: 'unanswered' });
        const response = await ask();
        expect(response.status).toBe(503);
        expect(JSON.parse(response.body)).toMatchObject({ retryable: true });
        answer = async () => {
            throw new Error('boom');
        };
        expect((await ask()).status).toBe(503);
    });

    it('answers 409 for a refusal and for an attempt that is gone', async () => {
        await holdGate();
        answer = async () => ({ kind: 'refused' });
        expect((await ask()).status).toBe(409);
        answer = async () => 'gone';
        expect((await ask()).status).toBe(409);
    });

    it('answers 400 to a body that names no step, and 413 past 1 KiB', async () => {
        await holdGate();
        expect((await call(TOKEN, '{}')).status).toBe(400);
        expect((await call(TOKEN, 'not json')).status).toBe(400);
        expect((await call(TOKEN, JSON.stringify({ step: 'gate-1', pad: 'x'.repeat(4096) }))).status).toBe(413);
        expect(asks).toBe(0);
    });

    it('answers 503 until the loop attaches a relay', async () => {
        channel.close(TOKEN);
        channel.open(TOKEN);
        await holdGate();
        expect((await ask()).status).toBe(503);
    });

    it('does not answer 200 when the step settles while the board is asked', async () => {
        const { settled } = await holdGate();
        let release: () => void = () => {};
        const board = new Promise<void>((resolve) => {
            release = resolve;
        });
        answer = async () => {
            await board;
            return grant('ghs_late');
        };
        const pending = ask();
        while (asks === 0) await new Promise((resolve) => setTimeout(resolve, 1));
        steps.settle(TOKEN, 'gate-1', 'i-1', { exitCode: 0, stdout: '', stderr: '', timedOut: false });
        await settled;
        release();
        const response = await pending;
        expect(response.status).toBe(409);
        expect(response.body).not.toContain('ghs_late');
    });

    it('aborts the relay’s signal only when the supervisor hangs up, not once its body was read', async () => {
        await holdGate();
        let seen: AbortSignal | undefined;
        channel.attachGateToken(TOKEN, {
            token: (signal) => {
                seen = signal;
                return new Promise(() => undefined);
            },
        });
        const req = httpRequest(`${base}/gate-token`, {
            method: 'POST',
            headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        });
        req.on('error', () => undefined);
        req.end(JSON.stringify({ step: 'gate-1' }));
        while (!seen) await new Promise((resolve) => setTimeout(resolve, 1));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(seen.aborted).toBe(false);
        req.destroy();
        while (!seen.aborted) await new Promise((resolve) => setTimeout(resolve, 1));
    });
});
