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

    it('carries the broker’s typed missing-connection answer, which the runner helper reads', () => {
        expect(ERROR_CODES.INTEGRATION_REQUIRED).toBe('INTEGRATION_REQUIRED');
    });

    it('carries the reused operation key refusal the runner helper branches on', () => {
        expect(ERROR_CODES.OPERATION_KEY_REUSED).toBe('OPERATION_KEY_REUSED');
        expect(ERROR_CODES.OPERATION_CONFLICT).toBe('OPERATION_CONFLICT');
    });

    it('carries the unconfigured-provider refusal the connect button branches on', () => {
        expect(ERROR_CODES.INTEGRATION_NOT_CONFIGURED).toBe('INTEGRATION_NOT_CONFIGURED');
    });

    it('carries the subscription refusals the settings UI will branch on', () => {
        expect(ERROR_CODES.UNKNOWN_CONNECTOR).toBe('UNKNOWN_CONNECTOR');
        expect(ERROR_CODES.BAD_CONNECTOR_CONFIG).toBe('BAD_CONNECTOR_CONFIG');
    });
});
