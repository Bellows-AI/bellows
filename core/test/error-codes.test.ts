import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../src/error-codes.js';

/** Codes the SPA or a runner branches on are wire contracts, pinned here beside the routes' payload suites. */
describe('ERROR_CODES', () => {
    it('carries the batch launch check’s unknown-executor refusal', () => {
        expect(ERROR_CODES.UNKNOWN_EXECUTOR).toBe('UNKNOWN_EXECUTOR');
    });

    it('carries the runner credential endpoint’s no-App refusal, which the runner helper reads', () => {
        expect(ERROR_CODES.GITHUB_UNAVAILABLE).toBe('GITHUB_UNAVAILABLE');
    });
});
