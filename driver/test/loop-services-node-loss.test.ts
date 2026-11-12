import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { newJobState } from '../src/loop/loop-attempt.js';
import { startServicesStep } from '../src/loop/loop-services.js';
import type { GroupTakenAway } from '../src/runner.js';
import type { AttemptCtx } from '../src/loop/loop-types.js';
import { StartupRefused } from '../src/startup-cause.js';
import { StepChannelClosed, StepTimedOut } from '../src/step-control.js';

function attemptFailingWith(error: unknown, takenAway: GroupTakenAway): AttemptCtx {
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

describe('a services start that fails flags a node loss only on executor evidence', () => {
    it('flags a refused start that carries the executor node-loss evidence', async () => {
        const lost = new StartupRefused('the task pod was evicted', 'transient', undefined, true);

        expect(await startServicesStep(attemptFailingWith(lost, 'kept'))).toMatchObject({
            halt: 'interrupt',
            nodeLoss: true,
        });
    });

    it('does not flag a refused start without that evidence', async () => {
        const refused = new StartupRefused('image pull failed', 'transient');

        const halt = await startServicesStep(attemptFailingWith(refused, 'taken'));

        expect(halt).toMatchObject({ halt: 'interrupt' });
        expect(halt).not.toHaveProperty('nodeLoss');
    });

    it('flags a lost supervisor channel when the executor confirms the group was taken away', async () => {
        const halt = await startServicesStep(attemptFailingWith(new StepChannelClosed('the step answered'), 'taken'));

        expect(halt).toMatchObject({ halt: 'interrupt', nodeLoss: true });
    });

    it('does not flag a lost supervisor channel while the group is still there', async () => {
        const halt = await startServicesStep(attemptFailingWith(new StepChannelClosed('the step answered'), 'kept'));

        expect(halt).toMatchObject({ halt: 'interrupt' });
        expect(halt).not.toHaveProperty('nodeLoss');
    });

    it('holds a lost supervisor channel as blocked when the executor cannot tell', async () => {
        const halt = await startServicesStep(attemptFailingWith(new StepChannelClosed('the step answered'), 'unknown'));

        expect(halt).toMatchObject({ halt: 'interrupt', blocked: true });
        expect(halt).not.toHaveProperty('nodeLoss');
    });

    it.each([
        ['an arbitrary error', () => new Error('the daemon refused')],
        ['a step answered too late', () => new StepTimedOut('step-1')],
    ])('never flags %s', async (_name, make) => {
        const ctx = attemptFailingWith(make(), 'taken');

        const halt = await startServicesStep(ctx);

        expect(halt).toMatchObject({ halt: 'interrupt' });
        expect(halt).not.toHaveProperty('nodeLoss');
    });
});
