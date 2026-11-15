import { describe, expect, it } from 'vitest';
import type { OAuthProviderHooks } from '../src/integrations/oauth-provider.js';
import { combineRegistrations, type ProviderRegistration } from '../src/integrations/provider-registry.js';

/** Offline: the boot-time combine of every provider registration into the lookups the runtime and routes take. */

const hooksOf = (id: string) => ({ id }) as unknown as OAuthProviderHooks;

const registration = (id: string, over: Partial<ProviderRegistration> = {}): ProviderRegistration => ({
    id,
    configured: true,
    hooks: hooksOf(id),
    client: { clientId: `${id}-client`, scopesFor: () => [`${id}:read`] },
    apiBaseOf: (resource) => `https://api.${id}.test/${resource}`,
    notConfigured: `${id} is not configured here`,
    ...over,
});

describe('combineRegistrations', () => {
    it('dispatches hooks, clients, the API base and the refusal sentence by provider id', () => {
        const registry = combineRegistrations([registration('one'), registration('two', { configured: false })]);
        expect(registry.ids).toEqual(['one', 'two']);
        expect(registry.configured).toEqual(['one']);
        expect(registry.providers('one')?.id).toBe('one');
        expect(registry.providers('two')?.id).toBe('two');
        expect(registry.clients('two')?.clientId).toBe('two-client');
        expect(registry.apiBaseOf('one', 'r1')).toBe('https://api.one.test/r1');
        expect(registry.apiBaseOf('two', 'r2')).toBe('https://api.two.test/r2');
        expect(registry.notConfiguredOf('two')).toBe('two is not configured here');
    });

    it('answers undefined or null for an id nothing registered', () => {
        const registry = combineRegistrations([registration('one')]);
        expect(registry.providers('other')).toBeUndefined();
        expect(registry.clients('other')).toBeUndefined();
        expect(registry.apiBaseOf('other', 'r1')).toBeNull();
    });

    it('keeps an unconfigured registration without hooks or client as absent lookups', () => {
        const registry = combineRegistrations([
            registration('one', { configured: false, hooks: undefined, client: undefined }),
        ]);
        expect(registry.providers('one')).toBeUndefined();
        expect(registry.clients('one')).toBeUndefined();
    });

    it('refuses a duplicate provider id at boot', () => {
        expect(() => combineRegistrations([registration('one'), registration('one')])).toThrow(/one/);
    });
});
