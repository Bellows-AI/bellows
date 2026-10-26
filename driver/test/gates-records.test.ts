import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import type { GateRunRow } from '../src/board/board-gate-runs.js';
import { loadDriverConfig } from '../src/config.js';
import {
    createGateServer,
    createSupervisedGateManager,
    type GateClaim,
    type GateLedger,
    type GateRunStart,
} from '../src/gates.js';
import { StepChannelClosed } from '../src/step-control.js';
import type { GateStepRequest } from '../src/supervised-steps.js';
import type { StepResult } from '../src/supervisor-contract.js';

/**
 * The record of each gate run (issue #983): the ad-hoc endpoint writes a `running` row durably before
 * the gate executes — a write the board did not take refuses the call and the gate never starts — and
 * exactly one terminal row on every exit; the tree is probed inside the checkout's queue, just before
 * and just after the gate, so a run queued behind another never reads the other's tree. One real
 * manager and server over a fake runner: both executors share this code, so this is the parity pin.
 */
const KEY = `55555555-5555-4555-8555-555555555555/factory`;
const config = loadDriverConfig({});
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
const WITH_SETUP: BoardJob = { ...JOB, gates: { image: 'node:24', setup: 'npm ci', gates: [] } };

const answered = (exitCode: number | null, extra: Partial<StepResult> = {}): StepResult => ({
    exitCode,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...extra,
});

const until = async (ready: () => boolean): Promise<void> => {
    for (let i = 0; i < 400 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    if (!ready()) throw new Error('the awaited state never came');
};

type Probe = GateLedger['probe'];
const BEFORE = { fingerprint: 'h:before', mutatedSince: null };
const AFTER = { fingerprint: 'h:after', mutatedSince: false };

interface Options {
    answer?: (call: { gate: GateStepRequest }, n: number) => StepResult | Error | Promise<StepResult>;
    probe?: Probe;
    probeTimeoutMs?: number;
    /** The board's answer to one write; true (the row landed) when absent. */
    write?: (row: GateRunRow) => boolean | Promise<boolean>;
    gates?: GateClaim['gates'];
    job?: BoardJob;
}

async function harness(options: Options = {}) {
    const rows: GateRunRow[] = [];
    const events: string[] = [];
    const probeCalls: (number | undefined)[] = [];
    const execs: GateStepRequest[] = [];
    const runner = {
        runGate: async (_job: BoardJob, gate: GateStepRequest): Promise<StepResult> => {
            events.push('exec');
            execs.push(gate);
            const given = await (options.answer?.({ gate }, execs.length) ?? answered(0));
            if (given instanceof Error) throw given;
            return given;
        },
    };
    const manager = createSupervisedGateManager({ config, runner, probeTimeoutMs: options.probeTimeoutMs ?? 100 });
    const ledger: GateLedger = {
        probe:
            options.probe ??
            (async (_signal, sinceMs) => {
                probeCalls.push(sinceMs);
                return sinceMs === undefined ? BEFORE : AFTER;
            }),
        identity: (gate) => `id-${gate.name}`,
        write: async (row) => {
            events.push(`write:${row.outcome}`);
            rows.push({ ...row });
            return options.write ? options.write(row) : true;
        },
    };
    const infraLoss: string[] = [];
    const server = createGateServer({ host: '127.0.0.1', manager });
    server.register('tok', {
        key: KEY,
        image: 'node:24',
        job: options.job ?? JOB,
        gates: options.gates ?? [{ name: 'test', command: 'npm test' }],
        ledger,
        onInfraLoss: (reason) => infraLoss.push(reason),
    });
    const port = await server.listen();
    const run = (gate = 'test', filter?: string, signal?: AbortSignal) =>
        fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: 'Bearer tok' },
            body: JSON.stringify({ gate, ...(filter === undefined ? {} : { filter }) }),
            ...(signal ? { signal } : {}),
        });
    return { server, run, rows, events, probeCalls, execs, infraLoss };
}

describe('the gate server: execution records', () => {
    it('writes running before the gate executes and exactly one terminal row, and answers the execution id', async () => {
        const h = await harness();
        const response = await h.run();
        const body = (await response.json()) as { exitCode: number; output: string; executionId: string };

        expect(response.status).toBe(200);
        expect(h.events).toEqual(['write:running', 'exec', 'write:passed']);
        const [started, ended] = h.rows;
        expect(body).toEqual({ exitCode: 0, output: '', executionId: started!.executionId });
        expect(started).toMatchObject({
            gate: 'test',
            identity: 'id-test',
            filtered: false,
            source: 'adhoc',
            outcome: 'running',
            exitCode: null,
            treeBefore: 'h:before',
            treeAfter: null,
            finishedAt: null,
        });
        expect(Number.isNaN(Date.parse(started!.startedAt!))).toBe(false);
        expect(ended).toMatchObject({
            executionId: started!.executionId,
            outcome: 'passed',
            exitCode: 0,
            treeBefore: 'h:before',
            treeAfter: 'h:after',
            mutatedSince: false,
            startedAt: started!.startedAt,
        });
        expect(Date.parse(ended!.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(started!.startedAt!));
        // The mutation guard asks "since the run started", the moment the running row names.
        expect(h.probeCalls).toEqual([undefined, Date.parse(started!.startedAt!)]);
        await h.server.close();
    });

    it('records a failed gate with its exit code, and a fresh execution id per call', async () => {
        const h = await harness({ answer: (_c, n) => answered(n === 1 ? 3 : 0) });
        await h.run();
        await h.run();
        expect(h.rows.map((r) => r.outcome)).toEqual(['running', 'failed', 'running', 'passed']);
        expect(h.rows[1]).toMatchObject({ exitCode: 3 });
        expect(new Set(h.rows.map((r) => r.executionId)).size).toBe(2);
        await h.server.close();
    });

    it('records a filtered run as filtered', async () => {
        const h = await harness({ gates: [{ name: 'test', command: 'npm test', filter: true }] });
        await h.run('test', 'a b');
        expect(h.rows.map((r) => r.filtered)).toEqual([true, true]);
        await h.server.close();
    });

    it('carries a mutation the after-probe saw', async () => {
        const h = await harness({
            probe: async (_s, since) =>
                since === undefined ? BEFORE : { fingerprint: 'h:before', mutatedSince: true },
        });
        await h.run();
        expect(h.rows[1]).toMatchObject({ outcome: 'passed', treeAfter: 'h:before', mutatedSince: true });
        await h.server.close();
    });

    it('records a run cancelled while queued as not_started, and one hung up mid-run as incomplete', async () => {
        let release: (r: StepResult) => void = () => {};
        const h = await harness({
            answer: (_c, n) => (n === 1 ? new Promise<StepResult>((r) => (release = r)) : answered(0)),
        });
        const first = h.run();
        await until(() => h.rows.length === 1);
        // Queued behind the first, then hung up on.
        const hangup = new AbortController();
        const second = h.run('test', undefined, hangup.signal).catch(() => null);
        await new Promise((resolve) => setTimeout(resolve, 60));
        hangup.abort();
        await second;
        await until(() => h.rows.length === 2);
        expect(h.rows[1]).toMatchObject({ outcome: 'not_started', exitCode: null, treeAfter: null });
        release(answered(0));
        expect((await first).status).toBe(200);
        // The queued call never started, even once the queue freed: one exec, no row after its terminal one.
        expect(h.execs).toHaveLength(1);
        expect(h.rows.filter((r) => r.executionId === h.rows[1]!.executionId)).toHaveLength(1);

        // A hangup after the gate started leaves its result unknown.
        let held: (r: StepResult) => void = () => {};
        const g = await harness({ answer: () => new Promise<StepResult>((r) => (held = r)) });
        const abort = new AbortController();
        const running = g.run('test', undefined, abort.signal).catch(() => null);
        await until(() => g.execs.length === 1);
        abort.abort();
        await running;
        await until(() => g.rows.length === 2);
        expect(g.rows.map((r) => r.outcome)).toEqual(['running', 'incomplete']);
        held(answered(0));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(g.rows).toHaveLength(2);
        await h.server.close();
        await g.server.close();
    });

    it('records a lost supervisor as incomplete and tells the claim', async () => {
        const h = await harness({ answer: () => new StepChannelClosed('its step was answered') });
        const response = await h.run();
        expect(response.status).toBe(503);
        expect(h.rows.map((r) => r.outcome)).toEqual(['running', 'incomplete']);
        expect(h.infraLoss).toHaveLength(1);
        await h.server.close();
    });

    it('records a failed setup as setup_failed: one row, the gate never started', async () => {
        const h = await harness({ job: WITH_SETUP, answer: ({ gate }) => answered(gate.command === 'npm ci' ? 1 : 0) });
        const response = await h.run();
        expect(await response.json()).toMatchObject({ setupFailed: true, executionId: expect.any(String) });
        expect(h.rows.map((r) => r.outcome)).toEqual(['setup_failed']);
        expect(h.rows[0]).toMatchObject({ exitCode: 1, treeBefore: null, treeAfter: null, mutatedSince: null });
        expect(h.execs.map((e) => e.command)).toEqual(['npm ci']);
        await h.server.close();
    });

    it.each<[string, Probe]>([
        [
            'throws',
            async () => {
                throw new Error('probe container gone');
            },
        ],
        ['never answers', () => new Promise(() => {})],
        [
            'honours only its own deadline',
            (signal) =>
                new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
        ],
    ])('records null trees for a probe that %s, and still runs the gate', async (_what, probe) => {
        const h = await harness({ probe, probeTimeoutMs: 30 });
        const response = await h.run();
        expect(response.status).toBe(200);
        expect(h.execs).toHaveLength(1);
        expect(h.rows[0]).toMatchObject({ outcome: 'running', treeBefore: null });
        expect(h.rows[1]).toMatchObject({ outcome: 'passed', treeBefore: null, treeAfter: null, mutatedSince: null });
        await h.server.close();
    });

    it.each<[string, 'refused' | 'throws']>([
        ['is refused', 'refused'],
        ['throws', 'throws'],
    ])('still answers the agent when the terminal write %s', async (_what, mode) => {
        const h = await harness({
            write: (row) => {
                if (row.outcome === 'running') return true;
                if (mode === 'throws') throw new Error('the board is down');
                return false;
            },
        });
        const response = await h.run();
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ exitCode: 0 });
        await h.server.close();
    });

    it('refuses with a retryable error, and never starts the gate, when the running write fails', async () => {
        const h = await harness({ write: () => false });
        const response = await h.run();
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ retryable: true, error: expect.stringContaining('record') });
        expect(h.execs).toEqual([]);
        // The only other row is the honest terminal one: never started.
        expect(h.rows.map((r) => r.outcome)).toEqual(['running', 'not_started']);
        await h.server.close();
    });

    it('refuses the same when the running write throws', async () => {
        const h = await harness({
            write: () => {
                throw new Error('connection reset');
            },
        });
        expect((await h.run()).status).toBe(503);
        expect(h.execs).toEqual([]);
        await h.server.close();
    });
});

describe('the supervised gate manager: probes inside the queue', () => {
    it('probes a run only when its own turn comes: the next run never reads the previous run’s tree', async () => {
        const events: string[] = [];
        let release: (r: StepResult) => void = () => {};
        const runner = {
            runGate: async (_job: BoardJob, gate: GateStepRequest): Promise<StepResult> => {
                events.push(`exec:${gate.command}`);
                return gate.command === 'one' ? new Promise<StepResult>((r) => (release = r)) : answered(0);
            },
        };
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        const execution = (id: string) => ({
            executionId: id,
            probe: async (_signal: AbortSignal, since?: number) => {
                events.push(`${since === undefined ? 'before' : 'after'}:${id}`);
                return BEFORE;
            },
            start: async (info: GateRunStart) => {
                events.push(`start:${info.executionId}`);
                return true;
            },
        });
        const a = manager.runGate(KEY, 'g', 'one', { execution: execution('a') });
        const b = manager.runGate(KEY, 'g', 'two', { execution: execution('b') });
        await until(() => events.includes('exec:one'));
        expect(events).toEqual(['before:a', 'start:a', 'exec:one']);
        release(answered(0));
        await Promise.all([a, b]);
        expect(events).toEqual([
            'before:a',
            'start:a',
            'exec:one',
            'after:a',
            'before:b',
            'start:b',
            'exec:two',
            'after:b',
        ]);
        expect((await a).measure).toMatchObject({ treeBefore: 'h:before', treeAfter: 'h:before', mutatedSince: null });
    });

    it('answers no measure for a run given no execution: the plain verdict stays as it was', async () => {
        const runner = { runGate: async (): Promise<StepResult> => answered(0) };
        const manager = createSupervisedGateManager({ config, runner });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        expect(await manager.runGate(KEY, 'g', 'one')).toEqual({ exitCode: 0, output: '' });
    });
});

describe('the gate server: closing ad-hoc admission before the completion pass reads the record', () => {
    it('waits for a run still awaiting its before-probe, and its terminal row lands before the wait ends', async () => {
        let release: (() => void) | undefined;
        let probes = 0;
        const h = await harness({
            answer: () => answered(1),
            probe: async () => {
                probes += 1;
                if (probes === 1) await new Promise<void>((resolve) => (release = resolve));
                return BEFORE;
            },
        });
        const call = h.run();
        await until(() => release !== undefined);

        let quiet = false;
        const quiesced = h.server.quiesce('tok').then(() => {
            quiet = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(quiet).toBe(false);

        release?.();
        await quiesced;
        expect(h.rows.map((r) => r.outcome)).toEqual(['running', 'failed']);
        await call;
        await h.server.close();
    });

    it('refuses a call that arrives after it, retryable, writing no row and starting no gate', async () => {
        const h = await harness();
        await h.server.quiesce('tok');
        const response = await h.run();

        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ retryable: true });
        expect(h.rows).toEqual([]);
        expect(h.execs).toEqual([]);
        await h.server.close();
    });

    it('opens again when the token is registered anew: a later attempt of the same claim', async () => {
        const h = await harness();
        await h.server.quiesce('tok');
        h.server.register('tok', {
            key: KEY,
            image: 'node:24',
            job: JOB,
            gates: [{ name: 'test', command: 'npm test' }],
        });
        expect((await h.run()).status).toBe(200);
        await h.server.close();
    });
});
