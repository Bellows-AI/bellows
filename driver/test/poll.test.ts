import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollFor, timeLeft } from '../src/poll.js';

afterEach(() => vi.useRealTimers());

const instant = async (): Promise<void> => {};

describe('pollFor', () => {
    it('answers the first defined step result', async () => {
        let n = 0;
        const found = await pollFor({ ms: 10_000, everyMs: 100, sleep: instant }, async () => {
            n += 1;
            return n === 3 ? 'ok' : undefined;
        });
        expect(found).toBe('ok');
        expect(n).toBe(3);
    });

    it('stops after ms/everyMs polls when the sleep takes no time', async () => {
        let n = 0;
        const found = await pollFor({ ms: 1_000, everyMs: 100, sleep: instant }, async () => {
            n += 1;
        });
        expect(found).toBeUndefined();
        expect(n).toBe(10);
    });

    it('stops by elapsed time before the poll count when a step is slow', async () => {
        vi.useFakeTimers();
        let n = 0;
        const found = await pollFor({ ms: 1_000, everyMs: 100, sleep: instant }, async () => {
            n += 1;
            vi.setSystemTime(Date.now() + 400);
        });
        expect(found).toBeUndefined();
        expect(n).toBe(3);
    });

    it('reads once even with no budget left, so an undefined answer always follows a read', async () => {
        let n = 0;
        const found = await pollFor({ ms: 0, everyMs: 100, sleep: instant }, async (deadline) => {
            n += 1;
            expect(timeLeft(deadline)).toBe(0);
        });
        expect(found).toBeUndefined();
        expect(n).toBe(1);
    });

    it('throws abandoned() when aborted before a step, with no step call', async () => {
        const controller = new AbortController();
        controller.abort();
        const step = vi.fn(async () => undefined);
        await expect(
            pollFor(
                {
                    ms: 1_000,
                    everyMs: 100,
                    sleep: instant,
                    signal: controller.signal,
                    abandoned: () => new Error('gone'),
                },
                step
            )
        ).rejects.toThrow('gone');
        expect(step).not.toHaveBeenCalled();
    });

    it('throws abandoned() when aborted during the sleep, with no further step call', async () => {
        const controller = new AbortController();
        const step = vi.fn(async () => undefined);
        const sleep = async (_ms: number, signal?: AbortSignal): Promise<void> => {
            controller.abort();
            if (signal?.aborted) throw new Error('aborted sleep');
        };
        await expect(
            pollFor(
                { ms: 1_000, everyMs: 100, sleep, signal: controller.signal, abandoned: () => new Error('gone') },
                step
            )
        ).rejects.toThrow('gone');
        expect(step).toHaveBeenCalledTimes(1);
    });

    it('passes one constant absolute deadline and timeLeft decreases toward it', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const seen: number[] = [];
        const left: number[] = [];
        await pollFor({ ms: 500, everyMs: 100, sleep: instant }, async (deadline) => {
            seen.push(deadline);
            left.push(timeLeft(deadline));
            vi.setSystemTime(Date.now() + 100);
        });
        expect(new Set(seen)).toEqual(new Set([1_000_500]));
        expect(left).toEqual([500, 400, 300, 200, 100]);
        expect(timeLeft(1_000_000)).toBe(0);
    });
});
