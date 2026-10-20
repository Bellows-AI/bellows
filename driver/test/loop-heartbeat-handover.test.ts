import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { applyHeartbeatVerdict, newJobState } from '../src/loop-attempt.js';
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
