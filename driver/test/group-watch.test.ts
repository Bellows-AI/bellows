import { describe, expect, it } from 'vitest';
import { watchGroupEnd } from '../src/group-watch.js';

const EVERY_MS = 5;

/** A watch whose probe answers from `script`, one answer per tick, then `false` forever. */
const watched = (script: (boolean | Error)[], over: { current?: () => boolean; signal?: AbortSignal } = {}) => {
    const calls = { probes: 0, releases: 0 };
    const done = watchGroupEnd({
        everyMs: EVERY_MS,
        signal: over.signal,
        isCurrent: over.current ?? (() => true),
        confirmedEnd: async () => {
            const answer = script[calls.probes++] ?? false;
            if (answer instanceof Error) throw answer;
            return answer;
        },
        release: () => {
            calls.releases += 1;
        },
    });
    return { calls, done };
};
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('watchGroupEnd', () => {
    it('releases exactly once, on the first confirmed end, and stops probing', async () => {
        const { calls, done } = watched([false, true, true]);
        await done;
        expect(calls).toEqual({ probes: 2, releases: 1 });
    });

    it('takes a throw or a false as no end and keeps watching', async () => {
        const { calls, done } = watched([new Error('daemon down'), false, new Error('timeout'), true]);
        await done;
        expect(calls).toEqual({ probes: 4, releases: 1 });
    });

    it('does not release for a group that is no longer current, even on a confirmed end', async () => {
        let looks = 0;
        // Current when the tick starts, finished by the time the probe answered.
        const { calls, done } = watched([true], { current: () => ++looks < 2 });
        await done;
        expect(calls).toEqual({ probes: 1, releases: 0 });
    });

    it('ends quietly, with no release, once its signal aborts', async () => {
        const stop = new AbortController();
        const { calls, done } = watched([], { signal: stop.signal });
        await settle(EVERY_MS * 3);
        stop.abort();
        await done;
        const probes = calls.probes;
        await settle(EVERY_MS * 4);
        expect(calls).toEqual({ probes, releases: 0 });
    });
});
