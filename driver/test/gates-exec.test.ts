import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createSupervisedGateManager, type GateManager, type GateRunOptions } from '../src/gate-manager.js';
import type { GateClaim, GateLedger } from '../src/gates.js';
import type { BoardJob } from '../src/board/board.js';
import { loadDriverConfig } from '../src/config.js';
import type { StepChannelClosed } from '../src/step-control.js';
import type { GateStepRequest } from '../src/supervised-steps.js';
import type { StepResult } from '../src/supervisor-contract.js';

/**
 * `{"tool": "exec", "input": {"command": "<command>"}}` on the ad-hoc endpoint runs an arbitrary command in the attempt's own
 * gate container — unrecorded, tokenless, without the pending setup, under the ad-hoc 10-minute cap, and
 * one at a time with the checkout's gates. The server half over a real loopback socket; the manager half
 * against a stand-in runner, as `gates.test.ts` does.
 */

let createGateServer: typeof import('../src/gates.js')['createGateServer'];
/** The re-imported module's own error class: the server tells a lost supervisor by `instanceof`. */
let LostChannel: typeof StepChannelClosed;

beforeAll(async () => {
    // isolate:false shares the module cache: re-import so `stepLost` and this file agree on the class.
    vi.resetModules();
    ({ createGateServer } = await import('../src/gates.js'));
    ({ StepChannelClosed: LostChannel } = await import('../src/step-control.js'));
});

const KEY = '66666666-6666-4666-8666-666666666666/factory';
const config = loadDriverConfig({});
const TEN_MINUTES_MS = 600_000;

const JOB: BoardJob = {
    id: '66666666-6666-4666-8666-666666666666',
    command: 'fix the failing build',
    rootCommand: 'fix the failing build',
    attempts: 1,
    maxAttempts: 3,
    lastAttempt: false,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    ingestToken: '33333333-3333-4333-8333-333333333333',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    executorRefusal: null,
    planRefusal: null,
    skillRefusal: null,
    masterPrompt: 'You are running inside Factory.',
    resumeSessionId: null,
    followUp: false,
    ownSession: false,
    continuesInterrupted: false,
    userId: '44444444-4444-4444-8444-444444444444',
    workspacePath: 'bellows/44444444-4444-4444-8444-444444444444',
};

const OK = 200;
const BAD_REQUEST = 400;
const CONFLICT = 409;
const TOO_LARGE = 413;
const UNAVAILABLE = 503;

interface Seen {
    key: string;
    name: string;
    command: string;
    options: GateRunOptions | undefined;
}

/** A manager that records each run and answers `answer`, for the server half. */
function recordingManager(answer: (seen: Seen) => Promise<{ exitCode: number | null; output: string }> | Error) {
    const seen: Seen[] = [];
    const manager: Pick<GateManager, 'acquire' | 'runGate'> = {
        acquire: async () => {},
        runGate: async (key, name, command, options) => {
            const call = { key, name, command, options };
            seen.push(call);
            const given = await answer(call);
            if (given instanceof Error) throw given;
            return given;
        },
    };
    return { manager, seen };
}

/** A ledger whose every write is counted: an exec must never reach it. */
function countingLedger(): { ledger: GateLedger; writes: unknown[] } {
    const writes: unknown[] = [];
    return {
        writes,
        ledger: {
            probe: async () => ({ ok: false }) as never,
            identity: () => 'id',
            write: async (row) => {
                writes.push(row);
                return true;
            },
        },
    };
}

async function serveExec(
    manager: Pick<GateManager, 'acquire' | 'runGate'>,
    claim: Partial<GateClaim> = {},
    token = 'tok-exec'
) {
    const server = createGateServer({ host: '127.0.0.1', manager });
    server.register(token, { key: KEY, image: 'node:24', job: JOB, gates: [], ...claim });
    const port = await server.listen();
    const post = (body: string, signal?: AbortSignal) =>
        fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body,
            ...(signal ? { signal } : {}),
        });
    const exec = (command: string, signal?: AbortSignal) =>
        post(JSON.stringify({ tool: 'exec', input: { command } }), signal);
    return { server, post, exec };
}

const until = async (ready: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('an exec run on the gate server', () => {
    it('runs the requested command unrecorded', async () => {
        const { manager, seen } = recordingManager(async () => ({ exitCode: 0, output: 'hi' }));
        const { ledger, writes } = countingLedger();
        const { server, exec } = await serveExec(manager, {
            gates: [{ name: 'test', command: 'npm test' }],
            ledger,
        });
        const response = await exec('echo hi');
        expect(response.status).toBe(OK);
        await expect(response.json()).resolves.toEqual({ exitCode: 0, output: 'hi', artifacts: [] });
        expect(seen).toHaveLength(1);
        expect(seen[0]?.key).toBe(KEY);
        expect(seen[0]?.command).toBe('echo hi');
        expect(seen[0]?.options?.exec).toBe(true);
        expect(seen[0]?.options?.execution).toBeUndefined();
        expect(writes).toEqual([]);
        await server.close();
    });

    it('runs on an image-only claim that declares no gates', async () => {
        const { manager, seen } = recordingManager(async () => ({ exitCode: 2, output: 'nope' }));
        const { server, exec } = await serveExec(manager, { gates: [] });
        const response = await exec('false');
        expect(response.status).toBe(OK);
        await expect(response.json()).resolves.toEqual({ exitCode: 2, output: 'nope', artifacts: [] });
        expect(seen.map((call) => call.command)).toEqual(['false']);
        await server.close();
    });

    it('an exec call answers the shared shape with no verdict and no executionId', async () => {
        const { manager } = recordingManager(async () => ({ exitCode: 1, output: 'boom' }));
        const { ledger } = countingLedger();
        const { server, exec } = await serveExec(manager, { gates: [{ name: 'test', command: 'npm test' }], ledger });
        const body = (await (await exec('false')).json()) as Record<string, unknown>;
        expect(body).toEqual({ exitCode: 1, output: 'boom', artifacts: [] });
        expect(body).not.toHaveProperty('verdict');
        expect(body).not.toHaveProperty('executionId');
        await server.close();
    });

    it("never becomes a gate's latest run", async () => {
        const { manager } = recordingManager(async () => ({ exitCode: 0, output: '' }));
        const { server, exec } = await serveExec(manager, { gates: [{ name: 'test', command: 'npm test' }] });
        expect((await exec('npm test')).status).toBe(OK);
        expect(server.lastRuns('tok-exec')).toEqual([]);
        await server.close();
    });

    it('is refused while the token is quiesced', async () => {
        const { manager, seen } = recordingManager(async () => ({ exitCode: 0, output: '' }));
        const { server, exec } = await serveExec(manager);
        await server.quiesce('tok-exec');
        const response = await exec('echo hi');
        expect(response.status).toBe(UNAVAILABLE);
        await expect(response.json()).resolves.toMatchObject({ retryable: true });
        expect(seen).toEqual([]);
        await server.close();
    });

    it.each([
        ['an empty command', '{"tool":"exec","input":{"command":""}}'],
        ['a blank command', '{"tool":"exec","input":{"command":"   "}}'],
        ['a NUL byte', JSON.stringify({ tool: 'exec', input: { command: 'a\u0000b' } })],
        ['a non-string', '{"tool":"exec","input":{"command":1}}'],
        ['no input', '{"tool":"exec"}'],
        ['an input that is not an object', '{"tool":"exec","input":"x"}'],
        ['a key beside tool and input', '{"tool":"exec","input":{"command":"x"},"gate":"test"}'],
        ['a filter beside the command', '{"tool":"exec","input":{"command":"x","filter":"y"}}'],
        ['the old exec body', '{"exec":"x"}'],
    ])('refuses %s with 400 and runs nothing', async (_name, body) => {
        const { manager, seen } = recordingManager(async () => ({ exitCode: 0, output: '' }));
        const { server, post } = await serveExec(manager, { gates: [{ name: 'test', command: 'npm test' }] });
        expect((await post(body)).status).toBe(BAD_REQUEST);
        expect(seen).toEqual([]);
        await server.close();
    });

    it('refuses a body over 4096 bytes with 413', async () => {
        const { manager, seen } = recordingManager(async () => ({ exitCode: 0, output: '' }));
        const { server, exec } = await serveExec(manager);
        expect((await exec('x'.repeat(4096))).status).toBe(TOO_LARGE);
        expect(seen).toEqual([]);
        await server.close();
    });

    it('an unregister cancels it: the run signal aborts and the answer is 409 cancelled', async () => {
        let signal: AbortSignal | undefined;
        const { manager, seen } = recordingManager(
            (call) =>
                new Promise((resolve) => {
                    signal = call.options?.signal;
                    signal?.addEventListener('abort', () => resolve({ exitCode: 137, output: 'killed' }));
                })
        );
        const { server, exec } = await serveExec(manager);
        const inFlight = exec('sleep 600');
        await until(() => seen.length === 1);
        server.unregister('tok-exec');
        const response = await inFlight;
        expect(response.status).toBe(CONFLICT);
        await expect(response.json()).resolves.toEqual({ error: 'gate run cancelled' });
        expect(signal?.aborted).toBe(true);
        await server.close();
    });

    it('a hangup cancels it: the run signal aborts', async () => {
        let signal: AbortSignal | undefined;
        const { manager, seen } = recordingManager(
            (call) =>
                new Promise((resolve) => {
                    signal = call.options?.signal;
                    signal?.addEventListener('abort', () => resolve({ exitCode: 137, output: 'killed' }));
                })
        );
        const { server, exec } = await serveExec(manager);
        const agent = new AbortController();
        const inFlight = exec('sleep 600', agent.signal).catch(() => null);
        await until(() => seen.length === 1);
        agent.abort();
        await inFlight;
        await until(() => signal?.aborted === true);
        expect(signal?.aborted).toBe(true);
        await server.close();
    });

    it('a lost supervisor answers 503 incomplete and tells onInfraLoss', async () => {
        const runner = { runGate: async (): Promise<StepResult> => Promise.reject(new LostChannel('gone')) };
        const manager = createSupervisedGateManager({ config, runner });
        const losses: string[] = [];
        const { server, exec } = await serveExec(manager, { onInfraLoss: (reason) => losses.push(reason) });
        const response = await exec('echo hi');
        expect(response.status).toBe(UNAVAILABLE);
        await expect(response.json()).resolves.toMatchObject({ incomplete: true });
        expect(losses).toHaveLength(1);
        await server.close();
    });

    it('carries deadServices', async () => {
        const { manager } = recordingManager(async () => ({ exitCode: 0, output: 'ok' }));
        const { server, exec } = await serveExec(manager);
        server.setDeadServices('tok-exec', 'service "db" failed');
        const response = await exec('echo ok');
        await expect(response.json()).resolves.toEqual({
            exitCode: 0,
            output: 'ok',
            artifacts: [],
            deadServices: 'service "db" failed',
        });
        await server.close();
    });
});

interface GateCall {
    gate: GateStepRequest;
    signal: AbortSignal | undefined;
}

function gateRunner(answer: (call: GateCall, n: number) => StepResult | Promise<StepResult>) {
    const calls: GateCall[] = [];
    return {
        calls,
        runner: {
            runGate: async (_job: BoardJob, gate: GateStepRequest, signal?: AbortSignal): Promise<StepResult> => {
                const call = { gate, signal };
                calls.push(call);
                return answer(call, calls.length);
            },
        },
    };
}

const answered = (exitCode: number, stdout = ''): StepResult => ({ exitCode, stdout, stderr: '', timedOut: false });

describe('an exec run in the supervised gate manager', () => {
    it('skips a pending failed setup', async () => {
        const { runner, calls } = gateRunner(() => answered(0, 'ok'));
        const manager = createSupervisedGateManager({ config, runner });
        const withSetup: BoardJob = { ...JOB, gates: { image: 'node:24', setup: 'npm ci', gates: [] } };
        await manager.acquire(KEY, 'node:24', '', { job: withSetup });
        await expect(manager.runGate(KEY, 'exec', 'ls', { exec: true })).resolves.toEqual({
            exitCode: 0,
            output: 'ok',
        });
        expect(calls.map((call) => call.gate.command)).toEqual(['ls']);
        expect(calls[0]?.gate.env).not.toHaveProperty('FACTORY_GATE_SETUP');
    });

    it('is a tokenless step and never parallel', async () => {
        const { runner, calls } = gateRunner(() => answered(0));
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        await manager.runGate(KEY, 'exec', 'ls', { exec: true, parallel: true });
        expect(calls[0]?.gate.tokenless).toBe(true);
        expect(calls[0]?.gate).not.toHaveProperty('parallel');
    });

    it('names a GitLab job’s host in FACTORY_FORGE_HOSTS for a gate, never for an exec nor a GitHub job', async () => {
        const { runner, calls } = gateRunner(() => answered(0));
        const manager = createSupervisedGateManager({ config, runner });
        const gitlab: BoardJob = { ...JOB, repo: { forge: 'gitlab', host: 'GitLab.Example.com', path: 'group/app' } };
        await manager.acquire(KEY, 'node:24', 'FACTORY_FORGE_HOSTS=evil.example.com\n', { job: gitlab });
        await manager.runGate(KEY, 'test', 'npm test');
        await manager.runGate(KEY, 'exec', 'ls', { exec: true });
        expect(calls[0]?.gate.env.FACTORY_FORGE_HOSTS).toBe('gitlab.example.com');
        expect(calls[1]?.gate.env).not.toHaveProperty('FACTORY_FORGE_HOSTS');
        const github = gateRunner(() => answered(0));
        const plain = createSupervisedGateManager({ config, runner: github.runner });
        await plain.acquire(KEY, 'node:24', '', { job: JOB });
        await plain.runGate(KEY, 'test', 'npm test');
        expect(github.calls[0]?.gate.env).not.toHaveProperty('FACTORY_FORGE_HOSTS');
    });

    it('hands a gate of a GitLab job with a private CA its chain as FACTORY_FORGE_CA, one line, never a claimed one', async () => {
        const { runner, calls } = gateRunner(() => answered(0));
        const manager = createSupervisedGateManager({ config, runner });
        const pem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
        const gitlab: BoardJob = {
            ...JOB,
            repo: { forge: 'gitlab', host: 'gitlab.example.com', path: 'group/app' },
            forgeCa: pem,
        };
        await manager.acquire(KEY, 'node:24', 'FACTORY_FORGE_CA=claimed\n', { job: gitlab });
        await manager.runGate(KEY, 'test', 'npm test');
        await manager.runGate(KEY, 'exec', 'ls', { exec: true });
        expect(calls[0]?.gate.env.FACTORY_FORGE_CA).toBe('-----BEGIN CERTIFICATE-----,AAAA,-----END CERTIFICATE-----');
        expect(calls[1]?.gate.env).not.toHaveProperty('FACTORY_FORGE_CA');
        const plain = gateRunner(() => answered(0));
        const caless = createSupervisedGateManager({ config, runner: plain.runner });
        const { forgeCa: _ca, ...withoutCa } = gitlab;
        await caless.acquire(KEY, 'node:24', 'FACTORY_FORGE_CA=claimed\n', { job: withoutCa });
        await caless.runGate(KEY, 'test', 'npm test');
        expect(plain.calls[0]?.gate.env).not.toHaveProperty('FACTORY_FORGE_CA');
    });

    it('is capped at 10 minutes, even when the gate default is longer', async () => {
        const { runner, calls } = gateRunner(() => answered(0));
        const manager = createSupervisedGateManager({ config, runner, gateTimeoutMs: 3 * TEN_MINUTES_MS });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        await manager.runGate(KEY, 'exec', 'ls', { exec: true, timeoutMs: 3 * TEN_MINUTES_MS });
        expect(calls[0]?.gate.timeoutMs).toBe(Math.min(TEN_MINUTES_MS, config.jobTimeoutMs));
    });

    it('waits behind a running gate', async () => {
        let finishGate: (result: StepResult) => void = () => {};
        const { runner, calls } = gateRunner((_call, n) =>
            n === 1
                ? new Promise<StepResult>((resolve) => {
                      finishGate = resolve;
                  })
                : answered(0)
        );
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        const gate = manager.runGate(KEY, 'test', 'npm test');
        await until(() => calls.length === 1);
        const exec = manager.runGate(KEY, 'exec', 'ls', { exec: true });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(calls.map((call) => call.gate.command)).toEqual(['npm test']);
        finishGate(answered(0));
        await gate;
        await exec;
        expect(calls.map((call) => call.gate.command)).toEqual(['npm test', 'ls']);
    });
});
