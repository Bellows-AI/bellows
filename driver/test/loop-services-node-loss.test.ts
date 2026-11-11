import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { newJobState } from '../src/loop/loop-attempt.js';
import { startServicesStep } from '../src/loop/loop-services.js';
import type { AttemptCtx } from '../src/loop/loop-types.js';
import { StartupRefused } from '../src/startup-cause.js';
import { StepChannelClosed, StepTimedOut } from '../src/step-control.js';

function attemptFailingWith(error: unknown, takenAway: boolean): AttemptCtx {
    const state = newJobState();
    state.signal = new AbortController().signal;
    return {
        rt: {
            log: () => {},
            runner: {
                startServices: async () => {
                    throw error;
                },
                groupTakenAway: vi.fn(async () => takenAway),
            },
        },
        job: { id: 'job-1' } as BoardJob,
        state,
    } as unknown as AttemptCtx;
}

describe('a services start that fails flags a node loss only on executor evidence (BEL-302)', () => {
    it('flags a refused start that carries the executor node-loss evidence', async () => {
        const lost = new StartupRefused('the task pod was evicted', 'transient', undefined, true);

        expect(await startServicesStep(attemptFailingWith(lost, false))).toMatchObject({
            halt: 'interrupt',
            nodeLoss: true,
        });
    });

    it('does not flag a refused start without that evidence', async () => {
        const refused = new StartupRefused('image pull failed', 'transient');

        const halt = await startServicesStep(attemptFailingWith(refused, true));

        expect(halt).toMatchObject({ halt: 'interrupt' });
        expect(halt).not.toHaveProperty('nodeLoss');
    });

    it('flags a lost supervisor channel when the executor confirms the group was taken away', async () => {
        const halt = await startServicesStep(attemptFailingWith(new StepChannelClosed('the step answered'), true));

        expect(halt).toMatchObject({ halt: 'interrupt', nodeLoss: true });
    });

    it('does not flag a lost supervisor channel while the group is still there', async () => {
        const halt = await startServicesStep(attemptFailingWith(new StepChannelClosed('the step answered'), false));

        expect(halt).toMatchObject({ halt: 'interrupt' });
        expect(halt).not.toHaveProperty('nodeLoss');
    });

    it.each([
        ['an arbitrary error', () => new Error('the daemon refused')],
        ['a step answered too late', () => new StepTimedOut('step-1')],
    ])('never flags %s', async (_name, make) => {
        const ctx = attemptFailingWith(make(), true);

        const halt = await startServicesStep(ctx);

        expect(halt).toMatchObject({ halt: 'interrupt' });
        expect(halt).not.toHaveProperty('nodeLoss');
    });
});
