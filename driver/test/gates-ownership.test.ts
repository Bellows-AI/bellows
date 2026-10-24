import { request as httpRequest, IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { loadDriverConfig } from '../src/config.js';
import { createGateServer, createSupervisedGateManager, type GateRunner } from '../src/gates.js';
import type { StepResult } from '../src/supervisor-contract.js';

/**
 * Resolves when the next request's handler has authorised its token and begun reading the body:
 * `readBody` iterates the request only past the token check. Hooked on the builtin prototype, not
 * by `vi.mock` — under `isolate: false` another file may already hold the real `http.js`.
 */
const nextBodyRead = (): Promise<void> =>
    new Promise((resolve) => {
        const proto = IncomingMessage.prototype as unknown as Record<symbol, unknown>;
        const iterate = proto[Symbol.asyncIterator] as (this: IncomingMessage) => AsyncIterator<unknown>;
        proto[Symbol.asyncIterator] = function (this: IncomingMessage) {
            delete proto[Symbol.asyncIterator];
            resolve();
            return iterate.call(this);
        };
    });

/**
 * The gate environment's owner (issue #436): release and cancel act only for the attempt the
 * checkout is filed under, a cancelled or hung-up ad-hoc request leaves nothing running, and one
 * attempt's end never touches another's gate. Every gate runs in its own attempt's task group
 * (issue #773), so the runner below records whose group each gate was asked of.
 */

const KEY = '55555555-5555-4555-8555-555555555555/factory';
const config = loadDriverConfig({});

const JOB = (lease: string): BoardJob => ({
    id: '55555555-5555-4555-8555-555555555555',
    command: 'fix the failing build',
    rootCommand: 'fix the failing build',
    attempts: 1,
    maxAttempts: 3,
    lastAttempt: false,
    claimSeq: 1,
    leaseToken: lease,
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
});
const LEASE_A = '22222222-2222-4222-8222-222222222222';
const LEASE_B = '33333333-3333-4333-8333-333333333333';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const passed: StepResult = { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };

/** The runner's gate step, answering `answer` and recording the lease of the group each gate ran in. */
function groupRunner(answer: (signal: AbortSignal | undefined) => Promise<StepResult> = async () => passed) {
    const leases: string[] = [];
    const runner: GateRunner = {
        runGate: (job, _gate, signal) => {
            leases.push(job.leaseToken);
            return answer(signal);
        },
    };
    return { runner, leases };
}

describe('gate ownership: ad-hoc cancel races', () => {
    /** A POST whose body is held back until `finish` — the agent's curl, mid-upload. */
    const slowPost = (port: number, token: string) => {
        const body = JSON.stringify({ gate: 'test' });
        const req = httpRequest({
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/run',
            headers: { authorization: `Bearer ${token}`, 'content-length': String(Buffer.byteLength(body)) },
        });
        const status = new Promise<number>((resolve, reject) => {
            req.on('response', (res) => {
                res.resume();
                resolve(res.statusCode ?? 0);
            });
            req.on('error', reject);
        });
        req.write(body.slice(0, 3));
        return { finish: () => req.end(body.slice(3)), status };
    };
    const claim = {
        key: KEY,
        image: 'node:24',
        job: JOB(LEASE_A),
        gates: [{ name: 'test', command: 't' }],
    };

    /** A server whose gate never answers; `signal()` is the one its run was given. */
    const hungServer = () => {
        let signal: AbortSignal | undefined;
        let started: () => void = () => {};
        const running = new Promise<void>((resolve) => {
            started = resolve;
        });
        const server = createGateServer({
            host: '127.0.0.1',
            manager: {
                acquire: async () => {},
                runGate: (_k, _n, _c, { signal: s } = {}) => {
                    signal = s;
                    started();
                    return new Promise(() => {}); // a 10-minute suite
                },
            },
        });
        return { server, running, signal: () => signal };
    };

    it('does not acquire (re-create) the environment for a request whose body lands after cancel', async () => {
        let acquires = 0;
        const server = createGateServer({
            host: '127.0.0.1',
            manager: {
                acquire: async () => {
                    acquires += 1;
                },
                runGate: async () => ({ exitCode: 0, output: '' }),
            },
        });
        server.register('tok', claim);
        const port = await server.listen();

        const reading = nextBodyRead();
        const post = slowPost(port, 'tok');
        await reading; // the handler has authorised the token and is reading the body
        server.cancel('tok');
        post.finish();

        expect(await post.status).toBe(409);
        expect(acquires).toBe(0);
        await server.close();
    });

    it('cancels the in-flight ad-hoc run when the session is released (unregister)', async () => {
        const { server, running, signal } = hungServer();
        server.register('tok', claim);
        const port = await server.listen();
        void fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: 'Bearer tok' },
            body: JSON.stringify({ gate: 'test' }),
        }).catch(() => undefined);
        await running;

        server.unregister('tok');

        expect(signal()?.aborted).toBe(true);
        await server.close();
    });

    it('cancels the ad-hoc run when the agent that asked for it hangs up', async () => {
        const { server, running, signal } = hungServer();
        server.register('tok', claim);
        const port = await server.listen();
        const client = new AbortController();
        void fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: 'Bearer tok' },
            body: JSON.stringify({ gate: 'test' }),
            signal: client.signal,
        }).catch(() => undefined);
        await running;

        client.abort(); // the runner was killed (timeout) — its curl is gone
        await delay(20);

        expect(signal()?.aborted).toBe(true);
        await server.close();
    });
});

describe('gate ownership: two attempts on one checkout key', () => {
    it('runs a gate in the group of the attempt the checkout is filed under when its turn comes', async () => {
        let finishA: (result: StepResult) => void = () => undefined;
        let calls = 0;
        const { runner, leases } = groupRunner(() =>
            calls++ === 0
                ? new Promise<StepResult>((resolve) => {
                      finishA = resolve;
                  })
                : Promise.resolve(passed)
        );
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: JOB(LEASE_A) });
        const gateA = manager.runGate(KEY, 'test', 'npm test');
        await delay(5);
        await manager.acquire(KEY, 'node:24', '', { job: JOB(LEASE_B) }); // reclaimed attempt, same root worktree
        const gateB = manager.runGate(KEY, 'test', 'npm test');
        finishA(passed);
        await gateA;
        await expect(gateB).resolves.toMatchObject({ exitCode: 0 });
        expect(leases).toEqual([LEASE_A, LEASE_B]);
    });

    it('attempt A’s release leaves attempt B’s checkout and its gate alone', async () => {
        const { runner, leases } = groupRunner();
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: JOB(LEASE_A) });
        await manager.acquire(KEY, 'node:24', '', { job: JOB(LEASE_B) });
        manager.release(KEY, JOB(LEASE_A)); // A's finally
        await expect(manager.runGate(KEY, 'test', 'npm test')).resolves.toMatchObject({ exitCode: 0 });
        expect(leases).toEqual([LEASE_B]);
    });

    it('cancelling attempt A’s gate does not fail attempt B’s gate queued behind it', async () => {
        let calls = 0;
        const { runner } = groupRunner((signal) =>
            calls++ === 0
                ? new Promise<StepResult>((resolve) => {
                      signal?.addEventListener('abort', () => resolve({ ...passed, exitCode: 130 }), { once: true });
                  })
                : Promise.resolve(passed)
        );
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: JOB(LEASE_A) });
        const cancelA = new AbortController();
        const gateA = manager.runGate(KEY, 'test', 'npm test', { signal: cancelA.signal });
        await delay(5);
        await manager.acquire(KEY, 'node:24', '', { job: JOB(LEASE_B) });
        const gateB = manager.runGate(KEY, 'test', 'npm test');
        cancelA.abort(); // A's lease is lost
        await gateA;
        await expect(gateB).resolves.toMatchObject({ exitCode: 0 });
    });
});

describe('gate ownership: pins', () => {
    it('an acquire and its release leave no gate environment behind', async () => {
        const { runner, leases } = groupRunner();
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: JOB(LEASE_A) });
        manager.release(KEY, JOB(LEASE_A));
        await expect(manager.runGate(KEY, 'test', 'npm test')).rejects.toThrow(/no gate environment/);
        expect(leases).toEqual([]);
    });

    it('two drivers’ managers on one checkout key never touch each other’s entry', async () => {
        const a = groupRunner();
        const b = groupRunner();
        const driverA = createSupervisedGateManager({ config, runner: a.runner });
        const driverB = createSupervisedGateManager({ config, runner: b.runner });
        await driverA.acquire(KEY, 'node:24', '', { job: JOB(LEASE_A) });
        await driverB.acquire(KEY, 'node:24', '', { job: JOB(LEASE_B) });
        driverA.release(KEY, JOB(LEASE_A));
        await expect(driverB.runGate(KEY, 'test', 'npm test')).resolves.toMatchObject({ exitCode: 0 });
        expect(a.leases).toEqual([]);
        expect(b.leases).toEqual([LEASE_B]);
    });
});
