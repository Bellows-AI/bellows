import { afterEach, describe, expect, it, vi } from 'vitest';
import { beforeDeadline, createStopRegistry } from '../src/shutdown.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('stop registry', () => {
    it('awaits every stop, and one that throws never skips the rest', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const stops = createStopRegistry();
        const order: string[] = [];
        stops.add(() => async () => {
            throw new Error('first');
        });
        stops.add(() => async () => {
            await Promise.resolve();
            order.push('second');
        });
        await stops.stopAll();
        expect(order).toEqual(['second']);
    });

    it('refuses a start once the close began, before stopAll runs', () => {
        const stops = createStopRegistry();
        stops.refuseStarts();
        const start = vi.fn(() => async () => {});
        stops.add(start);
        expect(start).not.toHaveBeenCalled();
    });

    it('never starts a loop whose start comes after stopAll began', async () => {
        const stops = createStopRegistry();
        await stops.stopAll();
        const start = vi.fn(() => async () => {});
        stops.add(start);
        expect(start).not.toHaveBeenCalled();
    });
});

describe('beforeDeadline', () => {
    it('rejects naming the step once the absolute deadline passes', async () => {
        vi.useFakeTimers();
        const outcome = expect(
            beforeDeadline(new Promise<void>(() => {}), Date.now() + 1000, 'a step')
        ).rejects.toThrow('a step did not finish before the shutdown deadline');
        await vi.advanceTimersByTimeAsync(1001);
        await outcome;
    });

    it('passes the work through when it finishes in time', async () => {
        await expect(beforeDeadline(Promise.resolve(7), Date.now() + 1000, 'a step')).resolves.toBe(7);
    });
});
