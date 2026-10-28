import { describe, expect, it } from 'vitest';
import { type Call, attempt, classify, newCall } from '../src/secrets/secret-call.js';
import { type FaultVerdict, ProviderFault } from '../src/secrets/secret-payloads.js';

/** How the store treats a payload store's `ProviderFault` (docs/secrets.md); no database involved. */

const DEADLINE_MS = 250;

function counting(verdict: FaultVerdict) {
    const state = { tries: 0 };
    const run = async () => {
        state.tries += 1;
        throw new ProviderFault(verdict);
    };
    return { state, run };
}

const callOf = (): Call => newCall(undefined, DEADLINE_MS);

describe('provider faults', () => {
    it('classify maps each closed verdict and never rethrows one', () => {
        expect(classify(new ProviderFault('retry'))).toBe('retry');
        expect(classify(new ProviderFault('ambiguous'))).toBe('ambiguous');
        expect(classify(new ProviderFault('definitive'))).toBe('definitive');
        expect(classify(new ProviderFault('misconfigured'))).toBe('misconfigured');
    });

    it('a misconfigured provider fault is one try and invalid-configuration', async () => {
        for (const mode of ['read', 'idempotent', 'write', 'once'] as const) {
            const { state, run } = counting('misconfigured');
            expect(await attempt(callOf(), run, mode)).toEqual({ kind: 'misconfigured' });
            expect(state.tries).toBe(1);
        }
    });

    it('a retryable provider fault backs off until the absolute deadline, then unavailable', async () => {
        const { state, run } = counting('retry');
        const started = Date.now();
        expect(await attempt(callOf(), run, 'write')).toEqual({ kind: 'unavailable' });
        expect(state.tries).toBeGreaterThan(2);
        expect(Date.now() - started).toBeLessThan(DEADLINE_MS + 250);
    });

    it('a definitive provider fault is one try and unavailable', async () => {
        const { state, run } = counting('definitive');
        expect(await attempt(callOf(), run, 'read')).toEqual({ kind: 'unavailable' });
        expect(state.tries).toBe(1);
    });

    it('an ambiguous provider fault stops a write and retries a read', async () => {
        const write = counting('ambiguous');
        expect(await attempt(callOf(), write.run, 'write')).toEqual({ kind: 'ambiguous' });
        expect(write.state.tries).toBe(1);

        const read = counting('ambiguous');
        expect(await attempt(callOf(), read.run, 'read')).toEqual({ kind: 'unavailable' });
        expect(read.state.tries).toBeGreaterThan(2);
    });

    it('a provider fault never carries its message into the result', async () => {
        const failing = async () => {
            throw new ProviderFault('retry');
        };
        const result = await attempt(newCall(undefined, 60), failing, 'once');
        expect(JSON.stringify(result)).not.toContain('provider fault');
    });
});
