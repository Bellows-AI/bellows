import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { testForks } from '../../vitest.forks.js';

/**
 * How many forks the root vitest config runs: one per core minus one, at most six, unless
 * `TEST_FORKS` names the count. The gates set it, since in a microVM runner six forks reporting to
 * one vitest process starve that process and every worker's RPC times out with every test passed.
 */
describe('testForks', () => {
    it('defaults to one per core minus one, between one and six', () => {
        expect(testForks({}, 8)).toBe(6);
        expect(testForks({}, 25)).toBe(6);
        expect(testForks({}, 4)).toBe(3);
        expect(testForks({}, 1)).toBe(1);
        expect(testForks({ TEST_FORKS: '' }, 8)).toBe(6);
    });

    it('takes TEST_FORKS as the count, above the default cap too', () => {
        expect(testForks({ TEST_FORKS: '3' }, 25)).toBe(3);
        expect(testForks({ TEST_FORKS: '1' }, 8)).toBe(1);
        expect(testForks({ TEST_FORKS: '10' }, 8)).toBe(10);
    });

    it.each(['0', '-1', '2.5', 'three'])('refuses TEST_FORKS=%s', (raw) => {
        expect(() => testForks({ TEST_FORKS: raw }, 8)).toThrow(`TEST_FORKS must be a positive integer, got "${raw}"`);
    });

    it('is what the root config sizes its fork pool with', () => {
        const config = readFileSync(new URL('../../vitest.config.ts', import.meta.url), 'utf8');
        expect(config).toContain('const FORKS = testForks();');
    });
});
