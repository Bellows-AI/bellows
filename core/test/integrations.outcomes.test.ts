import { describe, expect, it } from 'vitest';
import { defineIntegration } from '../src/integrations/definition.js';
import { isClosedOutcome, OUTCOME_REASONS, type IntegrationOutcome } from '../src/integrations/outcomes.js';
import { runOperation } from '../src/integrations/operation.js';
import { redact } from '../src/integrations/redact.js';

describe('integration outcomes', () => {
    it('carry closed reasons only', () => {
        for (const reason of OUTCOME_REASONS.integration_required) {
            const o: IntegrationOutcome = { outcome: 'integration_required', reason, provider: 'p' };
            expect(isClosedOutcome(o)).toBe(true);
        }
        for (const reason of OUTCOME_REASONS.unavailable) {
            expect(isClosedOutcome({ outcome: 'unavailable', reason, retryable: true })).toBe(true);
        }
        for (const reason of OUTCOME_REASONS.forbidden) {
            expect(isClosedOutcome({ outcome: 'forbidden', reason })).toBe(true);
        }
        expect(isClosedOutcome({ outcome: 'rate_limited', retryAfterMs: 5 })).toBe(true);
        expect(isClosedOutcome({ outcome: 'outcome_unknown', operation: 'op' })).toBe(true);
        expect(OUTCOME_REASONS.forbidden).toEqual(
            expect.arrayContaining([
                'binding-ceiling-exceeded',
                'principal-mismatch',
                'service-principal-unsupported',
                'provider-denied',
                'destination-refused',
            ])
        );
    });

    it('refuses a free-text reason, an unknown member or an extra field', () => {
        expect(isClosedOutcome({ outcome: 'forbidden', reason: 'the provider said: token abc' })).toBe(false);
        expect(isClosedOutcome({ outcome: 'unavailable', reason: 'timeout', retryable: true, body: 'x' })).toBe(false);
        expect(isClosedOutcome({ outcome: 'nope' })).toBe(false);
        expect(isClosedOutcome(null)).toBe(false);
    });

    it('redact removes every supplied secret', () => {
        expect(redact('a tok1 b tok2 tok1tok2', ['tok1', 'tok2'])).not.toMatch(/tok/);
        expect(redact('keep tok', ['', 'zzz'])).toBe('keep tok');
        expect(redact('abcd abc', ['abc', 'abcd'])).not.toContain('abc');
    });

    it('an outcome serialized after a provider body echoing the token holds no token', async () => {
        const def = defineIntegration({
            id: 'fake',
            kind: 'connection',
            capabilities: {},
            api: { origin: () => 'https://a.example.test', pathPrefix: '/api' },
            skills: [],
        });
        const token = 'tok-echoed-999';
        const r = await runOperation(
            def,
            { name: 'o', effect: 'read', requiredScopes: [], request: () => ({ method: 'GET', path: '/api/x' }) },
            {
                handle: {
                    connectionId: 'c',
                    provider: 'fake',
                    resource: { id: 'a', label: 'A' },
                    authority: { scopes: [] },
                },
                credentials: {
                    acquire: async () => ({
                        ok: true,
                        credential: { accessToken: token, expiresAt: null, authority: { scopes: [] } },
                    }),
                },
                fetch: async () => ({
                    status: 400,
                    headers: { get: () => null },
                    body: {
                        getReader: () => {
                            const chunks = [new TextEncoder().encode(`{"error":"${token}"}`)];
                            return {
                                read: async () => {
                                    const value = chunks.shift();
                                    return value ? { done: false, value } : { done: true };
                                },
                                cancel: async () => {},
                            };
                        },
                    },
                }),
                deadlineMs: 1000,
            },
            undefined
        );
        expect(r.ok).toBe(false);
        expect(JSON.stringify(r)).not.toContain(token);
    });
});
