import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
    createSupervisedGateManager,
    declaredTimeoutMs,
    type GateAttempt,
    type GateClaim,
    type GateManager,
    type GateRunOptions,
} from '../src/gates.js';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { TASK_MOUNT } from '../src/task-volume.js';
import { StepChannelClosed } from '../src/step-control.js';
import type { GateStepRequest } from '../src/supervised-steps.js';
import type { StepResult } from '../src/supervisor-contract.js';

/**
 * The supervised gate manager (issue #773) and the ad-hoc HTTP channel.
 *
 * The runner is stood in by `gateRunner`: every gate is one step the attempt's supervisor hands its
 * gate container, and every assertion is on the request the manager makes or the verdict it reports.
 * The server tests use a real socket on loopback, because the contract under test is HTTP.
 */

/**
 * A real socket cannot hand a test the `Server` handle — the gate server keeps it private — so
 * `createServer` is wrapped, not replaced: the real node:http still builds every server (the
 * suite's sockets stay real) and each instance is recorded for the one test that must reach it.
 */
const { createdServers } = vi.hoisted(() => ({
    createdServers: [] as import('node:http').Server[],
}));

vi.mock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    const realCreateServer = actual.createServer.bind(actual);
    const wrapped = ((handler?: import('node:http').RequestListener) => {
        const created = realCreateServer(handler);
        createdServers.push(created);
        return created;
    }) as typeof actual.createServer;
    return { ...actual, createServer: wrapped };
});

let createGateServer: typeof import('../src/gates.js')['createGateServer'];
/** The re-imported module's own error class: the server below tells a lost supervisor by `instanceof`. */
let LostChannel: typeof StepChannelClosed;

beforeAll(async () => {
    // isolate:false shares the module cache across files in a worker: when another file (loop,
    // k8s) evaluated gates.ts first, its node:http import is bound to the real module and the
    // wrapper above never sees a server. Reset + re-import binds the source to THIS file's mock.
    vi.resetModules();
    ({ createGateServer } = await import('../src/gates.js'));
    ({ StepChannelClosed: LostChannel } = await import('../src/step-control.js'));
});

const KEY = `55555555-5555-4555-8555-555555555555/factory`;
const config = loadDriverConfig({});

/** The attempt a gate runs under: its supervisor runs the gate. */
const JOB: BoardJob = {
    id: '55555555-5555-4555-8555-555555555555',
    command: 'fix the failing build',
    rootCommand: 'fix the failing build',
    attempts: 1,
    maxAttempts: 3,
    lastAttempt: false,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
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

/** The same attempt, whose checkout declares `setup: npm ci`. */
const WITH_SETUP: BoardJob = { ...JOB, gates: { image: 'node:24', setup: 'npm ci', gates: [] } };

/** docker's own "no such container" exit code — the harness state every rejection here reports. */
const CONTAINER_GONE_CODE = 125;
const OK_STATUS = 200;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;
const BAD_REQUEST_STATUS = 400;
const CONFLICT_STATUS = 409;
const PAYLOAD_TOO_LARGE_STATUS = 413;
const UNPROCESSABLE_STATUS = 422;
const UNAVAILABLE_STATUS = 503;

const answered = (exitCode: number | null, stdout = '', extra: Partial<StepResult> = {}): StepResult => ({
    exitCode,
    stdout,
    stderr: '',
    timedOut: false,
    ...extra,
});

/** One gate execution the manager asked of the runner: the attempt, the request and its cancel signal. */
interface GateCall {
    job: BoardJob;
    gate: GateStepRequest;
    signal: AbortSignal | undefined;
}

/**
 * The runner half of the supervised gates: what `runGate` would submit to the attempt's supervisor,
 * answered by `answer` — a step result, a rejection, or a promise the test settles.
 */
function gateRunner(
    answer: (call: GateCall, n: number) => StepResult | Error | Promise<StepResult> = () => answered(0)
) {
    const calls: GateCall[] = [];
    const runner = {
        runGate: async (job: BoardJob, gate: GateStepRequest, signal?: AbortSignal): Promise<StepResult> => {
            const call = { job, gate, signal };
            calls.push(call);
            const given = await answer(call, calls.length);
            if (given instanceof Error) throw given;
            return given;
        },
    };
    return { runner, calls };
}

const WORKTREE = `${TASK_MOUNT}/factory`;

describe('the supervised gate manager: one gate as a step', () => {
    it('runs a gate in the checkout’s worktree with the attempt’s env, and answers its exit and output', async () => {
        const { runner, calls } = gateRunner(() => answered(3, '1 failing\n', { stderr: 'npm ERR!\n' }));
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', 'A=1\nB=two words\n', { job: JOB });
        expect(await manager.runGate(KEY, 'test', 'npm test')).toEqual({ exitCode: 3, output: '1 failing\nnpm ERR!' });
        expect(calls).toEqual([
            {
                job: JOB,
                gate: {
                    command: 'npm test',
                    cwd: WORKTREE,
                    env: { A: '1', B: 'two words' },
                    timeoutMs: config.gateTimeoutMs,
                },
                signal: undefined,
            },
        ]);
    });

    it('hands each gate the env body of its newest acquire', async () => {
        const { runner, calls } = gateRunner();
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', 'GITHUB_TOKEN=ghs_one\n', { job: JOB });
        await manager.runGate(KEY, 'test', 'npm test');
        await manager.acquire(KEY, 'node:24', 'GITHUB_TOKEN=ghs_two\n', { job: JOB });
        await manager.runGate(KEY, 'test', 'npm test');
        expect(calls.map((call) => call.gate.env)).toEqual([{ GITHUB_TOKEN: 'ghs_one' }, { GITHUB_TOKEN: 'ghs_two' }]);
    });

    it('answers a gate killed at its deadline as the 124 of `timeout`, naming the deadline when it said nothing', async () => {
        const { runner } = gateRunner(() => answered(124, '', { timedOut: true }));
        const manager = createSupervisedGateManager({ config, runner, gateTimeoutMs: 30_000 });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        expect(await manager.runGate(KEY, 'test', 'npm test')).toEqual({
            exitCode: 124,
            output: '[driver] gate killed after 30000ms',
        });
    });

    it('bounds a gate by its own timeout, capped at DRIVER_JOB_TIMEOUT_MS, and setup by the default', async () => {
        const { runner, calls } = gateRunner();
        const capped = { ...config, jobTimeoutMs: 120_000 };
        const manager = createSupervisedGateManager({ config: capped, runner, gateTimeoutMs: 30_000 });
        await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
        await manager.runGate(KEY, 'ui', 'npm run verify:ui', { timeoutMs: 600_000 });
        expect(calls.map((call) => [call.gate.command, call.gate.timeoutMs])).toEqual([
            ['npm ci', 30_000],
            ['npm run verify:ui', 120_000],
        ]);
    });

    it.each([Number.NaN, 0, -5, Number.POSITIVE_INFINITY])('reads a timeoutMinutes of %s as none', (timeoutMinutes) => {
        expect(declaredTimeoutMs({ name: 'ui', command: 'x', timeoutMinutes })).toBeUndefined();
    });

    it('rejects a gate the supervisor answered with no exit as a harness failure, never a verdict', async () => {
        const { runner } = gateRunner(() => answered(null, '', { stderr: 'the gate container was lost mid-run' }));
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        await expect(manager.runGate(KEY, 'test', 'npm test')).rejects.toMatchObject({
            code: CONTAINER_GONE_CODE,
            message: expect.stringMatching(/lost mid-run/),
        });
    });

    it('rethrows a lost supervisor untouched: the attempt’s loss, never a failed gate', async () => {
        const lost = new StepChannelClosed('its step was answered');
        const { runner } = gateRunner(() => lost);
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
        await expect(manager.runGate(KEY, 'test', 'npm test')).rejects.toBe(lost);
        await expect(manager.runSetup(KEY)).rejects.toBe(lost);
    });

    it('hands the gate its cancel signal, and runs nothing for a Stop that landed while it queued', async () => {
        let finish: (result: StepResult) => void = () => undefined;
        const { runner, calls } = gateRunner((_call, n) =>
            n === 1
                ? new Promise<StepResult>((resolve) => {
                      finish = resolve;
                  })
                : answered(0)
        );
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        const first = manager.runGate(KEY, 'test', 'npm test');
        await until(() => calls.length === 1);
        const stop = new AbortController();
        const queued = manager.runGate(KEY, 'lint', 'npm run lint', { signal: stop.signal });
        stop.abort();
        // A Stop while queued answers at once, whatever holds the queue; the caller discards it.
        expect(await queued).toMatchObject({ exitCode: 130 });
        finish(answered(0));
        await first;
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(calls.map((call) => call.gate.command)).toEqual(['npm test']);
        const signal = new AbortController().signal;
        await manager.runGate(KEY, 'test', 'npm test', { signal });
        expect(calls[1]?.signal).toBe(signal);
    });

    it('serializes the gates of one checkout, so two suites never share a worktree at once', async () => {
        const order: string[] = [];
        const { runner } = gateRunner(async ({ gate }) => {
            order.push(`start ${gate.command}`);
            await new Promise((resolve) => setTimeout(resolve, 20));
            order.push(`end ${gate.command}`);
            return answered(0);
        });
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        await Promise.all([manager.runGate(KEY, 'a', 'a'), manager.runGate(KEY, 'b', 'b')]);
        expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
    });

    it('refuses an acquire with no attempt, a malformed checkout key or image, and a gate with no environment', async () => {
        const manager = createSupervisedGateManager({ config, runner: gateRunner().runner });
        await expect(manager.acquire(KEY, 'node:24', '')).rejects.toMatchObject({ code: CONTAINER_GONE_CODE });
        await expect(manager.acquire('../etc', 'node:24', '', { job: JOB })).rejects.toThrow(/checkout key/);
        await expect(manager.acquire(KEY, 'node:24; rm -rf /', '', { job: JOB })).rejects.toThrow(/image/);
        await expect(manager.runGate(KEY, 'test', 'npm test')).rejects.toMatchObject({ code: CONTAINER_GONE_CODE });
    });

    it('forgets the checkout at its own attempt’s release, and never at another’s', async () => {
        const manager = createSupervisedGateManager({ config, runner: gateRunner().runner });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        manager.release(KEY, { ...JOB, leaseToken: '99999999-9999-4999-8999-999999999999' });
        await expect(manager.runGate(KEY, 'test', 'npm test')).resolves.toMatchObject({ exitCode: 0 });
        manager.release(KEY, JOB);
        await expect(manager.runGate(KEY, 'test', 'npm test')).rejects.toMatchObject({ code: CONTAINER_GONE_CODE });
    });
});

describe('the supervised gate manager: setup', () => {
    it('runs a pending setup before the first gate, once it succeeds never again', async () => {
        const { runner, calls } = gateRunner();
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
        await manager.runGate(KEY, 'a', 'npm test');
        await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
        await manager.runGate(KEY, 'b', 'npm run lint');
        expect(calls.map((call) => call.gate.command)).toEqual(['npm ci', 'npm test', 'npm run lint']);
    });

    it('answers a failed setup as a setup failure, skips the gate, and retries setup before the next', async () => {
        const { runner, calls } = gateRunner((_call, n) => (n === 1 ? answered(1, 'registry down') : answered(0)));
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
        expect(await manager.runGate(KEY, 'a', 'npm test')).toEqual({
            exitCode: 1,
            output: 'registry down',
            setupFailed: true,
        });
        await manager.runGate(KEY, 'a', 'npm test');
        expect(calls.map((call) => call.gate.command)).toEqual(['npm ci', 'npm ci', 'npm test']);
    });

    it('runs setup now under the timeout it is given, and the first gate does not repeat it', async () => {
        const { runner, calls } = gateRunner();
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
        expect(await manager.runSetup(KEY, { timeoutMs: 900_000 })).toEqual({ exitCode: 0, output: '' });
        await manager.runGate(KEY, 'a', 'npm test');
        expect(calls.map((call) => [call.gate.command, call.gate.timeoutMs])).toEqual([
            ['npm ci', 900_000],
            ['npm test', config.gateTimeoutMs],
        ]);
    });

    it('leaves a failed setup pending, so the first gate retries it', async () => {
        const { runner, calls } = gateRunner((_call, n) => (n === 1 ? answered(2) : answered(0)));
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
        expect(await manager.runSetup(KEY)).toMatchObject({ exitCode: 2 });
        await manager.runGate(KEY, 'a', 'npm test');
        expect(calls.map((call) => call.gate.command)).toEqual(['npm ci', 'npm ci', 'npm test']);
    });

    it('answers null and runs nothing when the checkout declares no setup', async () => {
        const { runner, calls } = gateRunner();
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        expect(await manager.runSetup(KEY)).toBeNull();
        expect(calls).toEqual([]);
    });

    it('runs setup again for a new attempt on the same checkout', async () => {
        const { runner, calls } = gateRunner();
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
        await manager.runSetup(KEY);
        const next = { ...WITH_SETUP, leaseToken: '99999999-9999-4999-8999-999999999999' };
        await manager.acquire(KEY, 'node:24', '', { job: next });
        await manager.runGate(KEY, 'a', 'npm test');
        expect(calls.map((call) => [call.gate.command, call.job.leaseToken])).toEqual([
            ['npm ci', WITH_SETUP.leaseToken],
            ['npm ci', next.leaseToken],
            ['npm test', next.leaseToken],
        ]);
    });

    it('never lets a setup of one attempt settle the setup of the attempt that took the checkout over', async () => {
        let finish: (result: StepResult) => void = () => undefined;
        const { runner, calls } = gateRunner((_call, n) =>
            n === 1
                ? new Promise<StepResult>((resolve) => {
                      finish = resolve;
                  })
                : answered(0)
        );
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
        const setup = manager.runSetup(KEY);
        await until(() => calls.length === 1);
        const next = { ...WITH_SETUP, leaseToken: '99999999-9999-4999-8999-999999999999' };
        await manager.acquire(KEY, 'node:24', '', { job: next });
        finish(answered(0));
        await setup;
        await manager.runGate(KEY, 'a', 'npm test');
        expect(calls.map((call) => call.gate.command)).toEqual(['npm ci', 'npm ci', 'npm test']);
    });
});

const until = async (ready: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

/** A manager that acquires and passes every gate — for server tests about anything but the run. */
const idle = { acquire: async () => {}, runGate: async () => ({ exitCode: 0, output: '' }) };

/**
 * A loopback gate server with `token` registered for `gates` under JOB, already listening;
 * `run(gate)` is the agent's `POST /run` for one declared name under that token.
 */
async function serveGates(
    manager: Pick<GateManager, 'acquire' | 'runGate'>,
    {
        token = 'tok-1',
        gates = [{ name: 'test', command: 'npm test' }],
    }: { token?: string; gates?: GateClaim['gates'] } = {}
) {
    const server = createGateServer({ host: '127.0.0.1', manager });
    server.register(token, { key: KEY, image: 'node:24', job: JOB, gates });
    const port = await server.listen();
    const run = (gate = 'test') =>
        fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({ gate }),
        });
    return { server, port, run };
}

describe('the gate server', () => {
    it('runs a declared gate for a bearer token and answers the verdict', async () => {
        const seen: { key: string; name: string; command: string }[] = [];
        const acquiredFor: (BoardJob | undefined)[] = [];
        const manager = {
            // The job is the attempt context: the kubernetes manager refuses an acquire without
            // one, and the docker manager joins the attempt's services network by it.
            acquire: async (_key: string, _image: string, _envBody?: string, attempt?: GateAttempt) => {
                acquiredFor.push(attempt?.job);
            },
            runGate: async (key: string, name: string, command: string) => {
                seen.push({ key, name, command });
                return { exitCode: 0, output: 'ok' };
            },
        };
        const { server, run } = await serveGates(manager);

        const response = await run('test');
        expect(response.status).toBe(OK_STATUS);
        await expect(response.json()).resolves.toEqual({ exitCode: 0, output: 'ok' });
        expect(seen).toEqual([{ key: KEY, name: 'test', command: 'npm test' }]);
        expect(acquiredFor).toEqual([JOB]);
        await server.close();
    });

    // An ad-hoc run an hour into the agent's turn must not start on the token minted at gate setup.
    it('acquires an ad-hoc run with the env its claim asks for now, not the one it registered', async () => {
        const bodies: (string | undefined)[] = [];
        const manager = {
            acquire: async (_key: string, _image: string, envBody?: string) => {
                bodies.push(envBody);
            },
            runGate: async () => ({ exitCode: 0, output: 'ok' }),
        };
        const server = createGateServer({ host: '127.0.0.1', manager });
        let asked = 0;
        server.register('tok-fresh', {
            key: KEY,
            image: 'node:24',
            job: JOB,
            gates: [{ name: 'test', command: 'npm test' }],
            envBody: 'GITHUB_TOKEN=ghs_setup\n',
            freshEnv: async () => {
                asked += 1;
                return `GITHUB_TOKEN=ghs_run${asked}\n`;
            },
        });
        const port = await server.listen();
        for (let i = 0; i < 2; i++) {
            const response = await fetch(`http://127.0.0.1:${port}/run`, {
                method: 'POST',
                headers: { authorization: 'Bearer tok-fresh' },
                body: JSON.stringify({ gate: 'test' }),
            });
            expect(response.status).toBe(OK_STATUS);
        }
        expect(bodies).toEqual(['GITHUB_TOKEN=ghs_run1\n', 'GITHUB_TOKEN=ghs_run2\n']);
        await server.close();
    });

    // An ad-hoc call is a client waiting on one HTTP answer (the agent's shell tool gives up at
    // 10 minutes), and a hangup kills the run: a longer gate would die every time, so it is
    // refused up front and left to the end-of-run pass (issue #576).
    it('refuses an ad-hoc run of a gate whose timeout outlasts the call, before acquiring', async () => {
        let acquired = 0;
        let ran = 0;
        const manager = {
            acquire: async () => {
                acquired += 1;
            },
            runGate: async () => {
                ran += 1;
                return { exitCode: 0, output: '' };
            },
        };
        const { server, run } = await serveGates(manager, {
            gates: [{ name: 'ui', command: 'npm run verify:ui', timeoutMinutes: 11 }],
        });
        const response = await run('ui');
        expect(response.status).toBe(UNPROCESSABLE_STATUS);
        await expect(response.json()).resolves.toEqual({
            error: 'gate "ui" declares timeout: 11, longer than an ad-hoc run can wait (10 minutes); it runs in the end-of-run gates pass',
        });
        expect([acquired, ran]).toEqual([0, 0]);
        await server.close();
    });

    it("passes a declared gate's timeout to the manager in ms", async () => {
        const seen: (number | undefined)[] = [];
        const manager = {
            acquire: async () => {},
            runGate: async (_key: string, _name: string, _command: string, options?: GateRunOptions) => {
                seen.push(options?.timeoutMs);
                return { exitCode: 0, output: 'ok' };
            },
        };
        const { server, run } = await serveGates(manager, {
            gates: [
                { name: 'test', command: 'npm test' },
                { name: 'ui', command: 'npm run verify:ui', timeoutMinutes: 10 },
            ],
        });
        for (const gate of ['test', 'ui']) {
            const response = await run(gate);
            expect(response.status).toBe(OK_STATUS);
        }
        expect(seen).toEqual([undefined, 600_000]);
        await server.close();
    });

    it('runs an on-demand gate ad hoc, and refuses a long one without promising the end-of-run pass', async () => {
        const ran: string[] = [];
        const manager = {
            acquire: async () => {},
            runGate: async (_key: string, name: string) => {
                ran.push(name);
                return { exitCode: 0, output: 'ok' };
            },
        };
        const { server, run } = await serveGates(manager, {
            gates: [
                { name: 'smoke', command: 'npm run smoke', onDemand: true },
                { name: 'ui', command: 'npm run verify:ui', timeoutMinutes: 45, onDemand: true },
            ],
        });
        expect((await run('smoke')).status).toBe(OK_STATUS);
        const refused = await run('ui');
        expect(refused.status).toBe(UNPROCESSABLE_STATUS);
        await expect(refused.json()).resolves.toEqual({
            error: 'gate "ui" declares timeout: 45, longer than an ad-hoc run can wait (10 minutes); it is on_demand, so the end-of-run gates pass skips it too',
        });
        expect(ran).toEqual(['smoke']);
        await server.close();
    });

    it('refuses an unknown token, an undeclared gate and a malformed body', async () => {
        const { server, port } = await serveGates(idle, { token: 'tok-2' });
        const url = `http://127.0.0.1:${port}/run`;
        const post = (headers: Record<string, string>, body: string) => fetch(url, { method: 'POST', headers, body });

        expect((await post({ authorization: 'Bearer nope' }, '{"gate":"test"}')).status).toBe(UNAUTHORIZED_STATUS);
        expect((await post({ authorization: 'Bearer tok-2' }, '{"gate":"deploy"}')).status).toBe(NOT_FOUND_STATUS);
        expect((await post({ authorization: 'Bearer tok-2' }, 'not json')).status).toBe(BAD_REQUEST_STATUS);
        expect((await post({ authorization: 'Bearer tok-2' }, '{}')).status).toBe(BAD_REQUEST_STATUS);
        // A body that parses to a non-object is as malformed as one that does not parse.
        for (const body of ['null', '[]', '1']) {
            expect((await post({ authorization: 'Bearer tok-2' }, body)).status).toBe(BAD_REQUEST_STATUS);
        }
        // Only the declared name ever reaches the manager — never an arbitrary command string.
        expect((await post({ authorization: 'Bearer tok-2' }, '{"command":"rm -rf /"}')).status).toBe(
            BAD_REQUEST_STATUS
        );
        await server.close();
    });

    it('answers 409 when the environment container is gone mid-run', async () => {
        const manager = {
            acquire: async () => {},
            runGate: async () => {
                const error = new Error('Error response from daemon: No such container') as Error & {
                    code?: number;
                };
                error.code = CONTAINER_GONE_CODE;
                throw error;
            },
        };
        const { server, run } = await serveGates(manager, { token: 'tok-3' });
        const response = await run('test');
        expect(response.status).toBe(CONFLICT_STATUS);
        // A harness failure is not a verdict: nothing is recorded for the run.
        expect(server.lastRuns('tok-3')).toEqual([]);
        await server.close();
    });

    // The harness failure end to end: a gate the supervisor answered with no exit must not answer
    // 200 carrying a verdict for a gate that never ran — the 409 is the harness-failure answer.
    it('answers 409, never a verdict, when the supervisor answers the gate with no exit', async () => {
        const { runner } = gateRunner(() =>
            answered(null, '', { stderr: 'the gate container never took the request' })
        );
        const manager = createSupervisedGateManager({ config, runner });
        const { server, run } = await serveGates(manager, { token: 'tok-lost' });
        const response = await run('test');
        expect(response.status).toBe(CONFLICT_STATUS);
        expect(server.lastRuns('tok-lost')).toEqual([]);
        await server.close();
    });

    // Issue #773 (R1-2): the gate's supervisor lost is the attempt's loss — the agent's call answers
    // that it is incomplete, records nothing, and the claim is told, so the attempt is interrupted.
    it('answers an ad-hoc gate whose supervisor was lost as incomplete, and reports the loss', async () => {
        const { runner } = gateRunner(() => new LostChannel('its step was answered'));
        const manager = createSupervisedGateManager({ config, runner });
        const server = createGateServer({ host: '127.0.0.1', manager });
        const losses: string[] = [];
        server.register('tok-gone', {
            key: KEY,
            image: 'node:24',
            job: JOB,
            gates: [{ name: 'test', command: 'npm test' }],
            onInfraLoss: (reason) => losses.push(reason),
        });
        const port = await server.listen();
        const response = await fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: 'Bearer tok-gone' },
            body: JSON.stringify({ gate: 'test' }),
        });
        expect(response.status).toBe(UNAVAILABLE_STATUS);
        await expect(response.json()).resolves.toMatchObject({ incomplete: true });
        expect(server.lastRuns('tok-gone')).toEqual([]);
        expect(losses).toEqual([expect.stringMatching(/supervisor channel closed/)]);
        await server.close();
    });
});

describe('the gate server: run control (issue #442)', () => {
    const read = (port: number, token: string) =>
        fetch(`http://127.0.0.1:${port}/control`, { headers: { authorization: `Bearer ${token}` } });

    it('answers stop=false until a stop is raised, then true — idempotently, per token', async () => {
        const server = createGateServer({ host: '127.0.0.1', manager: idle });
        server.openControl('tok-a');
        server.openControl('tok-b');
        const port = await server.listen();

        expect(server.controlPolled('tok-a')).toBe(false);
        await expect((await read(port, 'tok-a')).json()).resolves.toEqual({ stop: false, kill: false });
        expect(server.controlPolled('tok-a')).toBe(true);
        expect(server.controlPolled('tok-b')).toBe(false);
        server.raiseStop('tok-a');
        server.raiseStop('tok-a');
        await expect((await read(port, 'tok-a')).json()).resolves.toEqual({ stop: true, kill: false });
        // Another attempt's token is unaffected by the first one's stop.
        await expect((await read(port, 'tok-b')).json()).resolves.toEqual({ stop: false, kill: false });
        await server.close();
    });

    it('raises the kill order beside the stop, idempotently, for the one token only', async () => {
        const server = createGateServer({ host: '127.0.0.1', manager: idle });
        server.openControl('tok-a');
        server.openControl('tok-b');
        const port = await server.listen();

        server.raiseKill('tok-a');
        server.raiseKill('tok-a');
        server.raiseKill('unknown');
        await expect((await read(port, 'tok-a')).json()).resolves.toEqual({ stop: true, kill: true });
        await expect((await read(port, 'tok-b')).json()).resolves.toEqual({ stop: false, kill: false });
        await server.close();
    });

    // Two tokens of one lease open different doors: the supervisor's the run's control, the agent's
    // only the publish and review routes the baked skills call.
    it('opens the control routes to the supervisor token only, and publish and review to the agent token only', async () => {
        const server = createGateServer({ host: '127.0.0.1', manager: idle });
        server.openControl('sup', undefined, { publish: async () => 'unsupported' });
        server.grantAgent('sup', 'agent');
        const port = await server.listen();
        const get = (path: string, token: string) =>
            fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } });
        const post = (path: string, token: string) =>
            fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

        expect((await post('/publish', 'agent')).status).not.toBe(FORBIDDEN_STATUS);
        // The agent's own calls never say a supervisor is listening.
        expect(server.controlPolled('sup')).toBe(false);
        expect((await get('/control', 'agent')).status).toBe(FORBIDDEN_STATUS);
        expect((await get('/export/chunk', 'agent')).status).toBe(FORBIDDEN_STATUS);
        expect((await post('/publish', 'sup')).status).toBe(FORBIDDEN_STATUS);
        expect((await get('/control', 'sup')).status).toBe(OK_STATUS);
        expect(server.controlPolled('sup')).toBe(true);
        server.closeControl('sup');
        expect((await post('/publish', 'agent')).status).toBe(UNAUTHORIZED_STATUS);
        expect((await get('/control', 'sup')).status).toBe(UNAUTHORIZED_STATUS);
        await server.close();
    });

    it('opens without any gate registration and refuses unknown or closed tokens', async () => {
        const server = createGateServer({ host: '127.0.0.1', manager: idle });
        server.openControl('tok-c');
        const port = await server.listen();

        expect((await read(port, 'tok-c')).status).toBe(OK_STATUS);
        expect((await read(port, 'nope')).status).toBe(UNAUTHORIZED_STATUS);
        server.raiseStop('unknown');
        server.closeControl('tok-c');
        expect((await read(port, 'tok-c')).status).toBe(UNAUTHORIZED_STATUS);
        await server.close();
    });

    it('does not let a gate token read the control channel', async () => {
        const { server, port } = await serveGates(idle, { token: 'gate-tok', gates: [] });

        expect((await read(port, 'gate-tok')).status).toBe(UNAUTHORIZED_STATUS);
        await server.close();
    });
});

describe('the gate server: questions (issue #226)', () => {
    const report = (id: string, text = 'Which colour?') => ({
        questionId: id,
        questions: [
            { question: text, header: 'Colour', multiSelect: false, options: [{ label: 'Blue' }, { label: 'Red' }] },
        ],
    });
    const post = (port: number, token: string, body: unknown) =>
        fetch(`http://127.0.0.1:${port}/question`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: typeof body === 'string' ? body : JSON.stringify(body),
        });
    const get = (port: number, token: string, id: string) =>
        fetch(`http://127.0.0.1:${port}/question/${id}`, { headers: { authorization: `Bearer ${token}` } });

    async function opened(verdict: 'accepted' | 'refused' | 'gone' = 'accepted') {
        const forwarded: string[] = [];
        const server = createGateServer({ host: '127.0.0.1', manager: idle });
        server.openControl('tok-q', {
            ask: async (id) => {
                forwarded.push(id);
                return verdict;
            },
        });
        return { server, forwarded, port: await server.listen() };
    }

    it('records a question, answers 202 pending and forwards it once however often it repeats', async () => {
        const { server, forwarded, port } = await opened();

        const first = await post(port, 'tok-q', report('toolu_1'));
        expect(first.status).toBe(202);
        await expect(first.json()).resolves.toEqual({ state: 'pending' });
        expect((await post(port, 'tok-q', report('toolu_1'))).status).toBe(202);

        expect(forwarded).toEqual(['toolu_1']);
        expect(server.hasPendingQuestion('tok-q')).toBe(true);
        await server.close();
    });

    it('reads each state: pending, answered, cancelled — and 404 for an unknown id', async () => {
        const { server, port } = await opened();
        for (const id of ['toolu_1', 'toolu_2', 'toolu_3']) await post(port, 'tok-q', report(id, `Q ${id}?`));
        server.resolveQuestion('tok-q', 'toolu_1', { state: 'answered', answers: { 'Q toolu_1?': 'Blue' } });

        await expect((await get(port, 'tok-q', 'toolu_1')).json()).resolves.toEqual({
            state: 'answered',
            answers: { 'Q toolu_1?': 'Blue' },
        });
        await expect((await get(port, 'tok-q', 'toolu_2')).json()).resolves.toEqual({ state: 'pending' });
        await expect((await get(port, 'tok-q', 'toolu_3')).json()).resolves.toEqual({ state: 'pending' });
        server.cancelQuestions('tok-q');
        await expect((await get(port, 'tok-q', 'toolu_3')).json()).resolves.toEqual({ state: 'cancelled' });
        // A settled question is not reopened by a later answer or cancel.
        expect(server.resolveQuestion('tok-q', 'toolu_2', { state: 'answered', answers: {} })).toBe(false);
        await expect((await get(port, 'tok-q', 'toolu_2')).json()).resolves.toEqual({ state: 'cancelled' });
        expect((await get(port, 'tok-q', 'toolu_9')).status).toBe(NOT_FOUND_STATUS);
        await server.close();
    });

    it('answers 400 for a body the board would refuse, and 413 past 64 KiB', async () => {
        const { server, forwarded, port } = await opened();
        const bad = [
            'not json',
            { questionId: 'has space', questions: report('x').questions },
            { questionId: 'toolu_1', questions: [] },
            report('toolu_1', ''),
            {
                questionId: 'toolu_1',
                questions: [...report('a').questions, ...report('a').questions],
            },
            { questionId: 'toolu_1', questions: [{ ...report('a').questions[0], options: [{ label: 'One' }] }] },
        ];
        for (const body of bad) expect((await post(port, 'tok-q', body)).status).toBe(400);
        expect((await post(port, 'tok-q', report('toolu_1', 'x'.repeat(70_000)))).status).toBe(
            PAYLOAD_TOO_LARGE_STATUS
        );
        expect(forwarded).toEqual([]);
        await server.close();
    });

    it('answers 400 invalid question for a JSON body that is null or an array', async () => {
        const { server, forwarded, port } = await opened();
        for (const body of ['null', '[]']) {
            const response = await post(port, 'tok-q', body);
            expect(response.status).toBe(400);
            await expect(response.json()).resolves.toEqual({ error: 'invalid question' });
        }
        expect(forwarded).toEqual([]);
        await server.close();
    });

    it('refuses with 429 refused when the board is at its limit, and records nothing', async () => {
        const { server, port } = await opened('refused');
        const response = await post(port, 'tok-q', report('toolu_1'));
        expect(response.status).toBe(429);
        await expect(response.json()).resolves.toEqual({ state: 'refused' });
        expect((await get(port, 'tok-q', 'toolu_1')).status).toBe(NOT_FOUND_STATUS);
        await server.close();
    });

    it('refuses the sixth question of an attempt with 429', async () => {
        const { server, port } = await opened();
        for (const n of [1, 2, 3, 4, 5]) {
            expect((await post(port, 'tok-q', report(`toolu_${n}`, `Q${n}?`))).status).toBe(202);
        }
        const sixth = await post(port, 'tok-q', report('toolu_6', 'Q6?'));
        expect(sixth.status).toBe(429);
        await expect(sixth.json()).resolves.toEqual({ state: 'refused' });
        await server.close();
    });

    it('answers 401 for a gate token, an unknown token, and a token closed since', async () => {
        const { server, port } = await opened();
        server.register('gate-tok', { key: KEY, image: 'node:24', job: JOB, gates: [] });
        await post(port, 'tok-q', report('toolu_1'));

        expect((await post(port, 'gate-tok', report('toolu_1'))).status).toBe(UNAUTHORIZED_STATUS);
        expect((await get(port, 'gate-tok', 'toolu_1')).status).toBe(UNAUTHORIZED_STATUS);
        expect((await post(port, 'nope', report('toolu_1'))).status).toBe(UNAUTHORIZED_STATUS);
        server.closeControl('tok-q');
        expect((await post(port, 'tok-q', report('toolu_2'))).status).toBe(UNAUTHORIZED_STATUS);
        expect((await get(port, 'tok-q', 'toolu_1')).status).toBe(UNAUTHORIZED_STATUS);
        await server.close();
    });

    it('counts a question POST as the runner polling, and cancels a question asked after a stop', async () => {
        const { server, forwarded, port } = await opened();
        expect(server.controlPolled('tok-q')).toBe(false);
        await post(port, 'tok-q', report('toolu_1'));
        expect(server.controlPolled('tok-q')).toBe(true);

        server.raiseStop('tok-q');
        const late = await post(port, 'tok-q', report('toolu_2', 'Q2?'));
        await expect(late.json()).resolves.toEqual({ state: 'cancelled' });
        expect(forwarded).toEqual(['toolu_1']);
        await server.close();
    });

    it('drops the record when the forward fails, so the bridge retry forwards again', async () => {
        const server = createGateServer({ host: '127.0.0.1', manager: idle });
        let calls = 0;
        server.openControl('tok-q', {
            ask: async () => {
                calls += 1;
                if (calls === 1) throw new Error('board unreachable');
                return 'accepted';
            },
        });
        const port = await server.listen();

        expect((await post(port, 'tok-q', report('toolu_1'))).status).toBe(500);
        expect((await get(port, 'tok-q', 'toolu_1')).status).toBe(NOT_FOUND_STATUS);
        expect((await post(port, 'tok-q', report('toolu_1'))).status).toBe(202);
        expect(calls).toBe(2);
        await server.close();
    });
});

describe('the gate server: a repeat while the forward is in flight (issue #226)', () => {
    const body = JSON.stringify({
        questionId: 'toolu_1',
        questions: [
            {
                question: 'Which colour?',
                header: 'Colour',
                multiSelect: false,
                options: [{ label: 'Blue' }, { label: 'Red' }],
            },
        ],
    });

    it('answers the repeat as the first, so a failed forward fails both and the bridge retries', async () => {
        const server = createGateServer({ host: '127.0.0.1', manager: idle });
        let fail: (e: Error) => void = () => {};
        let calls = 0;
        server.openControl('tok-q', {
            ask: () => {
                calls += 1;
                if (calls > 1) return Promise.resolve('accepted' as const);
                return new Promise((_resolve, reject) => {
                    fail = reject;
                });
            },
        });
        const port = await server.listen();
        const post = () =>
            fetch(`http://127.0.0.1:${port}/question`, {
                method: 'POST',
                headers: { authorization: 'Bearer tok-q' },
                body,
            });

        const first = post();
        while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
        // The server parses a POST body synchronously before it joins an in-flight id, so the first
        // parse of this body after `first` is the repeat having reached the server: a fact, not a sleep.
        const parse = vi.spyOn(JSON, 'parse');
        const repeat = post();
        try {
            while (!parse.mock.calls.some(([text]) => text === body)) {
                await new Promise((resolve) => setTimeout(resolve, 1));
            }
        } finally {
            parse.mockRestore();
        }
        fail(new Error('board unreachable'));

        expect((await first).status).toBe(500);
        expect((await repeat).status).toBe(500);
        expect((await post()).status).toBe(202);
        expect(calls).toBe(2);
        await server.close();
    });
});

describe('the gate server: run history for the timeout note', () => {
    // A timed-out run's kill note quotes the latest ad-hoc verdicts (issue #339), so the server
    // records them as they complete: one entry per declared gate name, the latest run winning.
    it('records the latest run per gate name, and clears them on unregister', async () => {
        let call = 0;
        const manager = {
            acquire: async () => {},
            runGate: async (_key: string, name: string, _command: string) => {
                call += 1;
                return name === 'lint' ? { exitCode: 3, output: '2 problems' } : { exitCode: 0, output: 'ok' };
            },
        };
        const { server, run } = await serveGates(manager, {
            token: 'tok-hist',
            gates: [
                { name: 'test', command: 'npm test' },
                { name: 'lint', command: 'npm run lint' },
            ],
        });

        expect(server.lastRuns('tok-hist')).toEqual([]);
        await run('test');
        await run('lint');
        await run('test');
        const runs = server.lastRuns('tok-hist');
        expect(runs.map((r) => r.name)).toEqual(['test', 'lint']);
        expect(runs.find((r) => r.name === 'test')?.exitCode).toBe(0);
        expect(runs.find((r) => r.name === 'lint')?.exitCode).toBe(3);
        // Only the run of a DECLARED gate with a verdict is recorded, and each stamp is a real
        // moment the run completed — parseable, close to now.
        expect(runs.every((r) => !Number.isNaN(Date.parse(r.at)) && Date.parse(r.at) <= Date.now())).toBe(true);
        expect(call).toBe(3);

        server.unregister('tok-hist');
        expect(server.lastRuns('tok-hist')).toEqual([]);
        await server.close();
    });

    // The one channel to an agent mid-run (issue #487): a dead service's note rides every answer.
    it('carries the dead-service note in each answer until it is cleared or the token ends', async () => {
        const manager = { acquire: async () => {}, runGate: async () => ({ exitCode: 0, output: 'ok' }) };
        const served = await serveGates(manager, { token: 'tok-dead', gates: [{ name: 'test', command: 'x' }] });
        const { server } = served;
        const run = async () => (await served.run('test').then((r) => r.json())) as Record<string, unknown>;

        expect(await run()).toEqual({ exitCode: 0, output: 'ok' });
        server.setDeadServices('tok-dead', 'service "db" failed');
        expect(await run()).toEqual({ exitCode: 0, output: 'ok', deadServices: 'service "db" failed' });
        server.setDeadServices('tok-dead', null);
        expect(await run()).toEqual({ exitCode: 0, output: 'ok' });
        // An unknown token is ignored, never registered by the set.
        server.setDeadServices('tok-nobody', 'x');
        await server.close();
    });
});

describe('the gate server: body size and bind resilience', () => {
    // The endpoint is reachable from runner containers running repo-controlled instructions; an
    // unbounded body there is an OOM on the driver, which supervises every in-flight job.
    it('refuses an oversized body instead of reading it', async () => {
        const OVERSIZED_PADDING_LENGTH = 10_000;
        const { server, port } = await serveGates(idle, { token: 'tok-4' });
        const response = await fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: 'Bearer tok-4', 'content-type': 'application/json' },
            body: JSON.stringify({ gate: 'test', padding: 'x'.repeat(OVERSIZED_PADDING_LENGTH) }),
        });
        expect(response.status).toBe(PAYLOAD_TOO_LARGE_STATUS);
        await server.close();
    });

    // A failed bind must not poison the server: the next listen retries, it never answers port 0
    // forever — a driver that started with a bad GATE_LISTEN_HOST and was reconfigured would
    // otherwise hand every later gated job a gate URL nothing listens on.
    it('retries the bind after a failure instead of caching the broken server', async () => {
        const server = createGateServer({ host: '999.999.999.999', manager: idle });
        server.register('tok-5', {
            key: KEY,
            image: 'node:24',
            job: JOB,
            gates: [{ name: 'test', command: 'npm test' }],
        });

        await expect(server.listen()).rejects.toThrow();
        // The retry re-attempts a fresh bind — here still failing (same bad host), which is the
        // point: a refusal, never a silent port 0.
        await expect(server.listen()).rejects.toThrow();
        await server.close();
    });

    // The 'error' listener must stay attached past a successful bind: a server error arriving
    // later, with the listener gone, would surface as an uncaught exception and take the driver
    // down. Emitted here the way the runtime would deliver it — absorbed while a listener is
    // attached, a synchronous throw without one.
    it('keeps an error listener attached after the bind succeeds', async () => {
        const before = createdServers.length;
        const { server, port } = await serveGates(idle, { token: 'tok-late' });
        expect(port).toBeGreaterThan(0);

        const bound = createdServers.slice(before).at(-1)!;
        expect(bound.listenerCount('error')).toBe(1);
        // A late error, arriving after the bind resolved: absorbed, never thrown.
        expect(() => bound.emit('error', new Error('late failure'))).not.toThrow();
        await server.close();
    });
});

/** A Stop or Remove ends a gate where it stands: the docker exec's process dies with its environment. */
describe('cancelling a gate', () => {
    it('hands the abort to the gate’s step, which the supervisor kills, and answers what it left', async () => {
        const { runner, calls } = gateRunner(({ signal }) =>
            signal
                ? new Promise<StepResult>((resolve) => {
                      signal.addEventListener('abort', () => resolve(answered(130, 'killed')), { once: true });
                  })
                : answered(0)
        );
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        const cancel = new AbortController();
        const gate = manager.runGate(KEY, 'test', 'npm test', { signal: cancel.signal });
        await until(() => calls.length === 1);
        cancel.abort();
        await expect(gate).resolves.toMatchObject({ exitCode: 130 });
        // The checkout stays the attempt's: the next gate runs in it.
        await expect(manager.runGate(KEY, 'test', 'npm test')).resolves.toBeDefined();
    });

    it('runs nothing for a signal already aborted', async () => {
        const { runner, calls } = gateRunner();
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        await manager.runGate(KEY, 'test', 'npm test', { signal: AbortSignal.abort() });
        expect(calls).toEqual([]);
    });

    // The agent's own ad-hoc runs: the runner kill never reaches them, the token's cancel does.
    it('cancels an in-flight ad-hoc run on the server, answers 409 and refuses the token after', async () => {
        let aborted = false;
        let started: () => void = () => {};
        const running = new Promise<void>((resolve) => {
            started = resolve;
        });
        const manager = {
            acquire: async () => {},
            runGate: (_key: string, _name: string, _command: string, { signal }: GateRunOptions = {}) =>
                new Promise<{ exitCode: number; output: string }>((resolve) => {
                    started();
                    signal?.addEventListener('abort', () => {
                        aborted = true;
                        resolve({ exitCode: 137, output: 'killed' });
                    });
                }),
        };
        const { server, run: post } = await serveGates(manager, {
            token: 'tok-cancel',
            gates: [{ name: 'test', command: 't' }],
        });

        const inFlight = post();
        await running;
        server.cancel('tok-cancel');

        expect((await inFlight).status).toBe(CONFLICT_STATUS);
        expect(aborted).toBe(true);
        // A cancelled run is no verdict: nothing for the timeout note to quote.
        expect(server.lastRuns('tok-cancel')).toEqual([]);
        expect((await post()).status).toBe(UNAUTHORIZED_STATUS);
        await server.close();
    });
});

describe('the gate server: departing a token (#829)', () => {
    /** An attempt of three tokens, and another attempt beside it. */
    async function departable() {
        const server = createGateServer({ host: '127.0.0.1', manager: idle });
        server.openControl('sup', undefined, { publish: async () => 'unsupported' });
        server.grantAgent('sup', 'agent');
        server.grantExporter('sup', 'exp');
        server.openControl('other');
        const port = await server.listen();
        const call = (token: string, method: string, path: string) =>
            fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
        return { server, port, call };
    }

    it('hangs up on every route of a departed attempt, whichever token calls: no answer, never a 401', async () => {
        const { server, call } = await departable();
        server.departControl('sup', 60_000);

        for (const [token, method, path] of [
            ['sup', 'GET', '/control'],
            ['sup', 'GET', '/step?wait=0'],
            ['sup', 'POST', '/step/s-1'],
            ['sup', 'POST', '/report'],
            ['sup', 'POST', '/question'],
            ['agent', 'POST', '/publish'],
            ['agent', 'POST', '/review'],
            ['exp', 'GET', '/export/chunk'],
            ['sup', 'GET', '/anything-else'],
        ] as const) {
            await expect(call(token, method, path), `${token} ${method} ${path}`).rejects.toThrow();
        }
        await server.close();
    });

    it('keeps serving the other attempts of the server', async () => {
        const { server, call } = await departable();
        server.departControl('sup', 60_000);

        expect((await call('other', 'GET', '/control')).status).toBe(OK_STATUS);
        await server.close();
    });

    it('answers a long poll already in flight at the departure as an empty poll, not as a closed token', async () => {
        const { server, call } = await departable();
        const polling = call('sup', 'GET', '/step?wait=30000');
        await until(() => server.controlPolled('sup'));
        server.departControl('sup', 60_000);

        const answer = await polling;
        expect(answer.status).toBe(OK_STATUS);
        expect(await answer.json()).toEqual({});
        await server.close();
    });

    it('answers 401 as an unknown token once the departure bound passes, and not before', async () => {
        const { server, call } = await departable();
        server.departControl('sup', 150);

        await expect(call('sup', 'GET', '/control')).rejects.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect((await call('sup', 'GET', '/control')).status).toBe(UNAUTHORIZED_STATUS);
        expect((await call('agent', 'POST', '/publish')).status).toBe(UNAUTHORIZED_STATUS);
        await server.close();
    });

    it('forgets the earlier batch after its own bound when the control token departs again', async () => {
        const { server, call } = await departable();
        server.departControl('sup', 150);
        server.departControl('sup', 60_000);

        await new Promise((resolve) => setTimeout(resolve, 300));

        expect((await call('agent', 'POST', '/publish')).status).toBe(UNAUTHORIZED_STATUS);
        expect((await call('exp', 'GET', '/export/chunk')).status).toBe(UNAUTHORIZED_STATUS);
        await expect(call('sup', 'GET', '/control')).rejects.toThrow();
        await server.close();
    });
});
