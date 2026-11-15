import type { AuthorizationClient } from './authorization-types.js';
import type { OAuthProviderHooks, OAuthProviderLookup } from './oauth-provider.js';

/**
 * What one outbound OAuth provider registers at boot (docs/connections.md): its hooks and client when configured,
 * where its API lives for a connected resource, and the sentence a start is refused with when it is not configured.
 */
export interface ProviderRegistration {
    id: string;
    /** True when the provider is configured AND the board has a callback origin, so a start can succeed. */
    configured: boolean;
    hooks?: OAuthProviderHooks | undefined;
    client?: AuthorizationClient | undefined;
    /** The API base the runner helper calls for one connected resource, or null when the provider is unconfigured. */
    apiBaseOf(resource: string): string | null;
    notConfigured: string;
}

/** Every registration, looked up by provider id: what the runtime, the routes and the runner listing take. */
export interface ProviderRegistry {
    ids: readonly string[];
    configured: readonly string[];
    providers: OAuthProviderLookup;
    clients: (provider: string) => AuthorizationClient | undefined;
    apiBaseOf(provider: string, resource: string): string | null;
    notConfiguredOf(provider: string): string;
}

export function combineRegistrations(list: readonly ProviderRegistration[]): ProviderRegistry {
    const byId = new Map<string, ProviderRegistration>();
    for (const registration of list) {
        if (byId.has(registration.id)) throw new Error(`OAuth provider ${registration.id} is registered twice`);
        byId.set(registration.id, registration);
    }
    return {
        ids: list.map((registration) => registration.id),
        configured: list.filter((registration) => registration.configured).map((registration) => registration.id),
        providers: (provider) => byId.get(provider)?.hooks,
        clients: (provider) => byId.get(provider)?.client,
        apiBaseOf: (provider, resource) => byId.get(provider)?.apiBaseOf(resource) ?? null,
        notConfiguredOf: (provider) =>
            byId.get(provider)?.notConfigured ?? `${provider} OAuth is not configured on this deployment`,
    };
}
