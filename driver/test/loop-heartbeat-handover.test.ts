import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { applyHeartbeatVerdict, newJobState } from '../src/loop-attempt.js';
import { abandonOnHandover } from '../src/loop-conclusion.js';
import { recordEnding } from '../src/loop-phase.js';
import type { LoopRuntime } from '../src/loop-types.js';

const JOB = { id: 'job-1' } as BoardJob;

describe('a heartbeat verdict never kills a runner a handover retained (issue #828)', () => {
    it('does not kill when a handover lands while the heartbeat awaits answer delivery', async () => {
        const state = newJobState();
        state.launched = true;
        state.control = 'control-token';
        state.pendingQuestions.add('q1');
        let release: () => void = () => {};
        const paused = new Promise<void>((resolve) => {
            release = resolve;
        });
        const kills: string[] = [];
        const rt = {
            log: () => {},
            runner: {
                pauseDeadline: () => paused,
                kill: async () => {
                    kills.push('kill');
                },
                stopAgent: async () => {
                    kills.push('stopAgent');
                },
            },
        } as unknown as LoopRuntime;

        const applying = applyHeartbeatVerdict(rt, JOB, state, {
            cancelRequested: false,
            answeredQuestions: [],
        } as never);
        recordEnding(state, 'handover');
        release();
        await applying;

        expect(kills).toEqual([]);
    });
});

describe('a lost lease past the launch leaves the runner to the next claim (issue #829)', () => {
    /** An attempt and the runner calls a verdict makes on it. */
    function attempt(launched: boolean) {
        const state = newJobState();
        state.launched = launched;
        state.control = 'control-token';
        const calls: string[] = [];
        const logs: string[] = [];
        const rt = {
            log: (line: string) => logs.push(line),
            runner: {
                kill: async () => void calls.push('kill'),
                stopAgent: async () => void calls.push('stopAgent'),
                pauseDeadline: async () => {},
            },
            gates: {
                server: { closeControl: () => calls.push('closeControl'), raiseKill: () => calls.push('raiseKill') },
            },
        } as unknown as LoopRuntime;
        return { state, calls, logs, rt };
    }
    const apply = (rt: LoopRuntime, state: ReturnType<typeof newJobState>, verdict: 'lost' | 'removed') =>
        applyHeartbeatVerdict(rt, JOB, state, verdict as never);

    it('neither kills the agent nor closes the control token, and abandons the run for the handover', async () => {
        const { state, calls, logs, rt } = attempt(true);
        let abandoned = false;
        void state.handedOver.then(() => (abandoned = true));

        await apply(rt, state, 'lost');
        await Promise.resolve();

        expect(calls).toEqual([]);
        expect(state.ending?.kind).toBe('lost');
        expect(abandoned).toBe(true);
        expect(logs.join('\n')).toContain('lease lost past the launch, leaving the runner to the next claim');
    });

    // Characterization: before the launch there is no agent to leave, and the best-effort kill stays.
    it('still kills a runner when the lease is lost before the launch', async () => {
        const { state, calls, rt } = attempt(false);

        await apply(rt, state, 'lost');

        expect(calls).toEqual(['kill']);
    });

    // Characterization: a removed task is no one's to take over.
    it('still kills the agent of a task removed past the launch', async () => {
        const { state, calls, rt } = attempt(true);

        await apply(rt, state, 'removed');

        expect(calls).toContain('stopAgent');
    });
});

describe('an abandoned run is told to end its in-process timers (#829)', () => {
    it('abandons the runner once a handover lands, and not before', async () => {
        const state = newJobState();
        const abandoned = vi.fn();
        const outcome = abandonOnHandover(state, new Promise<string>(() => undefined), abandoned);
        await Promise.resolve();
        expect(abandoned).not.toHaveBeenCalled();

        state.signalHandover();

        await expect(outcome).resolves.toBeNull();
        expect(abandoned).toHaveBeenCalledTimes(1);
    });

    it('leaves a run that ended by itself alone', async () => {
        const abandoned = vi.fn();

        await expect(abandonOnHandover(newJobState(), Promise.resolve('done'), abandoned)).resolves.toBe('done');
        expect(abandoned).not.toHaveBeenCalled();
    });
});
