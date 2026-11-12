import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOutcome } from '../src/runner.js';
import { createDrain } from '../src/drain.js';
import { createLoop } from '../src/loop/loop.js';
import { config, job, ok, stubBoard, stubRunner } from './fixtures/loop-stubs.js';

// Never zero: a zero-delay timer that re-arms itself holds fake time still.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(ms, 1)));

const JOBS = 20;
const SPOT_KILL_MS = 90_000;

/** A driver with `JOBS` runs in flight whose runner never answers; the drain is the one `index.ts` wires. */
async function drivingInFlight(env: NodeJS.ProcessEnv = {}) {
    const claimed = Array.from({ length: JOBS }, (_, i) => job(i + 1));
    const board = stubBoard(claimed);
    let running = 0;
    let allRunning: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
        allRunning = resolve;
    });
    const runner = stubRunner(async () => {
        if (++running === JOBS) allRunning();
        return new Promise<RunOutcome>(() => {});
    });
    const logs: string[] = [];
    const cfg = { ...config({ DRIVER_CONCURRENCY: String(JOBS), ...env }) };
    const loop = createLoop({ board: board.board, runner, config: cfg, sleep, log: (m) => logs.push(m) });
    board.attach(loop);
    let startReturned = false;
    const started = loop.start().then(() => {
        startReturned = true;
    });
    const exits: number[] = [];
    const drain = createDrain({
        loop,
        reaper: { stop: () => {} },
        handoverMs: cfg.handoverMs,
        log: (m) => logs.push(m),
        exit: (code) => exits.push(code),
    });
    return { board, runner, logs, drain, started, exits, inFlight, startReturned: () => startReturned, claimed };
}

describe('the driver drain on SIGTERM', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('has handed every one of 20 running jobs over when the node dies 90 s after SIGTERM', async () => {
        const d = await drivingInFlight();
        await vi.advanceTimersByTimeAsync(2_000);
        await d.inFlight;

        d.drain.onSignal();
        await vi.advanceTimersByTimeAsync(SPOT_KILL_MS);
        // The SIGKILL lands here: whatever is not on the board by now waits out its lease.
        const released = [...d.board.board.interrupted];

        expect(released).toHaveLength(JOBS);
        expect(new Set(released.map((r) => r.id))).toEqual(new Set(d.claimed.map((j) => j.id)));
        for (const r of released) {
            expect(r).toMatchObject({ reason: 'the driver was drained', release: true, nodeLoss: true });
        }
        expect(d.runner.killed).toEqual([]);
        expect(d.runner.finished).toEqual([]);
        expect(d.board.board.completed).toEqual([]);
        expect(d.board.board.suspended).toEqual([]);
        await d.started;
    });

    it('logs how long the handover took', async () => {
        const d = await drivingInFlight();
        await vi.advanceTimersByTimeAsync(2_000);
        await d.inFlight;

        d.drain.onSignal();
        await vi.advanceTimersByTimeAsync(SPOT_KILL_MS);

        expect(d.logs.filter((m) => /handover: 20 attempt\(s\) settled in \d+ ms/.test(m))).toHaveLength(1);
    });

    it('waits DRIVER_HANDOVER_MS before handing over when it is positive', async () => {
        const d = await drivingInFlight({ DRIVER_HANDOVER_MS: '5000' });
        await vi.advanceTimersByTimeAsync(2_000);
        await d.inFlight;

        d.drain.onSignal();
        await vi.advanceTimersByTimeAsync(4_999);
        expect(d.board.board.interrupted).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(d.board.board.interrupted).toHaveLength(JOBS);
    });

    it('exits at once on a second signal', async () => {
        const d = await drivingInFlight();
        await vi.advanceTimersByTimeAsync(2_000);
        d.drain.onSignal();
        d.drain.onSignal();
        expect(d.exits).toEqual([1]);
    });

    it('hands over a claim answered after SIGTERM, and start() waits for its interruption', async () => {
        const claimed = job(1);
        const board = stubBoard([claimed]);
        let answerClaim: (j: typeof claimed | null) => void = () => {};
        const claimAsked = new Promise<void>((resolve) => {
            board.board.claim = () =>
                new Promise((answer) => {
                    answerClaim = answer;
                    resolve();
                });
        });
        let answerInterrupt: () => void = () => {};
        const interruptAsked = new Promise<void>((resolve) => {
            board.board.interrupt = (_job, interruption) =>
                new Promise((answer) => {
                    board.board.interrupted.push({ id: claimed.id, ...interruption });
                    answerInterrupt = () => answer('held');
                    resolve();
                });
        });
        const runner = stubRunner(async () => new Promise<RunOutcome>(() => {}));
        const loop = createLoop({ board: board.board, runner, config: config(), sleep });
        board.attach(loop);
        let startReturned = false;
        const started = loop.start().then(() => {
            startReturned = true;
        });
        const drain = createDrain({
            loop,
            reaper: { stop: () => {} },
            handoverMs: 0,
            log: () => {},
            exit: () => {},
        });

        await vi.advanceTimersByTimeAsync(10);
        await claimAsked;
        drain.onSignal();
        await vi.advanceTimersByTimeAsync(0);
        answerClaim(claimed);
        await vi.advanceTimersByTimeAsync(10);
        await interruptAsked;
        await vi.advanceTimersByTimeAsync(0);
        expect(board.board.interrupted).toEqual([
            { id: claimed.id, reason: 'the driver was drained', release: true, nodeLoss: true },
        ]);
        expect(startReturned).toBe(false);
        answerInterrupt();
        await vi.advanceTimersByTimeAsync(10_000);
        await started;
        expect(startReturned).toBe(true);
    });

    it('does not let start() return under a verdict already in flight when SIGTERM lands', async () => {
        const claimed = job(1);
        const board = stubBoard([claimed]);
        let answerComplete: () => void = () => {};
        const completeAsked = new Promise<void>((resolve) => {
            const complete = board.board.complete.bind(board.board);
            board.board.complete = (...args) =>
                new Promise((answer) => {
                    resolve();
                    answerComplete = () => void complete(...args).then(answer);
                });
        });
        const runner = stubRunner(async () => ok());
        const loop = createLoop({ board: board.board, runner, config: config(), sleep });
        board.attach(loop);
        let startReturned = false;
        const started = loop.start().then(() => {
            startReturned = true;
        });
        const drain = createDrain({ loop, reaper: { stop: () => {} }, handoverMs: 0, log: () => {}, exit: () => {} });

        await vi.advanceTimersByTimeAsync(10);
        await completeAsked;
        drain.onSignal();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(startReturned).toBe(false);
        answerComplete();
        await vi.advanceTimersByTimeAsync(10_000);
        await started;
        expect(startReturned).toBe(true);
    });
});
