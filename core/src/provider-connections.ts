import type { ModelProvider } from './model-providers.js';

/**
 * Provider connections (docs/api.md): a model-provider credential as a first-class, named row an
 * executor profile can reference. This file is the shared contract — safe metadata, the per-scope
 * cap and the discovery answer — that the routes, the store and the later slices read.
 */

/** Whose rows a list answers: the organization's (`org`) or the member's own (`personal`). */
export type ProviderConnectionScope = 'org' | 'personal';

/**
 * Safe metadata: never a credential and never a secret reference. The base URL is a plain column
 * (the same rule as the env base URL today), so it travels; the key never does.
 */
export interface ProviderConnectionMeta {
    readonly id: string;
    readonly name: string;
    readonly provider: ModelProvider;
    readonly scope: ProviderConnectionScope;
    /** The plain endpoint the connection reaches, or null when the provider needs none. */
    readonly baseUrl: string | null;
    /** Whether a key is sealed for the connection; the key itself never travels. */
    readonly hasKey: boolean;
}

/** A bound on one scope's list (a ceiling, not a policy), enforced by the store under the write. */
export const MAX_PROVIDER_CONNECTIONS_PER_SCOPE = 20;

/**
 * What model discovery on a stored connection answers: a provider catalog (`listed`, possibly
 * empty), a provider with no catalog to list (`unsupported`, carrying the credit read OpenRouter's
 * verification yields), or a failed check (`failed` — an upstream or credential outcome, never an
 * authoritative empty list; a board-side outage is a thrown 503, not a state).
 */
export type ProviderConnectionModels =
    | { readonly state: 'listed'; readonly models: readonly string[] }
    | {
          readonly state: 'unsupported';
          readonly creditUsd?: number;
          readonly budget?: { readonly limitUsd: number; readonly usedUsd: number };
      }
    | { readonly state: 'failed'; readonly code: string; readonly message: string };
