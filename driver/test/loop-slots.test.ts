import { describe, expect, it } from 'vitest';
import { createLoop } from '../src/loop/loop.js';
import { config, job, ok, sleep, stubBoard, stubRunner } from './fixtures/loop-stubs.js';

const until = async (condition: () => boolean) => {
    for (let i = 0; i < 500 && !condition(); i++) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    expect(condition()).toBe(true);
};

describe('claim slots', () => {
    it("open slots are the claim loop's room: full and stopped read 0", async () => {
        const { board, attach } = stubBoard([job(1), job(2)], { idleBeforeStop: 1_000_000 });
        const releases: (() => void)[] = [];
        let started = 0;
        const runner = stubRunner(
            () =>
                new Promise((resolve) => {
                    started += 1;
                    releases.push(() => resolve(ok()));
                })
        );
        const loop = createLoop({ board, runner, config: config({ DRIVER_CONCURRENCY: '2' }), sleep });
        attach(loop);
        expect(loop.slots()).toEqual({ busy: 0, open: 2 });
        const finished = loop.start();

        await until(() => started === 2);
        expect(loop.slots()).toEqual({ busy: 2, open: 0 });

        releases[0]!();
        await until(() => loop.slots().busy === 1);
        expect(loop.slots()).toEqual({ busy: 1, open: 1 });

        loop.stop();
        expect(loop.slots().open).toBe(0);
        releases[1]!();
        await finished;
    });
});
