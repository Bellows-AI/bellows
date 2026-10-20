import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { newJobState } from '../src/loop-attempt.js';
import { startServicesStep } from '../src/loop-services.js';
import { STOOD_DOWN, type AttemptCtx } from '../src/loop-types.js';

describe('an abandoned services start leaves its release to end() (issue #828)', () => {
    it('does not release when the start settles after the stand-down; end() decides under its retention', async () => {
        const state = newJobState();
        const abort = new AbortController();
        state.signal = abort.signal;
        let finishStart: () => void = () => {};
        const releases: string[] = [];
        const ctx = {
            rt: {
                log: () => {},
                runner: {
                    startServices: () =>
                        new Promise<null>((resolve) => {
                            finishStart = () => resolve(null);
                        }),
                    releaseServices: async () => {
                        releases.push('services');
                    },
                },
            },
            job: { id: 'job-1' } as BoardJob,
            state,
        } as unknown as AttemptCtx;

        const stepping = startServicesStep(ctx);
        abort.abort();
        expect(await stepping).toBe(STOOD_DOWN);
        finishStart();
        await ctx.abandonedServices;
        await new Promise((resolve) => setImmediate(resolve));

        expect(releases).toEqual([]);
        expect(ctx.abandonedServices).toBeDefined();
    });
});
