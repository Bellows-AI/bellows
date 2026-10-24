import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { down, heartbeat, newJobState } from '../src/loop/loop-attempt.js';
import { lostOf, recordEnding, transition } from '../src/loop/loop-phase.js';
import type { AttemptTransition } from '../src/loop/loop-phase.js';
import type { LoopRuntime } from '../src/loop/loop-types.js';
import { config, drive, job, ok, sleep, stubBoard, stubRunner } from './fixtures/loop-stubs.js';

/**
 * The attempt's one phase and one first-wins ending (issue #828): the setters' contract, the
 * structured line each change writes, and the heartbeat reading the phase, not the ending.
 */

function traced() {
    const state = newJobState();
    const lines: AttemptTransition[] = [];
    state.trace = (t) => lines.push(t);
    return { state, lines };
}

/** The path an attempt took, rebuilt from its lines alone: each phase change, each ending. */
const rebuilt = (lines: { from: string; to: string; ending: string | null }[]) =>
    lines.map((l) => (l.from === l.to ? `ending:${l.ending}` : `${l.from}>${l.to}`));

describe('recordEnding', () => {
    it('the first ending wins; a later one records nothing and does not move the first', () => {
        const { state, lines } = traced();
        expect(down(state)).toBe(false);
        expect(recordEnding(state, 'lost')).toBe(true);
        expect(recordEnding(state, 'stop')).toBe(false);
        expect(recordEnding(state, 'removed')).toBe(false);
        expect(state.ending?.kind).toBe('lost');
        expect(down(state)).toBe(true);
        expect(lines).toHaveLength(1);
    });

    it('reads a handover as a lost lease, and a stop or a removal as not', () => {
        for (const [kind, lost] of [
            ['handover', true],
            ['lost', true],
            ['stop', false],
            ['removed', false],
        ] as const) {
            const { state } = traced();
            recordEnding(state, kind);
            expect(lostOf(state)).toBe(lost);
        }
    });
});

describe('transition', () => {
    it('moves forward only, and a repeat or a step back is a no-op', () => {
        const { state, lines } = traced();
        expect(transition(state, 'launched')).toBe(true);
        expect(transition(state, 'launched')).toBe(false);
        expect(transition(state, 'setup')).toBe(false);
        expect(transition(state, 'ended')).toBe(true);
        expect(transition(state, 'concluding')).toBe(false);
        expect(state.phase).toBe('ended');
        expect(lines.map((l) => `${l.from}>${l.to}`)).toEqual(['setup>launched', 'launched>ended']);
    });

    it('writes one line per change, carrying the ending that stood when it moved', () => {
        const { state, lines } = traced();
        transition(state, 'launched');
        recordEnding(state, 'stop');
        transition(state, 'concluding');
        expect(lines).toMatchObject([
            { from: 'setup', to: 'launched', ending: null },
            { from: 'launched', to: 'launched', ending: 'stop' },
            { from: 'launched', to: 'concluding', ending: 'stop' },
        ]);
        expect(rebuilt(lines)).toEqual(['setup>launched', 'ending:stop', 'launched>concluding']);
    });
});

describe('the attempt-transition line', () => {
    it('is one structured line in the loop log per change, and rebuilds the attempt path alone', async () => {
        const logs: string[] = [];
        const claimed = job(1);
        const board = stubBoard([claimed]);
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, log: (m) => logs.push(m) });

        const lines = logs.flatMap((m) => {
            try {
                const parsed = JSON.parse(m) as { event?: string };
                return parsed.event === 'attempt-transition'
                    ? [parsed as never as AttemptTransition & { job: string; claimSeq: number }]
                    : [];
            } catch {
                return [];
            }
        });
        expect(lines.length).toBeGreaterThan(0);
        for (const l of lines) {
            expect(l).toEqual({
                event: 'attempt-transition',
                job: claimed.id,
                claimSeq: claimed.claimSeq,
                from: expect.any(String),
                to: expect.any(String),
                ending: null,
                at: expect.any(Number),
            });
        }
        expect(rebuilt(lines)).toEqual(['setup>launched', 'launched>concluding', 'concluding>ended']);
    });
});

describe('the heartbeat while the attempt concludes', () => {
    function beating() {
        const { state } = traced();
        let beats = 0;
        const kill = vi.fn(async () => {});
        const stopAgent = vi.fn(async () => {});
        const rt = {
            config: config(),
            sleep,
            log: () => {},
            runner: { kill, stopAgent },
            board: {
                heartbeat: async () => {
                    beats += 1;
                    return { result: 'held', cancelRequested: true };
                },
            },
        } as unknown as LoopRuntime;
        return { state, rt, kill, stopAgent, beats: () => beats };
    }
    const claimed = job(1) as BoardJob;

    it('keeps renewing until the quiesce whatever ending was recorded, kills nothing, and ends with it', async () => {
        const { state, rt, kill, stopAgent, beats } = beating();
        transition(state, 'launched');
        transition(state, 'concluding');
        recordEnding(state, 'stop');

        const beat = heartbeat(rt, claimed, state);
        while (beats() < 3) await sleep();
        expect(kill).not.toHaveBeenCalled();
        expect(stopAgent).not.toHaveBeenCalled();

        transition(state, 'ended');
        state.wake();
        await beat;
    });

    it('still ends at once for a stop recorded outside the conclusion', async () => {
        const { state, rt, beats } = beating();
        transition(state, 'launched');
        recordEnding(state, 'stop');

        await heartbeat(rt, claimed, state);

        expect(beats()).toBe(0);
    });
});

describe('a heartbeat request the board never answers (issue #926)', () => {
    // The lease outlives a missed beat, not a beat that never ends: the next one must go out inside the lease.
    function hanging(answered: unknown) {
        const state = newJobState();
        transition(state, 'launched');
        const signals: (AbortSignal | undefined)[] = [];
        const logs: string[] = [];
        const rt = {
            config: { ...config(), leaseSeconds: 3 },
            sleep,
            log: (line: string) => logs.push(line),
            runner: { kill: vi.fn(async () => {}), stopAgent: vi.fn(async () => {}) },
            board: {
                heartbeat: (_job: BoardJob, signal?: AbortSignal) => {
                    signals.push(signal);
                    if (signals.length > 1) return Promise.resolve(answered);
                    return new Promise((_resolve, reject) =>
                        signal?.addEventListener('abort', () => reject(new Error('aborted')))
                    );
                },
            },
        } as unknown as LoopRuntime;
        return { state, rt, signals, logs };
    }

    it('is abandoned at a deadline inside the lease and the next beat goes out, killing nothing', async () => {
        const { state, rt, signals, logs } = hanging({ result: 'held', cancelRequested: false });
        const beat = heartbeat(rt, job(1) as BoardJob, state);
        const started = Date.now();
        while (signals.length < 2 && Date.now() - started < 3000) await sleep();

        expect(signals.length).toBeGreaterThanOrEqual(2);
        expect(Date.now() - started).toBeLessThan(3000);
        expect(rt.runner.kill).not.toHaveBeenCalled();
        expect(logs.join('\n')).toContain('heartbeat failed, continuing');
        transition(state, 'ended');
        state.wake();
        await beat;
    });
});
