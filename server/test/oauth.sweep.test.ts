import { afterEach, describe, expect, it, vi } from 'vitest';
import { startOAuthSweep } from '../src/auth/oauth-sweep.js';

afterEach(() => vi.useRealTimers());

const store = (purge: () => Promise<{ codes: number; consents: number; families: number }>) => ({
    purgeExpired: vi.fn(purge),
    deleteUnusedClients: vi.fn(async () => 0),
});
const timed = <T>(_loop: string, fn: () => Promise<T>): Promise<T> => fn();

describe('startOAuthSweep', () => {
    it('purges once at start and on every interval, never overlapping, and survives a failure', async () => {
        vi.useFakeTimers();
        let release = (): void => undefined;
        let calls = 0;
        const oauth = store(async () => {
            calls += 1;
            if (calls === 1) throw new Error('database down');
            if (calls === 2) await new Promise<void>((resolve) => (release = resolve));
            return { codes: 0, consents: 0, families: 0 };
        });
        const stop = startOAuthSweep(oauth, timed, 1000);
        await vi.advanceTimersByTimeAsync(0);
        expect(oauth.purgeExpired).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(oauth.purgeExpired).toHaveBeenCalledTimes(2);
        // The second pass is still running: the next tick must not start a third.
        await vi.advanceTimersByTimeAsync(3000);
        expect(oauth.purgeExpired).toHaveBeenCalledTimes(2);
        release();
        await vi.advanceTimersByTimeAsync(1000);
        expect(oauth.purgeExpired).toHaveBeenCalledTimes(3);
        expect(oauth.deleteUnusedClients).toHaveBeenCalled();
        stop();
        await vi.advanceTimersByTimeAsync(5000);
        expect(oauth.purgeExpired).toHaveBeenCalledTimes(3);
    });
});
