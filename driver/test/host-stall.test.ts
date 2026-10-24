/**
 * The stall clock behind the takeover simulation (#972): loop time leaves out the stretches the host held the process,
 * and never runs backwards.
 */
import { describe, expect, it } from 'vitest';
import { busyWait, loopTime, STALL_MIN_MS, STALL_TICK_MS, StallWatch } from './fixtures/host-stall.js';

describe('loopTime', () => {
    it('is the wall clock when the loop turns', () => {
        expect(loopTime(10_000, 0, 10_000 - STALL_TICK_MS)).toBe(10_000);
    });

    it('leaves out the stalls the watcher recorded', () => {
        expect(loopTime(10_000, 500, 10_000 - STALL_TICK_MS)).toBe(9_500);
    });

    it('leaves out a stall the watcher has not recorded yet: its overdue tick has not run', () => {
        expect(loopTime(10_000, 0, 10_000 - STALL_TICK_MS - 400)).toBe(9_600);
    });

    it('counts a lag under the stall threshold as scheduling noise', () => {
        expect(loopTime(10_000, 0, 10_000 - STALL_TICK_MS - (STALL_MIN_MS - 1))).toBe(10_000);
    });

    it('gives the same time before and after the watcher records the stall', () => {
        const before = loopTime(10_000, 0, 10_000 - STALL_TICK_MS - 400);
        const after = loopTime(10_000, 400, 10_000);
        expect(after).toBe(before);
    });
});

describe('StallWatch', () => {
    it('stands still through a busy wait, before and after its own tick records it', async () => {
        const watch = new StallWatch();
        try {
            await new Promise((resolve) => setTimeout(resolve, 2 * STALL_TICK_MS));
            const start = watch.loopNow();
            busyWait(400);
            // No timer has run: the overdue tick is pending, and the stall is already out of the clock.
            const during = watch.loopNow() - start;
            expect(during, 'loop time advanced through the stall').toBeLessThan(100);
            await new Promise((resolve) => setTimeout(resolve, 2 * STALL_TICK_MS));
            const after = watch.loopNow() - start;
            expect(after, 'loop time advanced through the stall once recorded').toBeLessThan(250);
            expect(watch.stalls.reduce((sum, s) => sum + s.ms, 0)).toBeGreaterThanOrEqual(350);
        } finally {
            watch.stop();
        }
    });

    it('never runs backwards across the stall threshold', async () => {
        const watch = new StallWatch();
        try {
            let last = watch.loopNow();
            for (let i = 0; i < 40; i++) {
                busyWait(i % 2 ? 5 : 35);
                const now = watch.loopNow();
                expect(now).toBeGreaterThanOrEqual(last);
                last = now;
                await new Promise((resolve) => setTimeout(resolve, 1));
            }
        } finally {
            watch.stop();
        }
    });
});
